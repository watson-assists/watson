// Patient payment with Stripe Checkout (decision 0007), after Stripe's own guides:
// https://docs.stripe.com/checkout/quickstart and https://docs.stripe.com/checkout/fulfillment
import { Stripe } from "./deps.ts";
import { admin } from "./server.ts";

let client: Stripe | null = null;
/** Made on first use, so a missing key is a refused payment, not a crashed function. */
export function stripe(): Stripe {
  client ??= new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "missing", { httpClient: Stripe.createFetchHttpClient() });
  return client;
}

/**
 * Records a payment only after Stripe says this session is paid: a consultation's fee, an order from
 * the practice's shop on the patient's link (owner, 23 Nov), or a basket from Watson's shop (25 Nov:
 * no consultation), with the address and email to send it to. With `consultationId`, only a session
 * of that consultation counts. Safe to repeat.
 */
export async function fulfill(sessionId: string, consultationId?: string): Promise<boolean> {
  const session = await stripe().checkout.sessions.retrieve(sessionId);
  const id = session.client_reference_id; // the consultation; for Watson's shop, the checkout
  if (!id || (consultationId && id !== consultationId)) return false;
  if (session.payment_status !== "paid") return false;
  const order = session.metadata?.order_id;
  const shipTo = session.collected_information?.shipping_details;
  const sendTo = shipTo ? { ...shipTo, email: session.customer_details?.email ?? null } : null;
  if (session.metadata?.checkout_id) {
    const { data: basket } = await admin.rpc("record_checkout_payment", { p_checkout_id: session.metadata.checkout_id,
      p_session_id: session.id, p_amount_cents: session.amount_total, p_ship_to: sendTo });
    return Boolean(basket?.ok);
  }
  const { data } = order
    ? await admin.rpc("record_shop_payment", {
      p_order_id: order,
      p_consultation_id: session.metadata?.consultation_id ?? null,
      p_session_id: session.id,
      p_amount_cents: session.amount_total,
      p_ship_to: sendTo,
    })
    : await admin.rpc("record_payment", {
      p_consultation_id: id,
      p_session_id: session.id,
      p_amount_cents: session.amount_total,
    });
  return Boolean(data?.ok);
}
