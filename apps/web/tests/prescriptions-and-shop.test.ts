// The third part of the record (owner, 23 Nov): the prescriptions, from a simple shop of the doctor's
// own, and the patient's own page on their link: once the form is approved, their report, the
// instructions and the products to buy. Never the intake, the conversation or the doctor's own notes.
import { beforeAll, describe, expect, it } from "vitest";
import { forPatient, type FormTemplate } from "../src/lib/export";
import { adminClient, browserClient, localStack, newEngine, newPractitioner, rpc, sqlAsOwner, type Practitioner } from "./local-stack";

const stack = localStack();
let eva: Practitioner;
let finn: Practitioner;
let engine: Practitioner;
beforeAll(async () => {
  [eva, finn, engine] = await Promise.all([
    newPractitioner(stack, "shop-eva"), newPractitioner(stack, "shop-finn"), newEngine(stack, "shop-engine"),
  ]);
});

const product = (who: Practitioner, name: string, price = 1290, extra: { id?: string; active?: boolean; photo?: string } = {}) =>
  rpc(who.client, "save_shop_product", {
    p_id: extra.id ?? null, p_name: name, p_description: "Ashwagandha root, 60 capsules.", p_price_cents: price,
    p_photo_path: extra.photo ?? null, p_active: extra.active ?? true,
  });

/** A consultation with a form the doctor wrote: age, main concern, assessment, routine, safety and private notes. */
async function written() {
  const made = await rpc(eva.client, "create_consultation", { p_scheduled_at: "2026-11-24T09:00:00Z", p_language: "en", p_consent_recorded: false });
  const id = made.consultation_id as string;
  const form = await rpc(eva.client, "start_form_without_recording", { p_consultation_id: id, p_by_watson: false });
  for (const [key, text] of [["age", "42"], ["main_concern", "Wakes at three every night"], ["assessment", "Vata imbalance"],
    ["daily_routine", "Warm water on waking"], ["safety", "Check blood pressure"], ["private_notes", "Seems anxious about work"]]) {
    expect(await rpc(eva.client, "review_form_answer", { p_form_id: form.id, p_field_key: key, p_decision: "edit", p_text: text })).toEqual({ ok: true });
  }
  const token = sqlAsOwner(`select invite_token from public.consultations where id = '${id}';`);
  return { id, formId: form.id as string, token };
}
const approve = (formId: string) => rpc(eva.client, "approve_form", { p_form_id: formId });
const report = async (token: string) => (await rpc(browserClient(stack), "patient_report", { p_token: token })) as {
  ok: boolean; report: null | { template: FormTemplate; answers: { field_key: string }[];
    prescriptions: { id: string; name: string; price_cents: number; quantity: number; instructions: string; available: boolean }[];
    orders: { status: string; total_cents: number }[] };
};

describe("the doctor's shop", () => {
  it("is their own: their products, prices and photos, nobody else's", async () => {
    const made = await product(eva, "Ashwagandha");
    expect(made).toMatchObject({ ok: true });
    expect(await product(eva, "Too cheap", 10)).toMatchObject({ ok: false, field: "price" });
    expect(await product(eva, "Someone's photo", 1290, { photo: `${finn.id}/${crypto.randomUUID()}.jpg` })).toMatchObject({ ok: false, field: "photo" });
    expect(await product(eva, "Ashwagandha", 1490, { id: made.id as string, photo: `${eva.id}/${crypto.randomUUID()}.jpg` })).toMatchObject({ ok: true });
    expect((await finn.client.from("shop_products").select("id").eq("id", made.id as string)).data).toEqual([]);
    expect(await product(finn, "Taken over", 1290, { id: made.id as string })).toMatchObject({ ok: false, error_category: "NOT_FOUND" });
    expect(await product(engine, "Not a practitioner")).toMatchObject({ ok: false, error_category: "NOT_FOUND" });
  });
});

describe("prescriptions", () => {
  it("are products of the doctor's own shop, changed until the form is approved", async () => {
    const { id, formId } = await written();
    const own = await product(eva, "Triphala");
    const hidden = await product(eva, "Old tea", 900, { active: false });
    const theirs = await product(finn, "Finn's oil");
    const prescribe = (productId: unknown, quantity = 1) =>
      rpc(eva.client, "prescribe", { p_consultation_id: id, p_product_id: productId, p_quantity: quantity, p_instructions: "Two at night" });
    expect(await prescribe(theirs.id)).toMatchObject({ ok: false, error_category: "NOT_FOUND" });
    expect(await prescribe(hidden.id)).toMatchObject({ ok: false, error_category: "NOT_FOUND" });
    expect(await prescribe(own.id, 50)).toMatchObject({ ok: false, field: "quantity" });
    const kept = await prescribe(own.id, 2);
    const dropped = await prescribe(own.id);
    expect(await rpc(eva.client, "unprescribe", { p_item_id: dropped.id })).toEqual({ ok: true });
    expect(await rpc(finn.client, "unprescribe", { p_item_id: kept.id })).toMatchObject({ ok: false, error_category: "NOT_FOUND" });
    expect(await approve(formId)).toEqual({ ok: true });
    expect(await prescribe(own.id)).toMatchObject({ ok: false, error_category: "INVALID_STATE_TRANSITION" });
    expect(await rpc(eva.client, "unprescribe", { p_item_id: kept.id })).toMatchObject({ ok: false, error_category: "INVALID_STATE_TRANSITION" });
  });
});

describe("the patient's own page", () => {
  it("shows nothing until the form is approved, then the report, instructions and products, never the intake or notes", async () => {
    const { id, formId, token } = await written();
    const tea = await product(eva, "Tulsi tea", 650);
    await rpc(eva.client, "prescribe", { p_consultation_id: id, p_product_id: tea.id, p_quantity: 2, p_instructions: "A cup after dinner" });
    expect(await report(token)).toEqual({ ok: true, report: null });
    await approve(formId);
    const { report: shown } = await report(token);
    const keys = shown!.template.sections.flatMap((section) => section.fields.map((field) => field.key));
    expect(keys).toEqual(expect.arrayContaining(["main_concern", "assessment", "therapies", "review", "daily_routine"]));
    expect(keys).not.toEqual(expect.arrayContaining(["age"]));
    for (const hidden of ["age", "safety", "private_notes", "sleep"]) expect(keys).not.toContain(hidden);
    expect(JSON.stringify(shown)).not.toMatch(/Seems anxious|Check blood pressure|"42"/);
    expect(shown!.answers.map((answer) => answer.field_key).sort()).toEqual(["assessment", "daily_routine", "main_concern"]);
    expect(shown!.prescriptions).toMatchObject([{ name: "Tulsi tea", price_cents: 650, quantity: 2, instructions: "A cup after dinner", available: true }]);
    // The same rule as the doctor's "Print for the patient" (apps/web/src/lib/export.ts).
    const template = JSON.parse(sqlAsOwner(`select template from public.forms where id = '${formId}';`)) as FormTemplate;
    expect(keys).toEqual(forPatient(template).sections.flatMap((section) => section.fields.map((field) => field.key)));
    expect(await rpc(browserClient(stack), "patient_report", { p_token: "0".repeat(64) })).toMatchObject({ ok: false, error_category: "NOT_FOUND" });
  });
});

describe("an order", () => {
  it("is opened only by the payment function, paid at its own total, and sent by the doctor", async () => {
    const { id, formId, token } = await written();
    const tea = await product(eva, "Tulsi tea", 650);
    const item = await rpc(eva.client, "prescribe", { p_consultation_id: id, p_product_id: tea.id, p_quantity: 2, p_instructions: "" });
    const server = adminClient(stack);
    const open = async (items: unknown[]) => (await server.rpc("open_shop_order", { p_token: token, p_item_ids: items as string[] })).data as Record<string, unknown>;
    expect(await open([item.id])).toMatchObject({ ok: false, error_category: "INVALID_STATE_TRANSITION" });
    await approve(formId);
    expect((await browserClient(stack).rpc("open_shop_order", { p_token: token, p_item_ids: [item.id as string] })).error).not.toBeNull();
    expect(await open([crypto.randomUUID()])).toMatchObject({ ok: false, field: "items" });
    const order = await open([item.id]);
    expect(order).toMatchObject({ ok: true, total_cents: 1300 });
    const pay = async (amount: number) => (await server.rpc("record_shop_payment", {
      p_order_id: order.order_id as string, p_consultation_id: id, p_session_id: `cs_test_${crypto.randomUUID().replaceAll("-", "")}`,
      p_amount_cents: amount, p_ship_to: { name: "Jana Nováková", address: { city: "Bratislava", country: "SK" } },
    })).data;
    expect(await pay(650)).toMatchObject({ ok: false, field: "amount" });
    expect(await pay(1300)).toEqual({ ok: true });
    expect(await pay(1300)).toEqual({ ok: true, already: true });
    expect((await report(token)).report!.orders).toMatchObject([{ status: "paid", total_cents: 1300 }]);
    expect((await eva.client.from("shop_orders").select("ship_to").eq("id", order.order_id as string).single()).data)
      .toEqual({ ship_to: { name: "Jana Nováková", address: { city: "Bratislava", country: "SK" } } });
    expect(await rpc(finn.client, "mark_order_sent", { p_order_id: order.order_id })).toMatchObject({ ok: false, error_category: "NOT_FOUND" });
    expect(await rpc(eva.client, "mark_order_sent", { p_order_id: order.order_id })).toEqual({ ok: true });
    expect(await rpc(eva.client, "mark_order_sent", { p_order_id: order.order_id })).toMatchObject({ ok: false, error_category: "INVALID_STATE_TRANSITION" });
  });
});
