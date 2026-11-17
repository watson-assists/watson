-- Limits that keep a stranger from filling a practitioner's calendar (security review SEC-04,
-- 18 Oct; the owner chose the pragmatic fix on 17 Nov 2026). No extra step for patients: older
-- patients book as before. Instead:
-- 1. at most 20 online bookings in 24 hours per practitioner that still hold their time; a solo
--    practice with 45-minute times has about 10 a day. The practitioner archives a bogus booking
--    to free its time.
-- 2. starting a payment again renews an unpaid time's hold, but never past two hours after it was
--    booked; then the time is free again. Stripe's page needs at least 30 minutes, so a renewal
--    that cannot give that is refused as the time no longer held.
-- The limit of three upcoming bookings per phone or email stays. A code sent to the patient before
-- a free booking holds its time is left for Gate R, or for the first sign of abuse.

create or replace function public.book_time(
  p_slug text, p_starts_at timestamptz, p_name text, p_contact text,
  p_language public.consultation_language, p_remind_whatsapp boolean
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_page public.practitioner_profiles;
  v_consultation public.consultations;
  v_claim jsonb;
begin
  select * into v_page from public.practitioner_profiles where slug = p_slug for update;
  if not found then return private.refuse('NOT_FOUND'); end if;
  -- At most 20 online bookings a day per practitioner that still hold their time (SEC-04).
  if (select count(*) from public.consultations c
      where c.practitioner_id = v_page.practitioner_id and c.booked_at > now() - interval '24 hours'
        and private.takes_time(c)) >= 20 then
    return private.refuse('BOOKING_LIMIT');
  end if;
  if p_language is null or not (p_language = any (v_page.languages)) then
    return private.refuse('VALIDATION', 'language');
  end if;
  if p_starts_at is null or not exists (
    select 1 from private.open_times(v_page, p_starts_at, p_starts_at + interval '1 minute') t
    where t.starts_at = p_starts_at
  ) then return private.refuse('TIME_TAKEN'); end if;

  begin
    insert into public.consultations (practitioner_id, synthetic_patient_ref, scheduled_at, duration_minutes,
      language, status, fee_cents, booked_at, hold_until, remind_whatsapp)
    values (v_page.practitioner_id, private.new_reference(), p_starts_at, v_page.length_minutes,
      p_language, 'consent_pending', v_page.fee_cents, now(),
      case when v_page.fee_cents is not null then now() + interval '35 minutes' end,
      coalesce(p_remind_whatsapp, false)) returning * into v_consultation;
    v_claim := private.identify_patient(v_consultation, p_name, p_contact);
    if (v_claim ->> 'ok')::boolean and (
      select count(*) from public.consultations c where c.id <> v_consultation.id
        and c.practitioner_id = v_page.practitioner_id
        and ((c.patient_claim_phone is not null and c.patient_claim_phone =
                (select patient_claim_phone from public.consultations where id = v_consultation.id))
          or (c.patient_claim_email is not null and c.patient_claim_email =
                (select patient_claim_email from public.consultations where id = v_consultation.id)))
        and c.scheduled_at > now() and private.takes_time(c)) >= 3 then
      v_claim := private.refuse('TOO_MANY_BOOKINGS');
    end if;
    if not (v_claim ->> 'ok')::boolean then raise exception using errcode = 'W0001'; end if;
  exception when sqlstate 'W0001' then return v_claim;
  end;
  perform private.log_event(v_consultation.id, 'consultation.booked', 'patient', 'patient',
    'consultation', v_consultation.id, 'success', jsonb_build_object('to_status', v_consultation.status));
  return jsonb_build_object('ok', true, 'token', v_consultation.invite_token);
end;
$$;

create or replace function public.renew_hold(p_token text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_practitioner uuid;
  v_consultation public.consultations;
  v_until timestamptz;
begin
  select practitioner_id into v_practitioner from public.consultations where invite_token = p_token;
  if not found then
    return private.refuse('NOT_FOUND');
  end if;
  -- The same lock as book_time, taken first, so a renewal and a booking cannot both win the time.
  perform 1 from public.practitioner_profiles where practitioner_id = v_practitioner for update;
  select * into v_consultation from public.consultations where invite_token = p_token for update;
  if v_consultation.hold_until is null or v_consultation.paid_at is not null then
    return jsonb_build_object('ok', true, 'hold_until', null);
  end if;
  v_until := least(now() + interval '35 minutes',
                   coalesce(v_consultation.booked_at, now()) + interval '2 hours');
  if v_until < now() + interval '30 minutes' then
    return private.refuse('TIME_TAKEN');
  end if;
  if private.time_blocked(v_practitioner, v_consultation.scheduled_at,
       v_consultation.scheduled_at + make_interval(mins => v_consultation.duration_minutes), v_consultation.id) then
    return private.refuse('TIME_TAKEN');
  end if;
  update public.consultations set hold_until = v_until, updated_at = now()
    where id = v_consultation.id returning * into v_consultation;
  return jsonb_build_object('ok', true, 'hold_until', v_consultation.hold_until);
end;
$$;
