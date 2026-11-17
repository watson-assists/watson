-- Who may take part in a call's handshake (security review SEC-03, 18 Oct; fixed 17 Nov 2026).
--
-- Until now the handshake ran on a public Realtime channel named after the patient's link, and each
-- browser said for itself whether it was the doctor or the patient. Anyone holding the link could
-- pose as the doctor, end someone else's call, or join an unpaid one: the payment check lived only
-- in the page. Now:
-- - the patient's browser holds an anonymous session (Supabase Auth, free) and asks admit_to_call
--   with the link; the database admits it only to a consultation whose call is open (consent
--   pending or ready for audio) and paid when it has a fee, and only one patient device at a time;
-- - each direction of the handshake is its own private channel, call:<consultation>:to-patient and
--   call:<consultation>:to-doctor. Only the consultation's practitioner sends to the patient and
--   only the admitted patient sends to the doctor; both may listen on both. Roles come from who is
--   signed in, never from what a browser says.
-- Realtime checks these rules when a browser joins a channel, so a device replaced by a newer one
-- keeps its current connection until it reconnects; it cannot join again.
--
-- Anonymous sessions need sign-up switched on in Supabase Auth, and Watson has no public sign-up
-- (spec section 11). The before_user_created hook at the end refuses every sign-up except an
-- anonymous one; accounts Watson makes itself (service role) do not pass through it.

create table private.call_admissions (
  consultation_id uuid primary key references public.consultations (id) on delete cascade,
  patient_user_id uuid not null references auth.users (id) on delete cascade,
  admitted_at timestamptz not null default now()
);
alter table private.call_admissions enable row level security;
revoke all on private.call_admissions from public, anon, authenticated, service_role;

create function public.admit_to_call(p_token text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_consultation public.consultations;
begin
  if v_user is null then return private.refuse('NOT_SIGNED_IN'); end if;
  select * into v_consultation from private.consultation_for_token(p_token);
  if v_consultation.id is null then return private.refuse('NOT_FOUND'); end if;
  if v_consultation.status not in ('consent_pending', 'ready_for_audio') then
    return private.refuse('CALL_CLOSED');
  end if;
  if v_consultation.fee_cents is not null and v_consultation.paid_at is null then
    return private.refuse('PAYMENT_REQUIRED');
  end if;
  insert into private.call_admissions (consultation_id, patient_user_id)
    values (v_consultation.id, v_user)
  on conflict (consultation_id) do update
    set patient_user_id = excluded.patient_user_id, admitted_at = now();
  perform private.log_event(v_consultation.id, 'call.patient_admitted', v_user::text, 'patient',
    'consultation', v_consultation.id, 'success');
  return jsonb_build_object('ok', true, 'consultation_id', v_consultation.id);
end;
$$;
revoke all on function public.admit_to_call(text) from public, anon, service_role;
grant execute on function public.admit_to_call(text) to authenticated;

-- 'doctor' or 'patient' for the signed-in user on this call's channel, null when they have no part
-- in it. The topic is call:<consultation id>:to-doctor or call:<consultation id>:to-patient.
create function private.call_part(p_topic text) returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_consultation uuid;
begin
  if v_user is null or p_topic !~ '^call:[0-9a-f-]{36}:to-(doctor|patient)$' then return null; end if;
  v_consultation := split_part(p_topic, ':', 2)::uuid;
  if exists (select 1 from public.consultations c
             where c.id = v_consultation and c.practitioner_id = v_user) then
    return 'doctor';
  end if;
  if exists (select 1 from private.call_admissions a
             where a.consultation_id = v_consultation and a.patient_user_id = v_user) then
    return 'patient';
  end if;
  return null;
end;
$$;
revoke all on function private.call_part(text) from public, anon, service_role;
grant execute on function private.call_part(text) to authenticated;

create policy "The two people in a call hear its handshake"
  on realtime.messages for select to authenticated
  using (realtime.messages.extension = 'broadcast'
         and private.call_part((select realtime.topic())) is not null);

create policy "Each side of a call sends only to the other"
  on realtime.messages for insert to authenticated
  with check (realtime.messages.extension = 'broadcast'
              and private.call_part((select realtime.topic())) =
                  case split_part((select realtime.topic()), ':', 3)
                    when 'to-patient' then 'doctor' when 'to-doctor' then 'patient' end);

-- Supabase Auth asks this before it creates any account through sign-up: only an anonymous call
-- session may be created that way. Configured in supabase/config.toml and, for the hosted
-- project, by scripts/configure-hosted-auth.sh.
create function public.hook_before_user_created(event jsonb) returns jsonb
language sql stable set search_path = ''
as $$
  select case when coalesce((event -> 'user' ->> 'is_anonymous')::boolean, false) then '{}'::jsonb
    else jsonb_build_object('error', jsonb_build_object('http_code', 403,
      'message', 'Watson has no public sign-up. Your practice gives you your account.')) end;
$$;
revoke all on function public.hook_before_user_created(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
