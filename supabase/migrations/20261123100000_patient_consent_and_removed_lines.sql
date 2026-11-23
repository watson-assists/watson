-- The test team's feedback, batch B (owner, 23 November 2026).
--
-- 1. The patient answers for themselves, on their link, before they join the call: "I agree" or "Join
--    without recording". A call the patient declined goes ahead and is not recorded: nothing of it is
--    kept, whatever the doctor's browser sends. Agreeing is the patient's consent to recording.
-- 2. The doctor removes parts of the conversation from the full transcript. A removed line is left out
--    of everything Watson reads for the form, can be put back until the form is approved, and its
--    words are erased for good when the form is approved.

-- 1. The patient's own answer.
alter table public.consultations
  add column patient_recording text check (patient_recording in ('agreed', 'declined')),
  add column patient_recording_at timestamptz;

-- The patient answers on their link. They may change their answer until anything is recorded.
create function public.patient_recording_choice(p_token text, p_agree boolean) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_consultation public.consultations;
begin
  select * into v_consultation from public.consultations
    where id = (select id from private.consultation_for_token(p_token)) for update;
  if not found then return private.refuse('NOT_FOUND'); end if;
  if p_agree is null then return private.refuse('VALIDATION', 'agree'); end if;
  if v_consultation.status not in ('consent_pending', 'ready_for_audio') then
    return private.refuse('CALL_CLOSED');
  end if;
  if exists (select 1 from public.audio_tracks where consultation_id = v_consultation.id)
     or exists (select 1 from public.live_pieces where consultation_id = v_consultation.id) then
    return private.refuse('RECORDING_KEPT');
  end if;
  update public.consultations set
    patient_recording = case when p_agree then 'agreed' else 'declined' end,
    patient_recording_at = now(),
    consent_recorded_at = case when p_agree then coalesce(consent_recorded_at, now()) else consent_recorded_at end,
    status = case when p_agree and status = 'consent_pending' then 'ready_for_audio' else status end,
    updated_at = now()
  where id = v_consultation.id;
  perform private.log_event(v_consultation.id,
    case when p_agree then 'consent.patient_agreed' else 'consent.patient_declined' end,
    coalesce((select auth.uid())::text, 'patient-link'), 'patient', 'consultation', v_consultation.id, 'success');
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.patient_recording_choice(text, boolean) from public;
grant execute on function public.patient_recording_choice(text, boolean) to anon, authenticated, service_role;

-- Whatever path a recording takes, one the patient declined is never kept.
create function private.refuse_declined_recording() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.consultations
             where id = new.consultation_id and patient_recording = 'declined') then
    raise exception 'RECORDING_DECLINED: the patient chose not to be recorded' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function private.refuse_declined_recording() from public, anon, authenticated, service_role;
create trigger refuse_declined_recording before insert on public.audio_tracks
  for each row execute function private.refuse_declined_recording();
create trigger refuse_declined_recording before insert on public.live_pieces
  for each row execute function private.refuse_declined_recording();

-- What the patient is asked before joining: who records the call, and their answer so far. Kept apart
-- from invite_details, whose exact contents a privacy test fixes.
create function public.recording_question(p_token text) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object('ok', true,
       'practitioner', (select p.display_name from public.practitioner_profiles p where p.practitioner_id = c.practitioner_id),
       'recording', c.patient_recording)
     from private.consultation_for_token(p_token) c where c.id is not null),
    private.refuse('NOT_FOUND'));
$$;
revoke all on function public.recording_question(text) from public;
grant execute on function public.recording_question(text) to anon, authenticated, service_role;

-- 2. Removing parts of the conversation.
alter table public.transcript_segments add column removed_at timestamptz;

create function public.remove_transcript_line(p_segment_id uuid, p_remove boolean) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_segment public.transcript_segments;
  v_consultation public.consultations;
begin
  select s.* into v_segment from public.transcript_segments s
    join public.transcripts t on t.id = s.transcript_id
    join public.consultations c on c.id = t.consultation_id
    where s.id = p_segment_id and c.practitioner_id = (select auth.uid()) and t.review_status <> 'superseded'
    for update of s;
  if not found then return private.refuse('NOT_FOUND'); end if;
  if p_remove is null then return private.refuse('VALIDATION', 'remove'); end if;
  select c.* into v_consultation from public.consultations c
    join public.transcripts t on t.consultation_id = c.id where t.id = v_segment.transcript_id
    for update of c;
  if v_consultation.status in ('approved', 'corrected', 'archived', 'consent_withdrawn') then
    return private.refuse('INVALID_STATE_TRANSITION');
  end if;
  update public.transcript_segments set removed_at = case when p_remove then now() end
    where id = p_segment_id;
  perform private.log_event(v_consultation.id,
    case when p_remove then 'transcript.line_removed' else 'transcript.line_restored' end,
    (select auth.uid())::text, 'practitioner', 'transcript_segment', p_segment_id, 'success');
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.remove_transcript_line(uuid, boolean) from public, anon, service_role;
grant execute on function public.remove_transcript_line(uuid, boolean) to authenticated;

-- Once the form is approved a removed line cannot come back, so its words are erased.
create function private.erase_removed_lines() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.transcript_segments s set machine_text = '', reviewed_text = null
    from public.transcripts t
    where t.id = s.transcript_id and t.consultation_id = new.id and s.removed_at is not null;
  return null;
end;
$$;
revoke all on function private.erase_removed_lines() from public, anon, authenticated, service_role;
create trigger erase_removed_lines after update of status on public.consultations
  for each row when (new.status = 'approved' and old.status is distinct from 'approved')
  execute function private.erase_removed_lines();

-- As on 8 November, and a removed line is never given to the engine.
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
    'lines', (select coalesce(jsonb_agg(jsonb_build_object(
        'position', s.position, 'speaker', s.speaker,
        'text', coalesce(s.reviewed_text, s.machine_text)) order by s.position), '[]'::jsonb)
      from public.transcript_segments s
      where s.transcript_id = v_job.transcript_id and not s.possibly_not_speech and s.removed_at is null),
    'documents', (select coalesce(jsonb_agg(jsonb_build_object(
        'document_id', d.id, 'file_name', d.file_name, 'sent_at', d.uploaded_at,
        'pages', to_jsonb(d.page_texts)) order by d.uploaded_at desc), '[]'::jsonb)
      from (select * from public.patient_documents
            where consultation_id = v_consultation.id and removed_at is null and reading = 'read'
            order by uploaded_at desc limit 10) d)));
end;
$$;
