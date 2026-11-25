-- Watson learns from a doctor's corrections (plan step 4, 25 November 2026): their habits, never facts.
-- The engine reads the doctor's corrections on the forms they approved, derives lessons from them
-- (apps/clinical-worker/src/clinical_worker/lessons.py) and keeps them here, so the doctor sees what
-- Watson learned and can make it forget a lesson. Raw past answers never reach the form model.

create table public.practitioner_lessons (
  practitioner_id uuid not null references auth.users (id) on delete cascade,
  key text not null check (char_length(key) between 1 and 200),
  said text not null check (char_length(said) between 1 and 300),
  seen int not null default 1 check (seen > 0),
  forgotten_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (practitioner_id, key)
);
alter table public.practitioner_lessons enable row level security;
revoke all on public.practitioner_lessons from public, anon, authenticated, service_role;
grant select on public.practitioner_lessons to authenticated;
create policy "Practitioners read what Watson learned from them"
  on public.practitioner_lessons for select to authenticated
  using (practitioner_id = (select auth.uid()));

-- The corrections the lessons come from: in the latest approved version of each of the doctor's last
-- 200 consultations, the answers they rewrote, and per question how often Watson answered and how
-- often they cleared (rejected) Watson's answer. With the words they let stand in those forms (a word
-- they sometimes keep is a fact they corrected, such as "left" for "right", never a habit), and the
-- lessons they asked Watson to forget.
create function private.correction_history(p_practitioner_id uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  with latest as (
    select distinct on (f.consultation_id) f.id, f.consultation_id
    from public.forms f join public.consultations c on c.id = f.consultation_id
    where c.practitioner_id = p_practitioner_id and f.status = 'approved'
    order by f.consultation_id, f.revision_number desc
  ), recent as (
    select l.* from latest l join public.consultations c on c.id = l.consultation_id
    order by c.scheduled_at desc limit 200
  ), answers as (
    select a.*, r.consultation_id from public.form_answers a join recent r on r.id = a.form_id
    where a.machine_text is not null
  )
  select jsonb_build_object(
    'edits', coalesce((select jsonb_agg(jsonb_build_object('key', field_key, 'watson', machine_text,
        'doctor', practitioner_text, 'consultation', consultation_id))
      from answers where review = 'edited' and practitioner_text is not null), '[]'::jsonb),
    'answered', coalesce((select jsonb_object_agg(field_key, n) from
      (select field_key, count(*) n from answers group by field_key) counted), '{}'::jsonb),
    'cleared', coalesce((select jsonb_object_agg(field_key, n) from
      (select field_key, count(*) n from answers where review = 'rejected' group by field_key) counted), '{}'::jsonb),
    'kept', coalesce((select jsonb_agg(distinct w) from public.form_answers a join recent r on r.id = a.form_id,
        regexp_split_to_table(lower(coalesce(a.practitioner_text, a.machine_text)), '[\s.,;:!?()"]+') w
      where a.review <> 'rejected' and w <> ''), '[]'::jsonb),
    'forgotten', coalesce((select jsonb_agg(key) from public.practitioner_lessons
      where practitioner_id = p_practitioner_id and forgotten_at is not null), '[]'::jsonb));
$$;
revoke all on function private.correction_history(uuid) from public, anon, authenticated, service_role;

-- The engine, after a form: the lessons it used, kept for the doctor to see. Lessons that no longer
-- hold go; forgotten ones stay forgotten.
create function public.engine_save_lessons(p_job_id uuid, p_lessons jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_practitioner uuid;
begin
  if not private.is_engine() then return private.refuse('NOT_AN_ENGINE'); end if;
  select c.practitioner_id into v_practitioner from public.form_jobs j join public.consultations c on c.id = j.consultation_id
    where j.id = p_job_id and j.engine_user_id = (select auth.uid());
  if not found then return private.refuse('JOB_NOT_YOURS'); end if;
  if jsonb_typeof(p_lessons) is distinct from 'array' or jsonb_array_length(p_lessons) > 50 then
    return private.refuse('VALIDATION', 'lessons');
  end if;
  begin
    delete from public.practitioner_lessons
      where practitioner_id = v_practitioner and forgotten_at is null
        and key not in (select l ->> 'key' from jsonb_array_elements(p_lessons) l);
    insert into public.practitioner_lessons (practitioner_id, key, said, seen)
      select v_practitioner, l ->> 'key', l ->> 'said', (l ->> 'seen')::int from jsonb_array_elements(p_lessons) l
      on conflict (practitioner_id, key) do update set said = excluded.said, seen = excluded.seen, updated_at = now();
  exception when others then
    return private.refuse('VALIDATION', 'lessons');
  end;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.engine_save_lessons(uuid, jsonb) from public, anon, service_role;
grant execute on function public.engine_save_lessons(uuid, jsonb) to authenticated;

-- The doctor: forget a lesson, or bring it back.
create function public.forget_lesson(p_key text, p_forget boolean) returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if p_forget is null then return private.refuse('VALIDATION', 'forget'); end if;
  update public.practitioner_lessons set forgotten_at = case when p_forget then now() end, updated_at = now()
    where practitioner_id = (select auth.uid()) and key = p_key;
  if not found then return private.refuse('NOT_FOUND'); end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.forget_lesson(text, boolean) from public, anon, service_role;
grant execute on function public.forget_lesson(text, boolean) to authenticated;

-- As on 24 November, and the doctor's correction history goes to the engine with each form.
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
    'history', private.correction_history(v_consultation.practitioner_id),
    'documents', (select coalesce(jsonb_agg(jsonb_build_object(
        'document_id', d.id, 'file_name', d.file_name, 'sent_at', d.uploaded_at,
        'pages', to_jsonb(d.page_texts)) order by d.uploaded_at desc), '[]'::jsonb)
      from (select * from public.patient_documents
            where consultation_id = v_consultation.id and removed_at is null and reading = 'read'
            order by uploaded_at desc limit 10) d)));
end;
$$;
