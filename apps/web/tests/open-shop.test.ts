// Watson's shop (owner, 25 Nov: "allowing a user to go to the shop directly, without being a patient
// ... with the ability to add to cart and checkout"): one shop with the products every practice put in
// it (never those they only prescribe), one basket and one payment, and each practice gets its own
// order to send.
import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, browserClient, localStack, newPractitioner, rpc, type Practitioner } from "./local-stack";

const stack = localStack();
let eva: Practitioner;
let finn: Practitioner;
const slugs: Record<string, string> = {};
const ids: Record<string, string> = {};

async function practice(who: Practitioner, name: string) {
  const saved = await rpc(who.client, "save_booking_page", { p_display_name: name, p_offer: "", p_about: "",
    p_languages: ["en"], p_hours: {}, p_length_minutes: 45, p_gap_minutes: 15, p_fee_cents: null });
  return saved.slug as unknown as string;
}
async function product(who: Practitioner, name: string, cents: number, inShop: boolean) {
  ids[name] = (await rpc(who.client, "save_shop_product", { p_id: null, p_name: name, p_description: `${name}, one pack.`,
    p_price_cents: cents, p_photo_path: null, p_active: true, p_in_open_shop: inShop })).id as string;
}

beforeAll(async () => {
  [eva, finn] = await Promise.all([newPractitioner(stack, "shop-eva"), newPractitioner(stack, "shop-finn")]);
  slugs.eva = await practice(eva, "Dr. Eva Shop");
  slugs.finn = await practice(finn, "Dr. Finn Shop");
  await product(eva, "Tulsi tea", 650, true);
  await product(eva, "Triphala", 900, false); // only prescribed
  await product(eva, "Old balm", 500, true);
  await rpc(eva.client, "save_shop_product", { p_id: ids["Old balm"], p_name: "Old balm", p_description: "",
    p_price_cents: 500, p_photo_path: null, p_active: false }); // hidden; stays in the shop once shown again
  await product(finn, "Neem oil", 1200, true);
});

const line = (name: string, practice: string, slug: string, cents: number) => ({
  id: ids[name], name, description: `${name}, one pack.`, price_cents: cents, photo_path: null, practice, slug,
});

describe("Watson's shop", () => {
  it("shows anyone every practice's products in it, or one practice's", async () => {
    const anyone = browserClient(stack);
    const all = (await anyone.rpc("shop_catalog", {})).data as { ok: boolean; products: { id: string }[] };
    expect(all.ok).toBe(true);
    expect(all.products).toEqual(expect.arrayContaining([
      line("Tulsi tea", "Dr. Eva Shop", slugs.eva, 650), line("Neem oil", "Dr. Finn Shop", slugs.finn, 1200),
    ]));
    expect(all.products.map((p) => p.id)).not.toContain(ids.Triphala);
    expect(all.products.map((p) => p.id)).not.toContain(ids["Old balm"]);
    expect((await anyone.rpc("shop_catalog", { p_slug: slugs.eva })).data).toEqual({
      ok: true, practice: "Dr. Eva Shop", products: [line("Tulsi tea", "Dr. Eva Shop", slugs.eva, 650)],
    });
    expect((await anyone.rpc("shop_catalog", { p_slug: "no-such-practice" })).data).toMatchObject({ ok: false, error_category: "NOT_FOUND" });
    expect((await eva.client.from("shop_products").select("in_open_shop").eq("id", ids["Old balm"]).single()).data).toEqual({ in_open_shop: true });
  });

  it("checks out one basket through the payment function, and each practice sends its part", async () => {
    const server = adminClient(stack);
    const start = async (items: { product_id: string; quantity: number }[]) =>
      (await server.rpc("start_checkout", { p_items: items })).data as Record<string, unknown>;
    expect((await browserClient(stack).rpc("start_checkout", { p_items: [{ product_id: ids["Tulsi tea"], quantity: 1 }] })).error).not.toBeNull();
    for (const wrong of [[], [{ product_id: ids.Triphala, quantity: 1 }], [{ product_id: ids["Old balm"], quantity: 1 }],
      [{ product_id: ids["Tulsi tea"], quantity: 0 }], [{ product_id: ids["Tulsi tea"], quantity: 11 }],
      [{ product_id: ids["Tulsi tea"], quantity: 1 }, { product_id: ids["Tulsi tea"], quantity: 1 }]]) {
      expect(await start(wrong)).toMatchObject({ ok: false, error_category: "VALIDATION", field: "items" });
    }
    const checkout = await start([{ product_id: ids["Tulsi tea"], quantity: 3 }, { product_id: ids["Neem oil"], quantity: 1 }]);
    expect(checkout).toMatchObject({ ok: true, total_cents: 3150, items: [
      { product_id: ids["Tulsi tea"], name: "Tulsi tea", quantity: 3, price_cents: 650, photo_path: null },
      { product_id: ids["Neem oil"], name: "Neem oil", quantity: 1, price_cents: 1200, photo_path: null },
    ] });

    const pay = async (amount: number) => (await server.rpc("record_checkout_payment", {
      p_checkout_id: checkout.checkout_id as string, p_session_id: `cs_test_${crypto.randomUUID().replaceAll("-", "")}`,
      p_amount_cents: amount, p_ship_to: { name: "Jana Nováková", email: "jana@example.com", address: { city: "Bratislava", country: "SK" } },
    })).data;
    expect(await pay(1950)).toMatchObject({ ok: false, field: "amount" });
    expect(await pay(3150)).toEqual({ ok: true });
    expect(await pay(3150)).toEqual({ ok: true, already: true });

    const mine = (await eva.client.from("shop_orders").select("id, status, total_cents, consultation_id, ship_to, items").eq("checkout_id", checkout.checkout_id as string)).data!;
    expect(mine).toMatchObject([{ status: "paid", total_cents: 1950, consultation_id: null,
      ship_to: { name: "Jana Nováková", email: "jana@example.com" }, items: [{ name: "Tulsi tea", quantity: 3 }] }]);
    const finns = (await finn.client.from("shop_orders").select("id, total_cents, items").eq("checkout_id", checkout.checkout_id as string)).data!;
    expect(finns).toMatchObject([{ total_cents: 1200, items: [{ name: "Neem oil", quantity: 1 }] }]);
    expect(await rpc(finn.client, "mark_order_sent", { p_order_id: mine[0].id })).toMatchObject({ ok: false, error_category: "NOT_FOUND" });
    expect(await rpc(eva.client, "mark_order_sent", { p_order_id: mine[0].id })).toEqual({ ok: true });
  });
});
