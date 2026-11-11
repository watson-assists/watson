-- Atomic consultation creation with an explicitly selected immutable template.
-- The existing create_consultation RPC remains compatible for booking/tests.
create function public.create_consultation_with_template(
  p_scheduled_at timestamptz,
  p_language public.consultation_language,
  p_consent_recorded boolean,
  p_form_template_version_id uuid,
  p_scenario_notes text default '',
  p_fee_cents int default null,
  p_synthetic_patient_ref text default null,
  p_patient_name text default null,
  p_patient_contact text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_consultation public.consultations;
  v_claim jsonb;
  v_name text := btrim(coalesce(p_patient_name, ''));
  v_status public.consultation_status := case when p_consent_recorded
    then 'ready_for_audio'::public.consultation_status
    else 'consent_pending'::public.consultation_status end;
begin
  if v_user is null then return private.refuse('NOT_SIGNED_IN'); end if;
  if not private.is_practitioner() or private.is_engine() then
    return private.refuse('NOT_A_PRACTITIONER');
  end if;
  if not private.form_template_version_accessible(v_user, p_form_template_version_id) then
    return private.refuse('FORM_TEMPLATE_VERSION_NOT_FOUND');
  end if;
  if p_synthetic_patient_ref is not null and p_synthetic_patient_ref !~ '^SYN-[0-9]{1,8}$' then
    return private.refuse('VALIDATION', 'synthetic_patient_ref');
  end if;
  if p_scheduled_at is null then return private.refuse('VALIDATION', 'scheduled_at'); end if;
  if char_length(coalesce(p_scenario_notes, '')) > 500 then
    return private.refuse('VALIDATION', 'scenario_notes');
  end if;
  if p_fee_cents is not null and p_fee_cents not between 50 and 100000 then
    return private.refuse('VALIDATION', 'fee_cents');
  end if;
  if (nullif(v_name, '') is null)
    <> (nullif(btrim(coalesce(p_patient_contact, '')), '') is null) then
    return private.refuse('VALIDATION', 'patient');
  end if;

  begin
    insert into public.consultations (
      practitioner_id, synthetic_patient_ref, scheduled_at, language, status,
      consent_recorded_at, consent_recorded_by, scenario_notes, fee_cents,
      form_template_version_id
    ) values (
      v_user, coalesce(p_synthetic_patient_ref, private.new_reference()), p_scheduled_at,
      p_language, v_status, case when p_consent_recorded then now() end,
      case when p_consent_recorded then v_user end, coalesce(p_scenario_notes, ''),
      p_fee_cents, p_form_template_version_id
    ) returning * into v_consultation;

    if nullif(v_name, '') is not null then
      v_claim := private.identify_patient(v_consultation, p_patient_name, p_patient_contact);
      if not (v_claim ->> 'ok')::boolean then raise exception using errcode = 'W0001'; end if;
    end if;
  exception when sqlstate 'W0001' then
    return v_claim;
  end;

  perform private.log_event(v_consultation.id, 'consultation.created', v_user::text,
    'practitioner', 'consultation', v_consultation.id, 'success',
    jsonb_build_object('to_status', v_status));
  if p_consent_recorded then
    perform private.log_event(v_consultation.id, 'consent.recorded', v_user::text,
      'practitioner', 'consultation', v_consultation.id, 'success', '{}'::jsonb);
  end if;
  return jsonb_build_object('ok', true, 'consultation_id', v_consultation.id,
    'status', v_status, 'invite_token', v_consultation.invite_token,
    'form_template_version_id', p_form_template_version_id);
end;
$$;

revoke all on function public.create_consultation_with_template(
  timestamptz, public.consultation_language, boolean, uuid, text, int, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_consultation_with_template(
  timestamptz, public.consultation_language, boolean, uuid, text, int, text, text, text
) to authenticated;
