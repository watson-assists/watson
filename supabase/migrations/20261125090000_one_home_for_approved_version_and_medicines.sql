-- One home for two rules (owner, 24 Nov 2026: DRY, no repeated code). "The latest approved version of a
-- consultation's form" was written out in three functions, and "the medicines as prescribed" in two.
-- Behaviour is unchanged; the functions below are as on 24 November, using the two helpers.

create function private.latest_approved_form(p_consultation_id uuid) returns public.forms
language sql stable security definer set search_path = ''
as $$
  select * from public.forms where consultation_id = p_consultation_id and status = 'approved'
  order by revision_number desc limit 1;
$$;
revoke all on function private.latest_approved_form(uuid) from public, anon, authenticated, service_role;

create function private.medicines_now(p_consultation_id uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'item_id', i.id, 'product_id', i.product_id, 'name', i.product_name,
      'quantity', i.quantity, 'instructions', i.instructions) order by i.created_at), '[]'::jsonb)
  from public.prescription_items i where i.consultation_id = p_consultation_id;
$$;
revoke all on function private.medicines_now(uuid) from public, anon, authenticated, service_role;

create or replace function private.keep_medicines_with_approval() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.medicines := private.medicines_now(new.consultation_id);
  return new;
end;
$$;

create or replace function public.start_form_change(p_consultation_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_consultation public.consultations;
  v_form public.forms;
  v_id uuid;
begin
  select * into v_consultation from public.consultations
    where id = p_consultation_id and practitioner_id = v_user for update;
  if not found then return private.refuse('NOT_FOUND'); end if;
  if v_consultation.status not in ('approved', 'corrected') then
    return private.reject_transition(p_consultation_id, 'start_form_change', v_consultation.status);
  end if;
  v_form := private.latest_approved_form(p_consultation_id);
  if v_form.id is null then return private.refuse('NOT_FOUND'); end if;
  if v_form.approved_by is distinct from v_user then return private.refuse('NOT_THE_APPROVER'); end if;
  insert into public.forms (consultation_id, job_id, transcript_id, template, form_template_version_id,
                            revision_kind, parent_form_id)
    values (p_consultation_id, null, v_form.transcript_id, v_form.template, v_form.form_template_version_id,
            'correction', v_form.id)
    returning id into v_id;
  insert into public.form_answers (form_id, field_key, position, machine_text, evidence, document_quotes,
      practitioner_text, review, value_type, answer_state, machine_state, machine_value, practitioner_value)
    select v_id, field_key, position, machine_text, evidence, document_quotes,
      practitioner_text, review, value_type, answer_state, machine_state, machine_value, practitioner_value
    from public.form_answers where form_id = v_form.id;
  update public.consultations set status = 'under_review', updated_at = now() where id = p_consultation_id;
  perform private.log_event(p_consultation_id, 'form.change_started', v_user::text, 'practitioner', 'form', v_id,
    'success', jsonb_build_object('from_status', v_consultation.status, 'to_status', 'under_review'));
  return jsonb_build_object('ok', true, 'form_id', v_id);
end;
$$;

create or replace function public.patient_report(p_token text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_consultation public.consultations;
  v_form public.forms;
  v_template jsonb;
begin
  select * into v_consultation from private.consultation_for_token(p_token);
  if v_consultation.id is null then return private.refuse('NOT_FOUND'); end if;
  v_form := private.latest_approved_form(v_consultation.id);
  if v_form.id is null then return jsonb_build_object('ok', true, 'report', null); end if;
  v_template := private.for_patient(v_form.template);
  return jsonb_build_object('ok', true, 'report', jsonb_build_object(
    'approved_at', v_form.approved_at,
    'language', v_consultation.language,
    'practitioner', (select display_name from public.practitioner_profiles where practitioner_id = v_consultation.practitioner_id),
    'template', v_template,
    'answers', (select coalesce(jsonb_agg(jsonb_build_object(
        'field_key', a.field_key, 'machine_text', a.machine_text, 'practitioner_text', a.practitioner_text,
        'review', a.review, 'value_type', a.value_type, 'answer_state', a.answer_state,
        'machine_value', a.machine_value, 'practitioner_value', a.practitioner_value)), '[]'::jsonb)
      from public.form_answers a
      where a.form_id = v_form.id and a.review <> 'rejected'
        and (a.answer_state <> 'unanswered' or coalesce(a.practitioner_text, a.machine_text) is not null)
        and a.field_key in (
          select f ->> 'key' from jsonb_array_elements(v_template -> 'sections') s, jsonb_array_elements(s -> 'fields') f)),
    -- Before 24 November no medicines were kept with a version: then the current list.
    'prescriptions', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', m ->> 'item_id', 'name', m ->> 'name', 'description', p.description, 'photo_path', p.photo_path,
        'price_cents', p.price_cents, 'quantity', (m ->> 'quantity')::int, 'instructions', m ->> 'instructions',
        'available', p.active and exists (select 1 from public.prescription_items i where i.id = (m ->> 'item_id')::uuid))
        order by x.n), '[]'::jsonb)
      from jsonb_array_elements(coalesce(v_form.medicines, private.medicines_now(v_consultation.id))) with ordinality x(m, n)
      join public.shop_products p on p.id = (m ->> 'product_id')::uuid),
    'orders', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', o.id, 'status', o.status, 'total_cents', o.total_cents, 'paid_at', o.paid_at, 'sent_at', o.sent_at,
        'items', o.items) order by o.created_at), '[]'::jsonb)
      from public.shop_orders o where o.consultation_id = v_consultation.id and o.status <> 'open')));
end;
$$;

create or replace function public.open_shop_order(p_token text, p_item_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_consultation public.consultations;
  v_form public.forms;
  v_items jsonb;
  v_total int;
  v_id uuid;
begin
  select * into v_consultation from private.consultation_for_token(p_token);
  if v_consultation.id is null then return private.refuse('NOT_FOUND'); end if;
  v_form := private.latest_approved_form(v_consultation.id);
  if v_form.id is null then return private.refuse('INVALID_STATE_TRANSITION'); end if;
  select jsonb_agg(jsonb_build_object('prescription_item_id', i.id, 'product_id', p.id, 'name', p.name,
           'quantity', i.quantity, 'price_cents', p.price_cents, 'photo_path', p.photo_path) order by i.created_at),
         sum(i.quantity * p.price_cents)
    into v_items, v_total
    from public.prescription_items i join public.shop_products p on p.id = i.product_id
    where i.consultation_id = v_consultation.id and i.id = any(p_item_ids) and p.active
      and (v_form.medicines is null
           or exists (select 1 from jsonb_array_elements(v_form.medicines) m where (m ->> 'item_id')::uuid = i.id));
  if v_items is null or jsonb_array_length(v_items) <> (select count(distinct x) from unnest(p_item_ids) x) then
    return private.refuse('VALIDATION', 'items');
  end if;
  insert into public.shop_orders (consultation_id, items, total_cents) values (v_consultation.id, v_items, v_total)
    returning id into v_id;
  return jsonb_build_object('ok', true, 'order_id', v_id, 'consultation_id', v_consultation.id,
    'items', v_items, 'total_cents', v_total);
end;
$$;
