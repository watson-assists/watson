-- Soft-delete a finished consultation without removing its clinical record or audit history.
create function public.archive_consultation(p_consultation_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_consultation public.consultations;
begin
  select * into v_consultation
    from public.consultations
    where id = p_consultation_id and practitioner_id = v_user
    for update;
  if not found then
    return private.refuse('NOT_FOUND');
  end if;
  if v_consultation.status not in ('transcript_reviewed', 'approved', 'corrected', 'consent_withdrawn') then
    return private.reject_transition(p_consultation_id, 'archive_consultation', v_consultation.status);
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

revoke all on function public.archive_consultation(uuid) from public, anon, authenticated, service_role;
grant execute on function public.archive_consultation(uuid) to authenticated;
