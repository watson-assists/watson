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
 * Records a payment only after Stripe says this session is paid for this consultation: its fee, or an
 * order from the practice's shop (owner, 23 Nov) with the address to send it to. Safe to repeat.
 */
export async function fulfill(sessionId: string, consultationId?: string): Promise<boolean> {
  const session = await stripe().checkout.sessions.retrieve(sessionId);
  const id = session.client_reference_id;
  if (!id || (consultationId && id !== consultationId)) return false;
  if (session.payment_status !== "paid") return false;
  const order = session.metadata?.order_id;
  const { data } = order
    ? await admin.rpc("record_shop_payment", {
      p_order_id: order,
      p_consultation_id: id,
      p_session_id: session.id,
      p_amount_cents: session.amount_total,
      p_ship_to: session.collected_information?.shipping_details ?? null,
    })
    : await admin.rpc("record_payment", {
      p_consultation_id: id,
      p_session_id: session.id,
      p_amount_cents: session.amount_total,
    });
  return Boolean(data?.ok);
}
