// The practice's open shop (owner, 25 Nov: "the link directly to the store"): a link anyone can open,
// with the products the doctor put in it (never those they only prescribe), bought without a
// consultation through the payment function, and sent by the doctor like any other order.
import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, browserClient, localStack, newPractitioner, rpc, type Practitioner } from "./local-stack";

const stack = localStack();
let eva: Practitioner;
let finn: Practitioner;
let slug: string;
const ids: Record<string, string> = {};
beforeAll(async () => {
  [eva, finn] = await Promise.all([newPractitioner(stack, "open-shop-eva"), newPractitioner(stack, "open-shop-finn")]);
  ({ slug } = await rpc(eva.client, "save_booking_page", {
    p_display_name: "Dr. Eva Shop", p_offer: "", p_about: "", p_languages: ["en"], p_hours: {},
    p_length_minutes: 45, p_gap_minutes: 15, p_fee_cents: null,
  }) as unknown as { slug: string });
  for (const [name, open] of [["Tulsi tea", true], ["Triphala", false], ["Old balm", true]] as const) {
    const saved = await rpc(eva.client, "save_shop_product", { p_id: null, p_name: name, p_description: `${name}, 60 g.`,
      p_price_cents: 650, p_photo_path: null, p_active: true, p_in_open_shop: open });
    ids[name] = saved.id as string;
  }
  await rpc(eva.client, "save_shop_product", { p_id: ids["Old balm"], p_name: "Old balm", p_description: "",
    p_price_cents: 650, p_photo_path: null, p_active: false }); // hidden; still in the open shop once shown again
  ids.finns = (await rpc(finn.client, "save_shop_product", { p_id: null, p_name: "Finn's oil", p_description: "",
    p_price_cents: 900, p_photo_path: null, p_active: true, p_in_open_shop: true })).id as string;
});

describe("the open shop", () => {
  it("shows anyone the doctor's name and the products they put in it, shown and not hidden", async () => {
    const anyone = browserClient(stack);
    const { data } = await anyone.rpc("open_shop", { p_slug: slug });
    expect(data).toEqual({ ok: true, practice: "Dr. Eva Shop", products: [
      { id: ids["Tulsi tea"], name: "Tulsi tea", description: "Tulsi tea, 60 g.", price_cents: 650, photo_path: null },
    ] });
    expect((await anyone.rpc("open_shop", { p_slug: "no-such-practice" })).data).toMatchObject({ ok: false, error_category: "NOT_FOUND" });
    expect((await eva.client.from("shop_products").select("in_open_shop").eq("id", ids["Old balm"]).single()).data).toEqual({ in_open_shop: true });
  });

  it("takes orders only through the payment function, for what is in it, and the doctor sends them", async () => {
    const server = adminClient(stack);
    const start = async (items: { product_id: string; quantity: number }[]) => (await server.rpc("start_shop_order", { p_slug: slug, p_items: items })).data as Record<string, unknown>;
    expect((await browserClient(stack).rpc("start_shop_order", { p_slug: slug, p_items: [{ product_id: ids["Tulsi tea"], quantity: 1 }] })).error).not.toBeNull();
    for (const wrong of [[], [{ product_id: ids.Triphala, quantity: 1 }], [{ product_id: ids["Old balm"], quantity: 1 }],
      [{ product_id: ids.finns, quantity: 1 }], [{ product_id: ids["Tulsi tea"], quantity: 0 }], [{ product_id: ids["Tulsi tea"], quantity: 11 }],
      [{ product_id: ids["Tulsi tea"], quantity: 1 }, { product_id: ids["Tulsi tea"], quantity: 1 }]]) {
      expect(await start(wrong)).toMatchObject({ ok: false, error_category: "VALIDATION", field: "items" });
    }
    const order = await start([{ product_id: ids["Tulsi tea"], quantity: 3 }]);
    expect(order).toMatchObject({ ok: true, total_cents: 1950, practice: "Dr. Eva Shop",
      items: [{ product_id: ids["Tulsi tea"], name: "Tulsi tea", quantity: 3, price_cents: 650, photo_path: null }] });

    const pay = async (amount: number) => (await server.rpc("record_shop_payment", {
      p_order_id: order.order_id as string, p_consultation_id: null, p_session_id: `cs_test_${crypto.randomUUID().replaceAll("-", "")}`,
      p_amount_cents: amount, p_ship_to: { name: "Jana Nováková", email: "jana@example.com", address: { city: "Bratislava", country: "SK" } },
    })).data;
    expect(await pay(650)).toMatchObject({ ok: false, field: "amount" });
    expect(await pay(1950)).toEqual({ ok: true });
    expect((await eva.client.from("shop_orders").select("status, consultation_id, ship_to").eq("id", order.order_id as string).single()).data)
      .toEqual({ status: "paid", consultation_id: null, ship_to: { name: "Jana Nováková", email: "jana@example.com", address: { city: "Bratislava", country: "SK" } } });
    expect((await finn.client.from("shop_orders").select("id").eq("id", order.order_id as string)).data).toEqual([]);
    expect(await rpc(finn.client, "mark_order_sent", { p_order_id: order.order_id })).toMatchObject({ ok: false, error_category: "NOT_FOUND" });
    expect(await rpc(eva.client, "mark_order_sent", { p_order_id: order.order_id })).toEqual({ ok: true });
  });
});
