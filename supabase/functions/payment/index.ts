// The patient's page calls this with its link token: to pay the consultation, to buy the products
// their practitioner prescribed (owner, 23 Nov: Watson's own shop), or, back from Stripe, to confirm
// either. The token is the only credential; it names one consultation. The practice's open shop
// (owner, 25 Nov) calls it with the practice's page instead: anyone may buy what is in it.
import { fulfill, stripe } from "../_shared/payment.ts";
import { admin, env, reply, SITES } from "../_shared/server.ts";

const TOKEN = /^[0-9a-f]{64}$/;
const SESSION = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
// Where the practices send what patients buy: the European Union and its neighbours.
const SHIP_TO = ["AT", "BE", "BG", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GB", "GR", "HR", "HU", "IE", "IT",
  "LT", "LU", "LV", "MT", "NL", "NO", "PL", "PT", "RO", "SE", "SI", "SK"] as const;
type Item = { name: string; quantity: number; price_cents: number; photo_path: string | null };
type Input = { token?: unknown; session_id?: unknown; items?: unknown; shop?: unknown };

/** Stripe's page for products, with the address to send them to; back to `back` either way. */
function shopCheckout(items: Item[], reference: string, metadata: Record<string, string>, back: string) {
  const photo = (path: string | null) => path ? [`${env("SUPABASE_URL")}/storage/v1/object/public/shop/${path}`] : undefined;
  return stripe().checkout.sessions.create({
    mode: "payment",
    line_items: items.map((item) => ({
      quantity: item.quantity,
      price_data: { currency: "eur", unit_amount: item.price_cents, product_data: { name: item.name, images: photo(item.photo_path) } },
    })),
    shipping_address_collection: { allowed_countries: [...SHIP_TO] },
    client_reference_id: reference,
    metadata,
    success_url: `${back}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${back}&cancelled=1`,
  });
}

/** The open shop: buys what the practice put in it (the database checks every item and price), or confirms. */
async function openShop(origin: string, input: Input): Promise<Response> {
  const slug = typeof input.shop === "string" && SLUG.test(input.shop) ? input.shop : null;
  if (!slug) return reply(origin, 400, { error: "VALIDATION" });
  if (input.session_id !== undefined) {
    if (typeof input.session_id !== "string" || !SESSION.test(input.session_id)) return reply(origin, 400, { error: "VALIDATION" });
    return reply(origin, 200, { paid: await fulfill(input.session_id) });
  }
  const { data: order } = await admin.rpc("start_shop_order", { p_slug: slug, p_items: input.items ?? null });
  if (!order?.ok) return reply(origin, 409, { error: order?.error_category ?? "VALIDATION" });
  const session = await shopCheckout(order.items, order.order_id, { order_id: order.order_id }, `${origin}/shop/?p=${slug}`);
  return reply(origin, 200, { url: session.url });
}

function unavailable(origin: string, error: unknown) {
  // Stripe's message never reaches the buyer; its type goes to the function log.
  console.error("payment failed", error instanceof Error ? error.name : "unknown");
  return reply(origin, 502, { error: "PAYMENT_UNAVAILABLE" });
}

Deno.serve(async (request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") return reply(origin, 204, null);
  if (request.method !== "POST" || !origin || !SITES.includes(origin)) return reply(origin, 403, { error: "FORBIDDEN" });

  let input: Input;
  try {
    input = await request.json();
  } catch {
    return reply(origin, 400, { error: "VALIDATION" });
  }
  if (input.shop !== undefined) return await openShop(origin, input).catch((error) => unavailable(origin, error));
  const token = typeof input.token === "string" && TOKEN.test(input.token) ? input.token : null;
  if (!token) return reply(origin, 400, { error: "VALIDATION" });

  const { data: consultation } = await admin.from("consultations")
    .select("id, fee_cents, paid_at, status, hold_until").eq("invite_token", token).maybeSingle();
  if (!consultation || consultation.status === "consent_withdrawn") return reply(origin, 404, { error: "NOT_FOUND" });

  try {
    if (input.session_id !== undefined) {
      // Back from Stripe: fulfil here as well as in the webhook, as Stripe recommends.
      if (typeof input.session_id !== "string" || !SESSION.test(input.session_id)) return reply(origin, 400, { error: "VALIDATION" });
      return reply(origin, 200, { paid: await fulfill(input.session_id, consultation.id) });
    }
    if (input.items !== undefined) {
      const ids = Array.isArray(input.items) && input.items.length >= 1 && input.items.length <= 20
        && input.items.every((id) => typeof id === "string" && UUID.test(id)) ? input.items as string[] : null;
      if (!ids) return reply(origin, 400, { error: "VALIDATION" });
      const { data: order } = await admin.rpc("open_shop_order", { p_token: token, p_item_ids: ids });
      if (!order?.ok) return reply(origin, 409, { error: order?.error_category ?? "VALIDATION" });
      const session = await shopCheckout(order.items, consultation.id,
        { consultation_id: consultation.id, order_id: order.order_id }, `${origin}/join/?t=${token}`);
      return reply(origin, 200, { url: session.url });
    }
    if (consultation.fee_cents === null) return reply(origin, 409, { error: "NO_FEE" });
    if (consultation.paid_at) return reply(origin, 409, { error: "ALREADY_PAID" });
    // A booked time is held while the patient pays; Stripe's page closes when the hold ends.
    let expiresAt: number | undefined;
    if (consultation.hold_until) {
      const { data: hold } = await admin.rpc("renew_hold", { p_token: token });
      if (!hold?.ok) return reply(origin, 409, { error: hold?.error_category ?? "TIME_TAKEN" });
      expiresAt = Math.floor(Date.parse(hold.hold_until) / 1000);
    }

    const session = await stripe().checkout.sessions.create({
      mode: "payment",
      line_items: [{
        quantity: 1,
        price_data: { currency: "eur", unit_amount: consultation.fee_cents, product_data: { name: "Consultation" } },
      }],
      client_reference_id: consultation.id,
      metadata: { consultation_id: consultation.id },
      expires_at: expiresAt,
      success_url: `${origin}/join/?t=${token}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/join/?t=${token}&cancelled=1`,
    });
    return reply(origin, 200, { url: session.url });
  } catch (error) {
    return unavailable(origin, error);
  }
});
