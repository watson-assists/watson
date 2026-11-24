-- The test team's feedback, C2 and D (owner, 23 November 2026).
--
-- 1. The doctor's own notes, written during the call or after it. Watson reads them when it fills in
--    the form, as the doctor's own words. Only the doctor sees them, never the patient.
-- 2. "Fill in the form now": during the call, at a tap, Watson fills in the form from what has been
--    said so far. Its answers are shown beside the call and are never kept as a form: the form is
--    filled from the full transcript once the call ends, as before.
-- 3. A consultation without a recording (the patient said no, or they met in person): the doctor has
--    Watson fill in the form from their notes and the documents, or writes it themselves.

-- 1. The doctor's notes. A table of their own, so no reader of consultations ever sees them.
create table public.doctor_notes (
  consultation_id uuid primary key references public.consultations (id) on delete cascade,
  text text not null default '' check (char_length(text) <= 20000),
  updated_at timestamptz not null default now()
);
alter table public.doctor_notes enable row level security;
revoke all on public.doctor_notes from public, anon, authenticated, service_role;
grant select on public.doctor_notes to authenticated;
create policy "Practitioners read their own notes"
  on public.doctor_notes for select to authenticated
  using (exists (select 1 from public.consultations c
                 where c.id = doctor_notes.consultation_id and c.practitioner_id = (select auth.uid())));

-- Saved as the doctor types, so not logged: the log would hold a line per pause. Final with the form.
create function public.save_doctor_notes(p_consultation_id uuid, p_text text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_status public.consultation_status;
begin
  select status into v_status from public.consultations
    where id = p_consultation_id and practitioner_id = (select auth.uid()) for update;
  if not found then return private.refuse('NOT_FOUND'); end if;
  if p_text is null or char_length(p_text) > 20000 then return private.refuse('VALIDATION', 'text'); end if;
  if v_status in ('approved', 'corrected', 'archived') then
    return private.reject_transition(p_consultation_id, 'save_doctor_notes', v_status);
  end if;
  insert into public.doctor_notes (consultation_id, text) values (p_consultation_id, p_text)
    on conflict (consultation_id) do update set text = excluded.text, updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.save_doctor_notes(uuid, text) from public, anon, service_role;
grant execute on function public.save_doctor_notes(uuid, text) to authenticated;

-- 2. Filling in the form during the call. Such a job has no transcript (the call is still going): the
--    engine reads the live transcript so far, and its answers stay on the job as a preview.
alter table public.form_jobs
  alter column transcript_id drop not null,
  add column preview jsonb,
  drop constraint form_jobs_revision_kind_check,
  add constraint form_jobs_revision_kind_check check (revision_kind in (
    'generated', 'refill', 'historical_conversion', 'correction', 'final_reconciliation', 'during_call'));
-- One fill during the call at a time, and it never holds back the form itself.
drop index public.one_active_form_job_per_consultation;
create unique index one_active_form_job_per_consultation on public.form_jobs (consultation_id)
  where status in ('queued', 'processing') and revision_kind <> 'during_call';
create unique index one_fill_during_the_call on public.form_jobs (consultation_id)
  where status in ('queued', 'processing') and revision_kind = 'during_call';

create function public.fill_form_during_call(p_consultation_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_consultation public.consultations;
  v_job uuid;
begin
  select * into v_consultation from public.consultations
    where id = p_consultation_id and practitioner_id = v_user for update;
  if not found then return private.refuse('NOT_FOUND'); end if;
  if v_consultation.status not in ('consent_pending', 'ready_for_audio') then
    return private.reject_transition(p_consultation_id, 'fill_form_during_call', v_consultation.status);
  end if;
  if v_consultation.form_template_version_id is null then return private.refuse('FORM_TEMPLATE_MISSING'); end if;
  select id into v_job from public.form_jobs where consultation_id = p_consultation_id
    and revision_kind = 'during_call' and status in ('queued', 'processing');
  if found then return jsonb_build_object('ok', true, 'job_id', v_job); end if; -- already on its way
  if not private.has_something_to_fill(p_consultation_id, true) then return private.refuse('NOTHING_TO_FILL'); end if;
  insert into public.form_jobs (consultation_id, transcript_id, form_template_version_id, revision_kind)
    values (p_consultation_id, null, v_consultation.form_template_version_id, 'during_call')
    returning id into v_job;
  perform private.log_event(p_consultation_id, 'form.queued_during_call', v_user::text,
    'practitioner', 'form_job', v_job, 'success');
  return jsonb_build_object('ok', true, 'job_id', v_job);
end;
$$;
revoke all on function public.fill_form_during_call(uuid) from public, anon, service_role;
grant execute on function public.fill_form_during_call(uuid) to authenticated;

-- What Watson can fill a form from without a transcript: the doctor's notes, the documents it has read,
-- and during a call the live transcript so far.
create function private.has_something_to_fill(p_consultation_id uuid, p_live boolean) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.doctor_notes where consultation_id = p_consultation_id and btrim(text) <> '')
    or exists (select 1 from public.patient_documents where consultation_id = p_consultation_id
               and removed_at is null and reading = 'read')
    or (p_live and exists (select 1 from public.live_pieces where consultation_id = p_consultation_id
                           and status = 'done' and coalesce(btrim(text), '') <> ''));
$$;
revoke all on function private.has_something_to_fill(uuid, boolean) from public, anon, authenticated, service_role;

-- The engine's answers to a fill during the call: kept on the job for the call screen, never a form.
create function public.engine_complete_call_fill(
  p_job_id uuid, p_attempt int, p_answers jsonb, p_metrics jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_engine uuid := (select auth.uid());
  v_job public.form_jobs;
begin
  if not private.is_engine() then return private.refuse('NOT_AN_ENGINE'); end if;
  select * into v_job from public.form_jobs
    where id = p_job_id and attempt = p_attempt and status = 'processing' and engine_user_id = v_engine
      and revision_kind = 'during_call' for update;
  if not found then return private.refuse('JOB_NOT_YOURS'); end if;
  if jsonb_typeof(p_answers) is distinct from 'array' then return private.refuse('VALIDATION', 'answers'); end if;
  update public.form_jobs set status = 'completed', finished_at = now(),
    metrics = private.clean_metrics(p_metrics),
    preview = (select coalesce(jsonb_agg(jsonb_build_object('key', a ->> 'key',
                 'text', left(btrim(a ->> 'text'), 2000))), '[]'::jsonb)
               from jsonb_array_elements(p_answers) a
               where jsonb_typeof(a -> 'text') = 'string' and btrim(a ->> 'text') <> ''
                 and exists (select 1 from public.form_template_versions v,
                               jsonb_array_elements(v.definition -> 'sections') s,
                               jsonb_array_elements(s -> 'fields') f
                             where v.id = v_job.form_template_version_id and f ->> 'key' = a ->> 'key'
                               and coalesce(f ->> 'mode', 'extract') <> 'manual'))
    where id = p_job_id;
  perform private.log_event(v_job.consultation_id, 'form.filled_during_call', v_engine::text,
    'engine', 'form_job', p_job_id, 'success');
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.engine_complete_call_fill(uuid, int, jsonb, jsonb) from public, anon, service_role;
grant execute on function public.engine_complete_call_fill(uuid, int, jsonb, jsonb) to authenticated;

-- Whatever an engine sends, a fill during the call never becomes a form (engine_complete_form_job
-- turns this into a refusal of the answers).
create function private.refuse_form_from_call_fill() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.form_jobs where id = new.job_id and revision_kind = 'during_call') then
    raise exception 'A fill during the call is never a form' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function private.refuse_form_from_call_fill() from public, anon, authenticated, service_role;
create trigger refuse_form_from_call_fill before insert on public.forms
  for each row when (new.job_id is not null) execute function private.refuse_form_from_call_fill();

-- As on 14 October, and a fill during the call that fails leaves the consultation where it was.
create or replace function private.fail_form_job(p_job public.form_jobs, p_error_category text, p_actor_id text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.form_jobs set status = 'failed', finished_at = now(), error_category = p_error_category
    where id = p_job.id;
  if p_job.revision_kind = 'during_call' then
    perform private.log_event(p_job.consultation_id, 'form.failed_during_call', p_actor_id, 'engine',
      'form_job', p_job.id, 'failure', jsonb_build_object('job_id', p_job.id, 'error_category', p_error_category));
    return;
  end if;
  update public.consultations set status = 'extraction_failed', updated_at = now()
    where id = p_job.consultation_id;
  perform private.log_event(p_job.consultation_id, 'form.failed', p_actor_id, 'engine',
    'form_job', p_job.id, 'failure',
    jsonb_build_object('job_id', p_job.id, 'attempt', p_job.attempt, 'error_category', p_error_category,
      'from_status', 'extraction_processing', 'to_status', 'extraction_failed'));
end;
$$;

-- 3. A form without a recording: no transcript, and when the doctor writes it, no job either.
alter table public.forms alter column job_id drop not null, alter column transcript_id drop not null;

create function public.start_form_without_recording(p_consultation_id uuid, p_by_watson boolean) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_consultation public.consultations;
  v_id uuid;
  v_to public.consultation_status := case when p_by_watson then 'extraction_processing' else 'draft_ready' end;
begin
  select * into v_consultation from public.consultations
    where id = p_consultation_id and practitioner_id = v_user for update;
  if not found then return private.refuse('NOT_FOUND'); end if;
  if p_by_watson is null then return private.refuse('VALIDATION', 'by_watson'); end if;
  -- A recording, even one saved in part, goes the way of recordings: attached, or discarded first.
  -- Watson's fill from the notes that failed may be tried again, or the doctor writes it after all.
  if not (v_consultation.status in ('consent_pending', 'ready_for_audio')
          or (v_consultation.status = 'extraction_failed' and not exists (
                select 1 from public.transcripts where consultation_id = p_consultation_id)))
     or exists (select 1 from public.audio_tracks where consultation_id = p_consultation_id) then
    return private.reject_transition(p_consultation_id, 'start_form_without_recording', v_consultation.status);
  end if;
  if v_consultation.form_template_version_id is null then return private.refuse('FORM_TEMPLATE_MISSING'); end if;
  if p_by_watson then
    if not private.has_something_to_fill(p_consultation_id, false) then return private.refuse('NOTHING_TO_FILL'); end if;
    insert into public.form_jobs (consultation_id, transcript_id, form_template_version_id, revision_kind)
      values (p_consultation_id, null, v_consultation.form_template_version_id, 'generated')
      returning id into v_id;
  else
    insert into public.forms (consultation_id, job_id, transcript_id, template, form_template_version_id, revision_kind)
      select p_consultation_id, null, null, v.definition, v.id, 'generated'
      from public.form_template_versions v where v.id = v_consultation.form_template_version_id
      returning id into v_id;
    insert into public.form_answers (form_id, field_key, position, value_type)
      select v_id, f.field ->> 'key', f.n - 1, coalesce(f.field ->> 'value_type', 'text')
      from (select field, row_number() over (order by si, fi) as n
            from public.form_template_versions v,
                 jsonb_array_elements(v.definition -> 'sections') with ordinality s(section, si),
                 jsonb_array_elements(s.section -> 'fields') with ordinality x(field, fi)
            where v.id = v_consultation.form_template_version_id) f;
  end if;
  update public.consultations set status = v_to, updated_at = now() where id = p_consultation_id;
  perform private.log_event(p_consultation_id,
    case when p_by_watson then 'form.queued' else 'form.written_by_hand' end, v_user::text,
    'practitioner', case when p_by_watson then 'form_job' else 'form' end, v_id, 'success',
    jsonb_build_object('from_status', v_consultation.status, 'to_status', v_to));
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;
revoke all on function public.start_form_without_recording(uuid, boolean) from public, anon, service_role;
grant execute on function public.start_form_without_recording(uuid, boolean) to authenticated;

-- As on 23 November, and: the doctor's notes go to the engine; a fill during the call reads the live
-- transcript so far; one queued for a call that has ended is set aside, since the form follows.
create or replace function public.engine_claim_form_job() returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_engine uuid := (select auth.uid());
  v_job public.form_jobs;
  v_consultation public.consultations;
begin
  if not private.is_engine() then return private.refuse('NOT_AN_ENGINE'); end if;
  if not exists (
    select 1 from public.engines where user_id = v_engine and can_final_form
  ) then return private.refuse('ENGINE_CAPABILITY_MISSING'); end if;
  update public.engines set last_seen_at = now() where user_id = v_engine;
  update public.form_jobs j set status = 'cancelled', finished_at = now()
    from public.consultations c
    where c.id = j.consultation_id and j.revision_kind = 'during_call' and j.status = 'queued'
      and c.status not in ('consent_pending', 'ready_for_audio');
  for v_job in
    select j.* from public.form_jobs j join public.consultations c on c.id = j.consultation_id
    where j.status = 'processing' and j.heartbeat_at < now() - interval '2 minutes'
    for update of c, j skip locked
  loop
    if v_job.attempt >= 3 then
      perform private.fail_form_job(v_job, 'ENGINE_STALLED', v_engine::text);
    else
      update public.form_jobs set status = 'queued', attempt = attempt + 1,
        claimed_at = null, heartbeat_at = null, engine_user_id = null where id = v_job.id;
    end if;
  end loop;
  select j.* into v_job from public.form_jobs j
    join public.consultations c on c.id = j.consultation_id
    where j.status = 'queued' order by j.queued_at limit 1
    for update of c, j skip locked;
  if not found then return jsonb_build_object('ok', true, 'job', null); end if;
  select * into v_consultation from public.consultations where id = v_job.consultation_id;
  update public.form_jobs set status = 'processing', claimed_at = now(), heartbeat_at = now(),
    engine_user_id = v_engine where id = v_job.id returning * into v_job;
  perform private.log_event(v_job.consultation_id, 'form.started', v_engine::text, 'engine',
    'form_job', v_job.id, 'success', jsonb_build_object('job_id', v_job.id, 'attempt', v_job.attempt));
  return jsonb_build_object('ok', true, 'job', jsonb_build_object(
    'job_id', v_job.id, 'attempt', v_job.attempt,
    'consultation_id', v_consultation.id, 'revision_kind', v_job.revision_kind,
    'language', coalesce(nullif(v_consultation.language::text, 'auto'),
      (select tr.tracks -> 0 ->> 'language' from public.transcripts tr where tr.id = v_job.transcript_id)),
    'template_version_id', v_job.form_template_version_id,
    'template_hash', (select definition_hash from public.form_template_versions
                      where id = v_job.form_template_version_id),
    'template', (select definition from public.form_template_versions
                 where id = v_job.form_template_version_id),
    'lines', case when v_job.revision_kind = 'during_call' then
        (select coalesce(jsonb_agg(jsonb_build_object('position', p.n, 'speaker', p.speaker, 'text', p.text)
                                   order by p.n), '[]'::jsonb)
         from (select row_number() over (order by l.offset_seconds, l.speaker) - 1 as n, l.speaker, l.text
               from public.live_pieces l
               where l.consultation_id = v_consultation.id and l.status = 'done'
                 and coalesce(btrim(l.text), '') <> '') p)
      else
        (select coalesce(jsonb_agg(jsonb_build_object(
            'position', s.position, 'speaker', s.speaker,
            'text', coalesce(s.reviewed_text, s.machine_text)) order by s.position), '[]'::jsonb)
          from public.transcript_segments s
          where s.transcript_id = v_job.transcript_id and not s.possibly_not_speech and s.removed_at is null)
      end,
    'notes', coalesce((select text from public.doctor_notes where consultation_id = v_consultation.id), ''),
    'documents', (select coalesce(jsonb_agg(jsonb_build_object(
        'document_id', d.id, 'file_name', d.file_name, 'sent_at', d.uploaded_at,
        'pages', to_jsonb(d.page_texts)) order by d.uploaded_at desc), '[]'::jsonb)
      from (select * from public.patient_documents
            where consultation_id = v_consultation.id and removed_at is null and reading = 'read'
            order by uploaded_at desc limit 10) d)));
end;
$$;
