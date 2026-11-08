-- A follow-up may explicitly name one earlier consultation. The relationship
-- stays optional and can only be established through the guarded RPC below.
alter table public.consultations
  add column previous_consultation_id uuid
    references public.consultations(id) on delete restrict,
  add constraint consultations_previous_not_self
    check (previous_consultation_id is null or previous_consultation_id <> id);

create index consultations_previous_consultation_idx
  on public.consultations(previous_consultation_id)
  where previous_consultation_id is not null;

-- Patient identity and appointment order are part of the link invariant. A
-- later reassociation must unlink first rather than leaving a stale cross-
-- patient relationship behind.
create function private.prevent_linked_consultation_identity_change() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_has_link boolean := old.previous_consultation_id is not null or exists (
    select 1 from public.consultations c
    where c.previous_consultation_id = old.id
  );
begin
  if v_has_link and (
    new.patient_id is distinct from old.patient_id
    or new.practitioner_id is distinct from old.practitioner_id
    or new.patient_association_state not in ('verified', 'practitioner_confirmed')
  ) then
    raise exception using
      errcode = '55000',
      message = 'unlink the previous consultation before changing patient identity';
  end if;

  if new.scheduled_at is distinct from old.scheduled_at and (
    exists (
      select 1 from public.consultations p
      where p.id = old.previous_consultation_id
        and p.scheduled_at >= new.scheduled_at
    )
    or exists (
      select 1 from public.consultations c
      where c.previous_consultation_id = old.id
        and c.scheduled_at <= new.scheduled_at
    )
  ) then
    raise exception using
      errcode = '55000',
      message = 'linked consultations must remain in chronological order';
  end if;

  return new;
end;
$$;

create trigger consultations_preserve_previous_link_invariants
  before update of patient_id, patient_association_state, practitioner_id, scheduled_at
  on public.consultations
  for each row execute function private.prevent_linked_consultation_identity_change();

create function public.link_previous_consultation(
  p_consultation_id uuid,
  p_previous_consultation_id uuid
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_consultation public.consultations;
  v_previous public.consultations;
  v_cycle boolean;
begin
  if not private.is_practitioner() or private.is_engine() then
    return private.refuse('NOT_A_PRACTITIONER');
  end if;

  select * into v_consultation
  from public.consultations
  where id = p_consultation_id and practitioner_id = v_user
  for update;
  if not found then return private.refuse('NOT_FOUND'); end if;

  if p_previous_consultation_id is not distinct from v_consultation.previous_consultation_id then
    return jsonb_build_object(
      'ok', true,
      'consultation_id', p_consultation_id,
      'previous_consultation_id', p_previous_consultation_id
    );
  end if;

  if v_consultation.status not in ('consent_pending', 'ready_for_audio') then
    return private.refuse('PREVIOUS_LINK_TOO_LATE');
  end if;

  if p_previous_consultation_id is null then
    update public.consultations
    set previous_consultation_id = null,
        updated_at = now()
    where id = p_consultation_id;

    perform private.log_event(
      p_consultation_id,
      'consultation.previous_unlinked',
      v_user::text,
      'practitioner',
      'consultation',
      v_consultation.previous_consultation_id,
      'success',
      '{}'::jsonb
    );

    return jsonb_build_object(
      'ok', true,
      'consultation_id', p_consultation_id,
      'previous_consultation_id', null
    );
  end if;
  if p_previous_consultation_id = p_consultation_id then
    return private.refuse('SELF_LINK');
  end if;

  select * into v_previous
  from public.consultations
  where id = p_previous_consultation_id and practitioner_id = v_user
  for update;
  if not found then return private.refuse('NOT_FOUND'); end if;

  -- Detect a cycle explicitly, even though the chronological rule below also
  -- prevents a valid chain from cycling.
  with recursive previous_chain(id) as (
    values (p_previous_consultation_id)
    union
    select c.previous_consultation_id
    from public.consultations c
    join previous_chain chain on c.id = chain.id
    where c.previous_consultation_id is not null
  )
  select exists (
    select 1 from previous_chain where id = p_consultation_id
  ) into v_cycle;
  if v_cycle then return private.refuse('CYCLE_DETECTED'); end if;

  if v_previous.scheduled_at >= v_consultation.scheduled_at then
    return private.refuse('PREVIOUS_NOT_EARLIER');
  end if;
  if v_consultation.patient_id is null or v_previous.patient_id is null
    or v_consultation.patient_association_state not in ('verified', 'practitioner_confirmed')
    or v_previous.patient_association_state not in ('verified', 'practitioner_confirmed') then
    return private.refuse('PATIENT_NOT_CONFIRMED');
  end if;
  if v_consultation.patient_id <> v_previous.patient_id then
    return private.refuse('PATIENT_MISMATCH');
  end if;

  if v_consultation.previous_consultation_id is distinct from p_previous_consultation_id then
    update public.consultations
    set previous_consultation_id = p_previous_consultation_id,
        updated_at = now()
    where id = p_consultation_id;

    -- The event's consultation_id and resource_id are the two link IDs. No
    -- patient identity or clinical metadata enters the audit log.
    perform private.log_event(
      p_consultation_id,
      'consultation.previous_linked',
      v_user::text,
      'practitioner',
      'consultation',
      p_previous_consultation_id,
      'success',
      '{}'::jsonb
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'consultation_id', p_consultation_id,
    'previous_consultation_id', p_previous_consultation_id
  );
end;
$$;

revoke all on function public.link_previous_consultation(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.link_previous_consultation(uuid, uuid)
  to authenticated;

revoke all on function private.prevent_linked_consultation_identity_change()
  from public, anon, authenticated, service_role;
