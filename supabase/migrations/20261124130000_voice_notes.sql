-- The doctor's voice notes (owner, 23 November 2026: the form also accepts "the doctor's voice notes").
-- The doctor speaks a note, during the call or after it. The live worker writes it down at once and
-- adds the words to the doctor's notes, where they read and change them like anything they typed.
-- The recording is removed as soon as it is read.

create table public.voice_notes (
  id uuid primary key,
  consultation_id uuid not null references public.consultations (id) on delete cascade,
  storage_path text not null unique,
  status text not null default 'waiting' check (status in ('waiting', 'reading', 'done', 'failed')),
  engine_user_id uuid references public.engines (user_id) on delete set null,
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);
create index voice_notes_waiting on public.voice_notes (created_at) where status = 'waiting';
alter table public.voice_notes enable row level security;
revoke all on public.voice_notes from public, anon, authenticated, service_role;
grant select on public.voice_notes to authenticated;
create policy "Practitioners see their voice notes being written down"
  on public.voice_notes for select to authenticated
  using (exists (select 1 from public.consultations c
                 where c.id = voice_notes.consultation_id and c.practitioner_id = (select auth.uid())));

-- Who may touch a voice note's file: the doctor adds it while the form is still open; the engine that
-- claimed it reads and removes it. Nobody else.
create function private.voice_note_access(p_object_name text, p_action text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select case p_action
    when 'add' then exists (
      select 1 from public.consultations c
      where c.practitioner_id = (select auth.uid())
        and c.status not in ('approved', 'corrected', 'archived', 'consent_withdrawn')
        and p_object_name ~ ('^' || c.practitioner_id::text || '/' || c.id::text || '/notes/[0-9a-f-]{36}$'))
    when 'engine' then exists (
      select 1 from public.voice_notes n
      where n.storage_path = p_object_name and n.engine_user_id = (select auth.uid()))
    else false
  end;
$$;
revoke all on function private.voice_note_access(text, text) from public, anon, authenticated, service_role;
grant execute on function private.voice_note_access(text, text) to authenticated;

create policy "Practitioners add voice notes to an open consultation"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'audio' and private.voice_note_access(name, 'add'));
create policy "The engine reads the voice note it claimed"
  on storage.objects for select to authenticated
  using (bucket_id = 'audio' and private.voice_note_access(name, 'engine'));
create policy "The engine removes the voice note it read"
  on storage.objects for delete to authenticated
  using (bucket_id = 'audio' and private.voice_note_access(name, 'engine'));

-- The doctor's browser, after uploading the note. Sent twice, kept once.
create function public.add_voice_note(p_consultation_id uuid, p_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_consultation public.consultations;
begin
  select * into v_consultation from public.consultations
    where id = p_consultation_id and practitioner_id = (select auth.uid());
  if not found then return private.refuse('NOT_FOUND'); end if;
  if p_id is null then return private.refuse('VALIDATION', 'id'); end if;
  if v_consultation.status in ('approved', 'corrected', 'archived', 'consent_withdrawn') then
    return private.reject_transition(p_consultation_id, 'add_voice_note', v_consultation.status);
  end if;
  insert into public.voice_notes (id, consultation_id, storage_path)
    values (p_id, p_consultation_id,
            v_consultation.practitioner_id::text || '/' || p_consultation_id::text || '/notes/' || p_id::text)
    on conflict (id) do nothing;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.add_voice_note(uuid, uuid) from public, anon, service_role;
grant execute on function public.add_voice_note(uuid, uuid) to authenticated;

-- The engine: the oldest note waiting, or one whose engine went quiet. One older than half an hour is
-- set aside unread, and its file is handed back to be removed.
create function public.engine_claim_voice_note() returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_engine uuid := (select auth.uid());
  v_note public.voice_notes;
  v_remove jsonb;
begin
  if not private.is_engine() then return private.refuse('NOT_AN_ENGINE'); end if;
  if not exists (select 1 from public.engines where user_id = v_engine and can_caption) then
    return private.refuse('ENGINE_CAPABILITY_MISSING');
  end if;
  with set_aside as (
    update public.voice_notes set status = 'failed', engine_user_id = v_engine
      where status in ('waiting', 'reading') and created_at < now() - interval '30 minutes'
      returning storage_path)
  select coalesce(jsonb_agg(storage_path), '[]'::jsonb) into v_remove from set_aside;
  select * into v_note from public.voice_notes
    where status = 'waiting' or (status = 'reading' and claimed_at < now() - interval '2 minutes')
    order by created_at limit 1 for update skip locked;
  if not found then return jsonb_build_object('ok', true, 'note', null, 'remove', v_remove); end if;
  update public.voice_notes set status = 'reading', claimed_at = now(), engine_user_id = v_engine
    where id = v_note.id;
  return jsonb_build_object('ok', true, 'remove', v_remove, 'note', jsonb_build_object(
    'id', v_note.id, 'consultation_id', v_note.consultation_id, 'storage_path', v_note.storage_path,
    'language', (select nullif(c.language::text, 'auto') from public.consultations c where c.id = v_note.consultation_id)));
end;
$$;
revoke all on function public.engine_claim_voice_note() from public, anon, service_role;
grant execute on function public.engine_claim_voice_note() to authenticated;

-- The words, added to the doctor's notes as a paragraph of their own. Not once the form is final.
create function public.engine_voice_note_done(p_id uuid, p_text text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_consultation uuid;
  v_text text := left(btrim(coalesce(p_text, '')), 20000);
begin
  if not private.is_engine() then return private.refuse('NOT_AN_ENGINE'); end if;
  update public.voice_notes set status = 'done'
    where id = p_id and engine_user_id = (select auth.uid()) and status = 'reading'
    returning consultation_id into v_consultation;
  if not found then return private.refuse('NOT_FOUND'); end if;
  if v_text <> '' and exists (select 1 from public.consultations where id = v_consultation
                              and status not in ('approved', 'corrected', 'archived', 'consent_withdrawn')) then
    insert into public.doctor_notes (consultation_id, text) values (v_consultation, v_text)
      on conflict (consultation_id) do update
        set text = left(case when btrim(public.doctor_notes.text) = '' then excluded.text
                             else public.doctor_notes.text || E'\n\n' || excluded.text end, 20000),
            updated_at = now();
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.engine_voice_note_done(uuid, text) from public, anon, service_role;
grant execute on function public.engine_voice_note_done(uuid, text) to authenticated;

create function public.engine_voice_note_failed(p_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_engine() then return private.refuse('NOT_AN_ENGINE'); end if;
  update public.voice_notes set status = 'failed'
    where id = p_id and engine_user_id = (select auth.uid()) and status = 'reading';
  if not found then return private.refuse('NOT_FOUND'); end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.engine_voice_note_failed(uuid) from public, anon, service_role;
grant execute on function public.engine_voice_note_failed(uuid) to authenticated;

-- A voice note wakes the live worker, which writes it down at once; and it keeps that worker from
-- stopping while one waits. As on 18 November otherwise.
create or replace function private.live_work_waiting() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.live_pieces p join public.consultations c on c.id = p.consultation_id
                 where p.status = 'waiting' and p.created_at > now() - interval '10 minutes' and c.status = 'ready_for_audio')
      or exists (select 1 from public.voice_notes n
                 where n.status = 'waiting' and n.created_at > now() - interval '30 minutes');
$$;
create trigger wake_engine after insert on public.voice_notes
  for each row when (new.status = 'waiting') execute function private.wake_live_engine_on_work();
