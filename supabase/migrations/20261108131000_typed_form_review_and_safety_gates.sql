create function private.form_field_definition(p_form_id uuid, p_field_key text) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select field
  from public.forms f,
       jsonb_array_elements(f.template -> 'sections') section,
       jsonb_array_elements(section -> 'fields') field
  where f.id = p_form_id and field ->> 'key' = p_field_key;
$$;

create function public.review_typed_form_answer(
  p_form_id uuid,
  p_field_key text,
  p_decision text,
  p_state text default null,
  p_value jsonb default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_form public.forms;
  v_answer public.form_answers;
  v_field jsonb;
  v_status public.consultation_status;
begin
  select f.* into v_form from public.forms f
  join public.consultations c on c.id = f.consultation_id
  where f.id = p_form_id and c.practitioner_id = v_user for update of f;
  if not found then return private.refuse('NOT_FOUND'); end if;
  select status into v_status from public.consultations
    where id = v_form.consultation_id for update;
  if v_form.status <> 'draft' or v_status not in ('draft_ready', 'under_review') then
    return private.reject_transition(v_form.consultation_id, 'review_typed_form_answer', v_status);
  end if;
  v_field := private.form_field_definition(p_form_id, p_field_key);
  if v_field is null or not (v_field ? 'value_type') then
    return private.refuse('VALIDATION', 'field_key');
  end if;
  if v_field ->> 'value_type' in ('attestation', 'signature') then
    return private.refuse('USE_APPROVAL_GATE');
  end if;
  select * into v_answer from public.form_answers
    where form_id = p_form_id and field_key = p_field_key for update;
  if not found then return private.refuse('NOT_FOUND', 'field_key'); end if;

  if p_decision = 'accept' then
    if v_answer.machine_state = 'unanswered' then
      return private.refuse('VALIDATION', 'decision');
    end if;
    update public.form_answers
      set review = 'accepted', practitioner_value = null, practitioner_text = null,
          answer_state = machine_state
      where form_id = p_form_id and field_key = p_field_key;
  elsif p_decision = 'edit' then
    if p_state not in ('known', 'explicit_none', 'unknown', 'not_applicable') then
      return private.refuse('VALIDATION', 'state');
    end if;
    if (p_state = 'known' and not private.valid_typed_answer_value(
          v_field ->> 'value_type', p_value, v_field
        ))
       or (p_state <> 'known' and p_value is not null and p_value <> 'null'::jsonb) then
      return private.refuse('VALIDATION', 'value');
    end if;
    if p_state = 'known' and v_field ->> 'value_type' = 'attachment_reference'
       and not exists (
         select 1 from public.patient_documents d
         where d.id = (p_value #>> '{}')::uuid
           and d.consultation_id = v_form.consultation_id
           and d.removed_at is null and d.reading = 'read'
       ) then
      return private.refuse('VALIDATION', 'value');
    end if;
    update public.form_answers
      set review = 'edited', answer_state = p_state,
          practitioner_value = case when p_state = 'known' then p_value end,
          practitioner_text = case
            when p_state = 'known' and jsonb_typeof(p_value) = 'string' then p_value #>> '{}'
            when p_state = 'known' then left(p_value::text, 4000)
            else null
          end
      where form_id = p_form_id and field_key = p_field_key;
  elsif p_decision = 'reject' then
    update public.form_answers
      set review = 'rejected', practitioner_value = null, practitioner_text = null,
          answer_state = machine_state
      where form_id = p_form_id and field_key = p_field_key;
  elsif p_decision = 'undo' then
    update public.form_answers
      set review = 'unreviewed', practitioner_value = null, practitioner_text = null,
          answer_state = machine_state
      where form_id = p_form_id and field_key = p_field_key;
  else
    return private.refuse('VALIDATION', 'decision');
  end if;

  if v_status = 'draft_ready' then
    update public.consultations set status = 'under_review', updated_at = now()
      where id = v_form.consultation_id;
    perform private.log_event(v_form.consultation_id, 'form.review_started', v_user::text,
      'practitioner', 'form', p_form_id, 'success',
      jsonb_build_object('from_status', 'draft_ready', 'to_status', 'under_review'));
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

create function public.set_form_attestation(
  p_form_id uuid, p_field_key text, p_decision text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_form public.forms;
  v_field jsonb;
  v_gate jsonb;
begin
  select f.* into v_form from public.forms f
  join public.consultations c on c.id = f.consultation_id
  where f.id = p_form_id and c.practitioner_id = v_user for update of f;
  if not found then return private.refuse('NOT_FOUND'); end if;
  if v_form.status <> 'draft' then return private.refuse('FORM_IMMUTABLE'); end if;
  v_field := private.form_field_definition(p_form_id, p_field_key);
  if v_field ->> 'value_type' <> 'attestation'
     or p_decision not in ('confirmed', 'declined', 'not_applicable') then
    return private.refuse('VALIDATION', 'attestation');
  end if;
  insert into public.form_attestations (
    form_id, field_key, decision, attested_by, attested_at
  ) values (p_form_id, p_field_key, p_decision, v_user, now())
  on conflict (form_id, field_key) do update
    set decision = excluded.decision, attested_by = excluded.attested_by,
        attested_at = excluded.attested_at;
  return jsonb_build_object('ok', true);
end;
$$;

create function public.set_form_signature(
  p_form_id uuid,
  p_field_key text,
  p_signer_role text,
  p_method text,
  p_signed_name text,
  p_signed_at timestamptz default now()
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_form public.forms;
  v_field jsonb;
begin
  select f.* into v_form from public.forms f
  join public.consultations c on c.id = f.consultation_id
  where f.id = p_form_id and c.practitioner_id = v_user for update of f;
  if not found then return private.refuse('NOT_FOUND'); end if;
  if v_form.status <> 'draft' then return private.refuse('FORM_IMMUTABLE'); end if;
  v_field := private.form_field_definition(p_form_id, p_field_key);
  select gate into v_gate
  from jsonb_array_elements(coalesce(v_form.template -> 'approval_gates', '[]'::jsonb)) gate
  where gate ->> 'type' = 'signature' and gate ->> 'field_key' = p_field_key;
  if v_field ->> 'value_type' <> 'signature'
     or p_signer_role not in ('patient', 'practitioner')
     -- Gate R safe default: authenticated digital confirmation is not implemented.
     or p_method <> 'wet_ink_on_print'
     or p_signer_role <> coalesce(
       v_gate ->> 'signer_role',
       case when p_field_key like 'patient%' then 'patient' else 'practitioner' end
     )
     or char_length(btrim(coalesce(p_signed_name, ''))) not between 1 and 120
     or p_signed_at is null or p_signed_at > now() + interval '5 minutes' then
    return private.refuse('VALIDATION', 'signature');
  end if;
  insert into public.form_signatures (
    form_id, field_key, signer_role, method, signed_name, signed_at, recorded_by
  ) values (
    p_form_id, p_field_key, p_signer_role, p_method, btrim(p_signed_name),
    p_signed_at, v_user
  )
  on conflict (form_id, field_key, signer_role) do update
    set method = excluded.method, signed_name = excluded.signed_name,
        signed_at = excluded.signed_at, recorded_by = excluded.recorded_by;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.approve_form(p_form_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_form public.forms;
  v_status public.consultation_status;
begin
  select f.* into v_form from public.forms f
  join public.consultations c on c.id = f.consultation_id
  where f.id = p_form_id and c.practitioner_id = v_user;
  if not found then return private.refuse('NOT_FOUND'); end if;
  select status into v_status from public.consultations
    where id = v_form.consultation_id for update;
  if v_form.status <> 'draft' or v_status not in ('draft_ready', 'under_review') then
    return private.reject_transition(v_form.consultation_id, 'approve_form', v_status);
  end if;

  if v_form.template ? 'approval_gates' then
    if exists (
      select 1
      from jsonb_array_elements(v_form.template -> 'sections') s,
           jsonb_array_elements(s -> 'fields') field
      left join public.form_answers a
        on a.form_id = p_form_id and a.field_key = field ->> 'key'
      where coalesce((field ->> 'required')::boolean, false)
        and field ->> 'value_type' not in ('attestation', 'signature')
        and (
          a.field_key is null or a.answer_state = 'unanswered' or a.review = 'rejected'
          or (a.machine_state <> 'unanswered' and a.review = 'unreviewed')
        )
    ) then return private.refuse('FORM_REQUIRED_FIELDS_MISSING'); end if;

    if exists (
      select 1 from public.form_answers a
      where a.form_id = p_form_id and a.machine_state <> 'unanswered'
        and a.review = 'unreviewed'
    ) then return private.refuse('FORM_NOT_REVIEWED'); end if;

    if exists (
      select 1
      from jsonb_array_elements(v_form.template -> 'approval_gates') gate
      where gate ->> 'type' = 'attestation'
        and not exists (
          select 1 from public.form_attestations a
          where a.form_id = p_form_id and a.field_key = gate ->> 'field_key'
            and a.decision = 'confirmed'
        )
    ) then return private.refuse('FORM_ATTESTATIONS_MISSING'); end if;

    if exists (
      select 1
      from jsonb_array_elements(v_form.template -> 'approval_gates') gate
      where gate ->> 'type' = 'signature'
        and not exists (
          select 1 from public.form_signatures s
          where s.form_id = p_form_id and s.field_key = gate ->> 'field_key'
        )
    ) then return private.refuse('FORM_SIGNATURE_MISSING'); end if;
  else
    if exists (select 1 from public.form_answers
               where form_id = p_form_id and review = 'unreviewed' and machine_text is not null) then
      return private.refuse('FORM_NOT_REVIEWED');
    end if;
  end if;

  update public.forms set status = 'approved', approved_at = now(), approved_by = v_user
    where id = p_form_id;
  update public.consultations set status = 'approved', updated_at = now()
    where id = v_form.consultation_id;
  perform private.log_event(v_form.consultation_id, 'form.approved', v_user::text,
    'practitioner', 'form', p_form_id, 'success',
    jsonb_build_object('from_status', v_status, 'to_status', 'approved'));
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function
  public.review_typed_form_answer(uuid, text, text, text, jsonb),
  public.set_form_attestation(uuid, text, text),
  public.set_form_signature(uuid, text, text, text, text, timestamptz)
from public, anon, authenticated, service_role;
grant execute on function
  public.review_typed_form_answer(uuid, text, text, text, jsonb),
  public.set_form_attestation(uuid, text, text),
  public.set_form_signature(uuid, text, text, text, text, timestamptz)
to authenticated;
revoke all on function private.form_field_definition(uuid, text)
from public, anon, authenticated, service_role;
