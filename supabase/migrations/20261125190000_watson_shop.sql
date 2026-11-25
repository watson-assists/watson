-- Watson's shop (owner, 25 November 2026: "allowing a user to go to the shop directly (without being a
-- patient or a shop only for Robin or whatever), with the ability to add to cart and checkout"). One
-- shop, /shop/, with the products every practice put in it; /shop/?p=<page> shows one practice's.
-- One basket is one payment, and each practice gets its own order to send: the orders of one
-- checkout share its id. This replaces the per-practice open shop of this morning
-- (20261125170000), whose functions nothing else uses.

drop function public.open_shop(text);
drop function public.start_shop_order(text, jsonb);

alter table public.shop_orders add column checkout_id uuid;
create index shop_orders_by_checkout on public.shop_orders (checkout_id) where checkout_id is not null;
-- One Stripe payment pays every order of its checkout.
alter table public.shop_orders drop constraint shop_orders_stripe_checkout_session_id_key;

-- Anyone: the products in the shop, with the practice that sells each; with p_slug, one practice's.
create function public.shop_catalog(p_slug text default null) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_page public.practitioner_profiles;
begin
  if p_slug is not null then
    select * into v_page from public.practitioner_profiles where slug = p_slug;
    if not found then return private.refuse('NOT_FOUND'); end if;
  end if;
  return jsonb_build_object('ok', true, 'practice', v_page.display_name, 'products', coalesce((
    select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'description', s.description,
             'price_cents', s.price_cents, 'photo_path', s.photo_path, 'practice', p.display_name, 'slug', p.slug)
             order by s.name, p.display_name)
      from public.shop_products s join public.practitioner_profiles p on p.practitioner_id = s.practitioner_id
      where s.active and s.in_open_shop and (p_slug is null or p.slug = p_slug)), '[]'::jsonb));
end;
$$;
revoke all on function public.shop_catalog(text) from public;
grant execute on function public.shop_catalog(text) to anon, authenticated;

-- The payment function only: a basket, at today's prices, as one order per practice. p_items:
-- [{"product_id": …, "quantity": 1-10}], each product once, all in the shop.
create function public.start_checkout(p_items jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_checkout uuid := gen_random_uuid();
  v_basket jsonb; -- [{practitioner_id, n, cents, item}], in the buyer's order
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 20 then
    return private.refuse('VALIDATION', 'items');
  end if;
  begin
    select jsonb_agg(jsonb_build_object('practitioner_id', s.practitioner_id, 'n', w.n, 'cents', w.quantity * s.price_cents,
             'item', jsonb_build_object('product_id', s.id, 'name', s.name, 'quantity', w.quantity,
                                        'price_cents', s.price_cents, 'photo_path', s.photo_path)) order by w.n)
      into v_basket
      from (select (x.i ->> 'product_id')::uuid as product_id, (x.i ->> 'quantity')::int as quantity, x.n
              from jsonb_array_elements(p_items) with ordinality as x(i, n)) w
      join public.shop_products s on s.id = w.product_id
      join public.practitioner_profiles p on p.practitioner_id = s.practitioner_id
      where s.active and s.in_open_shop and w.quantity between 1 and 10;
  exception when others then
    return private.refuse('VALIDATION', 'items'); -- not a product id, or not a whole number
  end;
  if coalesce(jsonb_array_length(v_basket), 0) <> jsonb_array_length(p_items)
     or jsonb_array_length(v_basket) <> (select count(distinct i ->> 'product_id') from jsonb_array_elements(p_items) i) then
    return private.refuse('VALIDATION', 'items');
  end if;
  insert into public.shop_orders (practitioner_id, checkout_id, items, total_cents)
    select (b ->> 'practitioner_id')::uuid, v_checkout, jsonb_agg(b -> 'item' order by (b ->> 'n')::int), sum((b ->> 'cents')::int)
      from jsonb_array_elements(v_basket) b group by 1;
  return (select jsonb_build_object('ok', true, 'checkout_id', v_checkout,
      'items', jsonb_agg(b -> 'item' order by (b ->> 'n')::int), 'total_cents', sum((b ->> 'cents')::int))
    from jsonb_array_elements(v_basket) b);
end;
$$;
revoke all on function public.start_checkout(jsonb) from public, anon, authenticated;
grant execute on function public.start_checkout(jsonb) to service_role;

-- The payment function and Stripe's webhook: the basket is paid, at its total. Safe to repeat.
create function public.record_checkout_payment(
  p_checkout_id uuid, p_session_id text, p_amount_cents int, p_ship_to jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_open int;
  v_total int;
begin
  select count(*) filter (where status = 'open'), sum(total_cents) into v_open, v_total
    from (select status, total_cents from public.shop_orders where checkout_id = p_checkout_id for update) o;
  if v_total is null then return private.refuse('NOT_FOUND'); end if;
  if v_open = 0 then return jsonb_build_object('ok', true, 'already', true); end if;
  if p_amount_cents is distinct from v_total then return private.refuse('VALIDATION', 'amount'); end if;
  update public.shop_orders set status = 'paid', paid_at = now(), stripe_checkout_session_id = p_session_id,
      ship_to = case when jsonb_typeof(p_ship_to) = 'object' and length(p_ship_to::text) <= 2000 then p_ship_to end
    where checkout_id = p_checkout_id and status = 'open';
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.record_checkout_payment(uuid, text, int, jsonb) from public, anon, authenticated;
grant execute on function public.record_checkout_payment(uuid, text, int, jsonb) to service_role;
