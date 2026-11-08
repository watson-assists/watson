-- Archiving is a soft delete from any stage. Stop active background work first so an engine cannot
-- move the consultation out of archived after the practitioner has hidden it.
create or replace function public.archive_consultation(p_consultation_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_consultation public.consultations;
  v_transcription_job uuid;
  v_form_job uuid;
begin
  select * into v_consultation
    from public.consultations
    where id = p_consultation_id and practitioner_id = v_user
    for update;
  if not found then
    return private.refuse('NOT_FOUND');
  end if;
  if v_consultation.status = 'archived' then
    return jsonb_build_object('ok', true);
  end if;

  update public.transcription_jobs
    set status = 'cancelled', finished_at = now()
    where consultation_id = p_consultation_id and status in ('queued', 'processing')
    returning id into v_transcription_job;
  if v_transcription_job is not null then
    perform private.log_event(p_consultation_id, 'transcription.cancelled', v_user::text, 'practitioner',
      'transcription_job', v_transcription_job, 'success', jsonb_build_object('job_id', v_transcription_job));
  end if;

  update public.form_jobs
    set status = 'cancelled', finished_at = now()
    where consultation_id = p_consultation_id and status in ('queued', 'processing')
    returning id into v_form_job;
  if v_form_job is not null then
    perform private.log_event(p_consultation_id, 'form.cancelled', v_user::text, 'practitioner',
      'form_job', v_form_job, 'success', jsonb_build_object('job_id', v_form_job));
  end if;

  update public.consultations
    set status = 'archived', updated_at = now()
    where id = p_consultation_id;
  perform private.log_event(p_consultation_id, 'consultation.archived', v_user::text, 'practitioner',
    'consultation', p_consultation_id, 'success',
    jsonb_build_object('from_status', v_consultation.status, 'to_status', 'archived'));
  return jsonb_build_object('ok', true);
end;
$$;
