-- The test team's feedback, C3 (owner, 23 November 2026): the third part of the record, the
-- prescriptions. The general instructions are in the form already; this adds the products the doctor
-- prescribes from a simple shop of their own (herbs and supplements: real medicines need a pharmacy
-- licence), and the patient's own page on their link. Once the form is approved it shows their
-- report, the instructions and the products, which they buy through Stripe (test mode while Watson
-- is tested). The intake and the conversation never leave the doctor.

-- 1. The shop: each practitioner's own products. Never deleted, only hidden: prescriptions name them.
create table public.shop_products (
  id uuid primary key default gen_random_uuid(),
  practitioner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  price_cents int not null check (price_cents between 50 and 100000),
  photo_path text check (photo_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index shop_products_by_practitioner on public.shop_products (practitioner_id);
alter table public.shop_products enable row level security;
revoke all on public.shop_products from public, anon, authenticated, service_role;
grant select on public.shop_products to authenticated;
create policy "Practitioners read their own shop"
  on public.shop_products for select to authenticated
  using (practitioner_id = (select auth.uid()));

-- A product's photo, shown to patients and to Stripe: a public bucket, each practitioner's own folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('shop', 'shop', true, 5242880, array['image/jpeg', 'image/png', 'image/webp']);
create policy "Practitioners add photos to their own shop"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'shop' and private.is_practitioner()
              and name ~ ('^' || (select auth.uid())::text || '/[0-9a-f-]{36}\.(jpg|png|webp)$'));

create function public.save_shop_product(
  p_id uuid, p_name text, p_description text, p_price_cents int, p_photo_path text, p_active boolean
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_id uuid;
begin
  if not private.is_practitioner() then return private.refuse('NOT_FOUND'); end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 120 then return private.refuse('VALIDATION', 'name'); end if;
  if p_description is null or char_length(p_description) > 1000 then return private.refuse('VALIDATION', 'description'); end if;
  if p_price_cents is null or p_price_cents not between 50 and 100000 then return private.refuse('VALIDATION', 'price'); end if;
  if p_photo_path is not null and p_photo_path !~ ('^' || v_user::text || '/[0-9a-f-]{36}\.(jpg|png|webp)$') then
    return private.refuse('VALIDATION', 'photo');
  end if;
  if p_id is null then
    insert into public.shop_products (practitioner_id, name, description, price_cents, photo_path, active)
      values (v_user, btrim(p_name), btrim(p_description), p_price_cents, p_photo_path, coalesce(p_active, true))
      returning id into v_id;
  else
    update public.shop_products set name = btrim(p_name), description = btrim(p_description),
        price_cents = p_price_cents, photo_path = p_photo_path, active = coalesce(p_active, true), updated_at = now()
      where id = p_id and practitioner_id = v_user returning id into v_id;
    if not found then return private.refuse('NOT_FOUND'); end if;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;
revoke all on function public.save_shop_product(uuid, text, text, int, text, boolean) from public, anon, service_role;
grant execute on function public.save_shop_product(uuid, text, text, int, text, boolean) to authenticated;

-- 2. What the doctor prescribes: a product of their own shop, how much, and how to take it. The name is
--    kept as it was prescribed. Changed until the form is approved, then part of the record.
create table public.prescription_items (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid not null references public.consultations (id) on delete cascade,
  product_id uuid not null references public.shop_products (id) on delete restrict,
  product_name text not null,
  quantity int not null default 1 check (quantity between 1 and 20),
  instructions text not null default '' check (char_length(instructions) <= 500),
  created_at timestamptz not null default now()
);
create index prescription_items_by_consultation on public.prescription_items (consultation_id);
alter table public.prescription_items enable row level security;
revoke all on public.prescription_items from public, anon, authenticated, service_role;
grant select on public.prescription_items to authenticated;
create policy "Practitioners read what they prescribed"
  on public.prescription_items for select to authenticated
  using (exists (select 1 from public.consultations c
                 where c.id = prescription_items.consultation_id and c.practitioner_id = (select auth.uid())));

create function public.prescribe(
  p_consultation_id uuid, p_product_id uuid, p_quantity int, p_instructions text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_status public.consultation_status;
  v_product public.shop_products;
  v_id uuid;
begin
  select status into v_status from public.consultations
    where id = p_consultation_id and practitioner_id = v_user for update;
  if not found then return private.refuse('NOT_FOUND'); end if;
  if v_status in ('approved', 'corrected', 'archived', 'consent_withdrawn') then
    return private.reject_transition(p_consultation_id, 'prescribe', v_status);
  end if;
  select * into v_product from public.shop_products where id = p_product_id and practitioner_id = v_user and active;
  if not found then return private.refuse('NOT_FOUND', 'product'); end if;
  if p_quantity is null or p_quantity not between 1 and 20 then return private.refuse('VALIDATION', 'quantity'); end if;
  if p_instructions is null or char_length(p_instructions) > 500 then return private.refuse('VALIDATION', 'instructions'); end if;
  insert into public.prescription_items (consultation_id, product_id, product_name, quantity, instructions)
    values (p_consultation_id, p_product_id, v_product.name, p_quantity, btrim(p_instructions))
    returning id into v_id;
  perform private.log_event(p_consultation_id, 'prescription.added', v_user::text, 'practitioner',
    'prescription_item', v_id, 'success');
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;
revoke all on function public.prescribe(uuid, uuid, int, text) from public, anon, service_role;
grant execute on function public.prescribe(uuid, uuid, int, text) to authenticated;

create function public.unprescribe(p_item_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_consultation public.consultations;
begin
  select c.* into v_consultation from public.consultations c
    join public.prescription_items i on i.consultation_id = c.id
    where i.id = p_item_id and c.practitioner_id = v_user for update of c;
  if not found then return private.refuse('NOT_FOUND'); end if;
  if v_consultation.status in ('approved', 'corrected', 'archived', 'consent_withdrawn') then
    return private.reject_transition(v_consultation.id, 'unprescribe', v_consultation.status);
  end if;
  delete from public.prescription_items where id = p_item_id;
  perform private.log_event(v_consultation.id, 'prescription.removed', v_user::text, 'practitioner',
    'prescription_item', p_item_id, 'success');
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.unprescribe(uuid) from public, anon, service_role;
grant execute on function public.unprescribe(uuid) to authenticated;

-- 3. What the patient gets of the form: the main complaints from the intake; the sections holding the
--    assessment, the recommendation and the general instructions; never the doctor's own fields
--    (private notes), the safety notes, signatures or attestations. The same rule as forPatient in
--    apps/web/src/lib/export.ts, which prints the doctor's copy for the patient; a test holds both.
create function private.for_patient(p_template jsonb) returns jsonb
language sql immutable set search_path = ''
as $$
  select jsonb_set(p_template, '{sections}', coalesce((
    select jsonb_agg(jsonb_set(s.section, '{fields}', kept.fields) order by s.n)
    from jsonb_array_elements(p_template -> 'sections') with ordinality s(section, n)
    cross join lateral (
      select jsonb_agg(f.field order by f.m) as fields
      from jsonb_array_elements(s.section -> 'fields') with ordinality f(field, m)
      where coalesce(f.field ->> 'mode', 'extract') <> 'manual'
        and f.field ->> 'key' <> 'safety'
        and coalesce(f.field ->> 'value_type', 'text') not in ('signature', 'attestation')
        and (f.field ->> 'key' in ('main_concern', 'history_of_concern')
             or exists (select 1 from jsonb_array_elements(s.section -> 'fields') g
                        where g ->> 'key' in ('assessment', 'therapies', 'daily_routine')))
    ) kept
    where kept.fields is not null), '[]'::jsonb));
$$;
revoke all on function private.for_patient(jsonb) from public, anon, authenticated, service_role;

-- 4. What the patient buys: prescribed products, at the price of the day, sent to the address they give
--    Stripe. Their practitioner sends them and marks the order sent.
create table public.shop_orders (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid not null references public.consultations (id) on delete restrict,
  items jsonb not null,
  total_cents int not null check (total_cents > 0),
  status text not null default 'open' check (status in ('open', 'paid', 'sent')),
  stripe_checkout_session_id text unique,
  ship_to jsonb,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  sent_at timestamptz
);
create index shop_orders_by_consultation on public.shop_orders (consultation_id);
alter table public.shop_orders enable row level security;
revoke all on public.shop_orders from public, anon, authenticated, service_role;
grant select on public.shop_orders to authenticated;
create policy "Practitioners read the orders of their patients"
  on public.shop_orders for select to authenticated
  using (exists (select 1 from public.consultations c
                 where c.id = shop_orders.consultation_id and c.practitioner_id = (select auth.uid())));

-- The patient's own page, on their link: nothing until the form is approved.
create function public.patient_report(p_token text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_consultation public.consultations;
  v_form public.forms;
  v_template jsonb;
begin
  select * into v_consultation from private.consultation_for_token(p_token);
  if v_consultation.id is null then return private.refuse('NOT_FOUND'); end if;
  select * into v_form from public.forms
    where consultation_id = v_consultation.id and status = 'approved' and v_consultation.status in ('approved', 'corrected')
    order by revision_number desc limit 1;
  if not found then return jsonb_build_object('ok', true, 'report', null); end if;
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
    'prescriptions', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', i.id, 'name', i.product_name, 'description', p.description, 'photo_path', p.photo_path,
        'price_cents', p.price_cents, 'quantity', i.quantity, 'instructions', i.instructions,
        'available', p.active) order by i.created_at), '[]'::jsonb)
      from public.prescription_items i join public.shop_products p on p.id = i.product_id
      where i.consultation_id = v_consultation.id),
    'orders', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', o.id, 'status', o.status, 'total_cents', o.total_cents, 'paid_at', o.paid_at, 'sent_at', o.sent_at,
        'items', o.items) order by o.created_at), '[]'::jsonb)
      from public.shop_orders o where o.consultation_id = v_consultation.id and o.status <> 'open')));
end;
$$;
revoke all on function public.patient_report(text) from public;
grant execute on function public.patient_report(text) to anon, authenticated, service_role;

-- The payment edge function, for the patient's page: an order of some of the prescribed products.
create function public.open_shop_order(p_token text, p_item_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_consultation public.consultations;
  v_items jsonb;
  v_total int;
  v_id uuid;
begin
  select * into v_consultation from private.consultation_for_token(p_token);
  if v_consultation.id is null then return private.refuse('NOT_FOUND'); end if;
  if v_consultation.status not in ('approved', 'corrected') then
    return private.refuse('INVALID_STATE_TRANSITION');
  end if;
  select jsonb_agg(jsonb_build_object('prescription_item_id', i.id, 'product_id', p.id, 'name', p.name,
           'quantity', i.quantity, 'price_cents', p.price_cents, 'photo_path', p.photo_path) order by i.created_at),
         sum(i.quantity * p.price_cents)
    into v_items, v_total
    from public.prescription_items i join public.shop_products p on p.id = i.product_id
    where i.consultation_id = v_consultation.id and i.id = any(p_item_ids) and p.active;
  if v_items is null or jsonb_array_length(v_items) <> (select count(distinct x) from unnest(p_item_ids) x) then
    return private.refuse('VALIDATION', 'items');
  end if;
  insert into public.shop_orders (consultation_id, items, total_cents) values (v_consultation.id, v_items, v_total)
    returning id into v_id;
  return jsonb_build_object('ok', true, 'order_id', v_id, 'consultation_id', v_consultation.id,
    'items', v_items, 'total_cents', v_total);
end;
$$;
revoke all on function public.open_shop_order(text, uuid[]) from public, anon, authenticated;
grant execute on function public.open_shop_order(text, uuid[]) to service_role;

-- Stripe's word that an order is paid (the webhook, or the patient back from Stripe). Safe to repeat.
create function public.record_shop_payment(
  p_order_id uuid, p_consultation_id uuid, p_session_id text, p_amount_cents int, p_ship_to jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_order public.shop_orders;
begin
  select * into v_order from public.shop_orders
    where id = p_order_id and consultation_id = p_consultation_id for update;
  if not found then return private.refuse('NOT_FOUND'); end if;
  if v_order.status <> 'open' then return jsonb_build_object('ok', true, 'already', true); end if;
  if p_amount_cents is distinct from v_order.total_cents then return private.refuse('VALIDATION', 'amount'); end if;
  update public.shop_orders set status = 'paid', paid_at = now(), stripe_checkout_session_id = p_session_id,
      ship_to = case when jsonb_typeof(p_ship_to) = 'object' and length(p_ship_to::text) <= 2000 then p_ship_to end
    where id = p_order_id;
  perform private.log_event(p_consultation_id, 'shop.order_paid', 'stripe', 'payment', 'shop_order', p_order_id, 'success');
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.record_shop_payment(uuid, uuid, text, int, jsonb) from public, anon, authenticated;
grant execute on function public.record_shop_payment(uuid, uuid, text, int, jsonb) to service_role;

create function public.mark_order_sent(p_order_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_order public.shop_orders;
begin
  select o.* into v_order from public.shop_orders o join public.consultations c on c.id = o.consultation_id
    where o.id = p_order_id and c.practitioner_id = (select auth.uid()) for update of o;
  if not found then return private.refuse('NOT_FOUND'); end if;
  if v_order.status <> 'paid' then return private.refuse('INVALID_STATE_TRANSITION'); end if;
  update public.shop_orders set status = 'sent', sent_at = now() where id = p_order_id;
  perform private.log_event(v_order.consultation_id, 'shop.order_sent', (select auth.uid())::text, 'practitioner',
    'shop_order', p_order_id, 'success');
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.mark_order_sent(uuid) from public, anon, service_role;
grant execute on function public.mark_order_sent(uuid) to authenticated;
