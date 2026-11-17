-- Withdrawing consent stops all of Watson's work on the consultation, and always succeeds while it
-- is allowed (17 November 2026).
--
-- 1. Security review SEC-06 (18 Oct): withdrawal cancelled transcription but not document reading.
--    An engine could still claim a waiting document, read its file and store its text. Now the
--    consultation's documents stop being read, an engine already reading one loses the file and
--    its result (both follow from the document's state), and the text Watson read is forgotten.
--    The files stay: the patient sent them to the practitioner, not to Watson.
-- 2. Since 20261108103553 a typed form can carry attestations and signatures, and refills point at
--    their parent form, all with ON DELETE RESTRICT. Deleting the transcript, which cascades to the
--    forms, then failed, so a patient's withdrawal could not be recorded. They are removed first.
--    Withdrawal is not allowed once a form is approved, so no approved record is touched.

create or replace function public.withdraw_consent(p_consultation_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_consultation public.consultations;
  v_job_id uuid;
  v_track record;
  v_transcript_id uuid;
  v_document_id uuid;
begin
  select * into v_consultation from public.consultations
    where id = p_consultation_id and practitioner_id = v_user for update;
  if not found then
    return private.refuse('NOT_FOUND');
  end if;
  if v_consultation.status not in (
       'consent_pending', 'ready_for_audio', 'audio_imported', 'transcription_processing',
       'transcription_failed', 'transcript_ready', 'transcript_under_review', 'transcript_reviewed',
       'extraction_processing', 'extraction_failed', 'draft_ready', 'under_review') then
    return private.reject_transition(p_consultation_id, 'withdraw_consent', v_consultation.status);
  end if;

  perform private.log_event(p_consultation_id, 'consent.withdrawn', v_user::text, 'practitioner',
    'consultation', p_consultation_id, 'success',
    jsonb_build_object('from_status', v_consultation.status, 'to_status', 'consent_withdrawn'));

  update public.transcription_jobs set status = 'cancelled', finished_at = now()
    where consultation_id = p_consultation_id and status in ('queued', 'processing')
    returning id into v_job_id;
  if v_job_id is not null then
    perform private.log_event(p_consultation_id, 'transcription.cancelled', v_user::text, 'practitioner',
      'transcription_job', v_job_id, 'success', jsonb_build_object('job_id', v_job_id));
  end if;

  -- Documents: no more reading, and what was read is forgotten (SEC-06).
  for v_document_id in
    update public.patient_documents
      set reading = case when reading in ('waiting', 'reading')
                         then 'failed'::public.document_reading else reading end,
          error_category = case when reading in ('waiting', 'reading')
                                then 'CONSENT_WITHDRAWN' else error_category end,
          page_texts = null, engine_user_id = null, claimed_at = null
      where consultation_id = p_consultation_id
        and (reading in ('waiting', 'reading') or page_texts is not null)
      returning id
  loop
    perform private.log_event(p_consultation_id, 'document.reading_withdrawn', v_user::text, 'practitioner',
      'patient_document', v_document_id, 'success');
  end loop;

  -- What points at the forms with ON DELETE RESTRICT goes first; the forms go with the transcript.
  -- Form jobs last: a form is deleted with its job.
  delete from public.form_signatures s using public.forms f
    where s.form_id = f.id and f.consultation_id = p_consultation_id;
  delete from public.form_attestations a using public.forms f
    where a.form_id = f.id and f.consultation_id = p_consultation_id;
  update public.forms set parent_form_id = null
    where consultation_id = p_consultation_id and parent_form_id is not null;
  update public.form_jobs set parent_form_id = null
    where consultation_id = p_consultation_id and parent_form_id is not null;
  delete from public.form_jobs where consultation_id = p_consultation_id;

  for v_transcript_id in
    delete from public.transcripts where consultation_id = p_consultation_id returning id
  loop
    perform private.log_event(p_consultation_id, 'transcript.deleted', v_user::text, 'practitioner',
      'transcript', v_transcript_id, 'success');
  end loop;
  -- The files are deleted by the browser next; confirm_audio_deleted records when they are gone.
  for v_track in
    delete from public.audio_tracks where consultation_id = p_consultation_id returning id, speaker
  loop
    perform private.log_event(p_consultation_id, 'audio.deletion_requested', v_user::text, 'practitioner',
      'audio_track', v_track.id, 'success', jsonb_build_object('speaker', v_track.speaker));
  end loop;

  update public.consultations
    set status = 'consent_withdrawn', consent_withdrawn_at = now(), consent_withdrawn_by = v_user,
        updated_at = now()
    where id = p_consultation_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- An engine never picks up a document of a withdrawn consultation, however it came to wait.
-- Otherwise as in 20261014150000_documents.sql.
create or replace function public.engine_claim_document() returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_engine uuid := (select auth.uid());
  v_document public.patient_documents;
begin
  if not private.is_engine() then
    return private.refuse('NOT_AN_ENGINE');
  end if;
  update public.engines set last_seen_at = now() where user_id = v_engine;

  -- A document left half-read by a computer that went to sleep goes back in line, three times.
  update public.patient_documents
    set reading = case when reading_attempt >= 3 then 'failed'::public.document_reading else 'waiting' end,
        error_category = case when reading_attempt >= 3 then 'ENGINE_STALLED' end,
        engine_user_id = null, claimed_at = null
    where reading = 'reading' and claimed_at < now() - interval '10 minutes';

  update public.patient_documents d
    set reading = 'failed', error_category = 'CONSENT_WITHDRAWN', page_texts = null
    where d.reading = 'waiting'
      and exists (select 1 from public.consultations c
                  where c.id = d.consultation_id and c.status = 'consent_withdrawn');

  select * into v_document from public.patient_documents
    where reading = 'waiting' and uploaded_at is not null
    order by created_at limit 1
    for update skip locked;
  if not found then
    return jsonb_build_object('ok', true, 'document', null);
  end if;
  update public.patient_documents
    set reading = 'reading', reading_attempt = reading_attempt + 1, claimed_at = now(), engine_user_id = v_engine
    where id = v_document.id returning * into v_document;
  return jsonb_build_object('ok', true, 'document', jsonb_build_object(
    'document_id', v_document.id, 'attempt', v_document.reading_attempt,
    'storage_path', v_document.storage_path, 'media_type', v_document.media_type));
end;
$$;
