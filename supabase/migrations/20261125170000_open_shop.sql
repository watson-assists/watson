-- The practice's open shop (owner, 25 November 2026: "the link directly to the store"). Besides the
-- medicines prescribed on a patient's link, a doctor can put products in a shop anyone opens from
-- their shop link (/shop/?p=<their page>), and buy without a consultation. Only the products they put
-- in it: what they only prescribe stays out. Orders reach "Orders to send" like any other.

alter table public.shop_products add column in_open_shop boolean not null default false;

-- An order belongs to the practice; from the open shop it has no consultation.
alter table public.shop_orders
  add column practitioner_id uuid references auth.users (id) on delete restrict,
  alter column consultation_id drop not null;
update public.shop_orders o set practitioner_id = c.practitioner_id
  from public.consultations c where c.id = o.consultation_id;
alter table public.shop_orders alter column practitioner_id set not null;
create index shop_orders_by_practitioner on public.shop_orders (practitioner_id);
drop policy "Practitioners read the orders of their patients" on public.shop_orders;
create policy "Practitioners read the orders of their shop"
  on public.shop_orders for select to authenticated
  using (practitioner_id = (select auth.uid()));

-- As on 24 November, and whether the product is in the open shop: left as it is when not given.
drop function public.save_shop_product(uuid, text, text, int, text, boolean);
create function public.save_shop_product(
  p_id uuid, p_name text, p_description text, p_price_cents int, p_photo_path text, p_active boolean,
  p_in_open_shop boolean default null
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
    insert into public.shop_products (practitioner_id, name, description, price_cents, photo_path, active, in_open_shop)
      values (v_user, btrim(p_name), btrim(p_description), p_price_cents, p_photo_path, coalesce(p_active, true),
              coalesce(p_in_open_shop, false))
      returning id into v_id;
  else
    update public.shop_products set name = btrim(p_name), description = btrim(p_description),
        price_cents = p_price_cents, photo_path = p_photo_path, active = coalesce(p_active, true),
        in_open_shop = coalesce(p_in_open_shop, in_open_shop), updated_at = now()
      where id = p_id and practitioner_id = v_user returning id into v_id;
    if not found then return private.refuse('NOT_FOUND'); end if;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;
revoke all on function public.save_shop_product(uuid, text, text, int, text, boolean, boolean) from public, anon, service_role;
grant execute on function public.save_shop_product(uuid, text, text, int, text, boolean, boolean) to authenticated;

-- Anyone with the link: the practice's name and what is in its open shop.
create function public.open_shop(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_page public.practitioner_profiles;
begin
  select * into v_page from public.practitioner_profiles where slug = p_slug;
  if not found then return private.refuse('NOT_FOUND'); end if;
  return jsonb_build_object('ok', true, 'practice', v_page.display_name, 'products', coalesce((
    select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'description', s.description,
             'price_cents', s.price_cents, 'photo_path', s.photo_path) order by s.created_at)
      from public.shop_products s
      where s.practitioner_id = v_page.practitioner_id and s.active and s.in_open_shop), '[]'::jsonb));
end;
$$;
revoke all on function public.open_shop(text) from public;
grant execute on function public.open_shop(text) to anon, authenticated;

-- The payment function only: an order from the open shop, at today's prices. p_items:
-- [{"product_id": …, "quantity": 1-10}], each product once.
create function public.start_shop_order(p_slug text, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_page public.practitioner_profiles;
  v_items jsonb;
  v_total int;
  v_lines int;
  v_id uuid;
begin
  select * into v_page from public.practitioner_profiles where slug = p_slug;
  if not found then return private.refuse('NOT_FOUND'); end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 20 then
    return private.refuse('VALIDATION', 'items');
  end if;
  begin
    select jsonb_agg(jsonb_build_object('product_id', s.id, 'name', s.name, 'quantity', w.quantity,
             'price_cents', s.price_cents, 'photo_path', s.photo_path) order by w.n),
           sum(w.quantity * s.price_cents), count(*)
      into v_items, v_total, v_lines
      from (select (x.i ->> 'product_id')::uuid as product_id, (x.i ->> 'quantity')::int as quantity, x.n
              from jsonb_array_elements(p_items) with ordinality as x(i, n)) w
      join public.shop_products s on s.id = w.product_id
      where s.practitioner_id = v_page.practitioner_id and s.active and s.in_open_shop
        and w.quantity between 1 and 10;
  exception when others then
    return private.refuse('VALIDATION', 'items'); -- not a product id, or not a whole number
  end;
  if v_lines <> jsonb_array_length(p_items)
     or v_lines <> (select count(distinct i ->> 'product_id') from jsonb_array_elements(p_items) i) then
    return private.refuse('VALIDATION', 'items');
  end if;
  insert into public.shop_orders (practitioner_id, items, total_cents)
    values (v_page.practitioner_id, v_items, v_total) returning id into v_id;
  return jsonb_build_object('ok', true, 'order_id', v_id, 'practice', v_page.display_name,
    'items', v_items, 'total_cents', v_total);
end;
$$;
revoke all on function public.start_shop_order(text, jsonb) from public, anon, authenticated;
grant execute on function public.start_shop_order(text, jsonb) to service_role;

-- As on 25 November (one home for the approved version), and the order names its practice.
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
  insert into public.shop_orders (consultation_id, practitioner_id, items, total_cents)
    values (v_consultation.id, v_consultation.practitioner_id, v_items, v_total)
    returning id into v_id;
  return jsonb_build_object('ok', true, 'order_id', v_id, 'consultation_id', v_consultation.id,
    'items', v_items, 'total_cents', v_total);
end;
$$;

-- As on 24 November; an order from the open shop has no consultation (p_consultation_id null), and
-- the consultation's audit trail records only orders of a consultation.
create or replace function public.record_shop_payment(
  p_order_id uuid, p_consultation_id uuid, p_session_id text, p_amount_cents int, p_ship_to jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_order public.shop_orders;
begin
  select * into v_order from public.shop_orders
    where id = p_order_id and consultation_id is not distinct from p_consultation_id for update;
  if not found then return private.refuse('NOT_FOUND'); end if;
  if v_order.status <> 'open' then return jsonb_build_object('ok', true, 'already', true); end if;
  if p_amount_cents is distinct from v_order.total_cents then return private.refuse('VALIDATION', 'amount'); end if;
  update public.shop_orders set status = 'paid', paid_at = now(), stripe_checkout_session_id = p_session_id,
      ship_to = case when jsonb_typeof(p_ship_to) = 'object' and length(p_ship_to::text) <= 2000 then p_ship_to end
    where id = p_order_id;
  if p_consultation_id is not null then
    perform private.log_event(p_consultation_id, 'shop.order_paid', 'stripe', 'payment', 'shop_order', p_order_id, 'success');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.mark_order_sent(p_order_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_order public.shop_orders;
begin
  select * into v_order from public.shop_orders
    where id = p_order_id and practitioner_id = (select auth.uid()) for update;
  if not found then return private.refuse('NOT_FOUND'); end if;
  if v_order.status <> 'paid' then return private.refuse('INVALID_STATE_TRANSITION'); end if;
  update public.shop_orders set status = 'sent', sent_at = now() where id = p_order_id;
  if v_order.consultation_id is not null then
    perform private.log_event(v_order.consultation_id, 'shop.order_sent', (select auth.uid())::text, 'practitioner',
      'shop_order', p_order_id, 'success');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
