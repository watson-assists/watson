// Changing a form after it was approved (owner's test team, 23 Nov, point 5; owner: only the doctor who
// approved it). Every change is a new version, approved again; earlier versions stay as they were, and
// the patient sees the latest approved one, with the medicines kept with it.
import { beforeAll, describe, expect, it } from "vitest";
import { browserClient, localStack, newPractitioner, rpc, sqlAsOwner, type Practitioner } from "./local-stack";

const stack = localStack();
let eva: Practitioner;
let finn: Practitioner;
beforeAll(async () => {
  [eva, finn] = await Promise.all([newPractitioner(stack, "versions-eva"), newPractitioner(stack, "versions-finn")]);
});

const edit = (formId: unknown, key: string, text: string) =>
  rpc(eva.client, "review_form_answer", { p_form_id: formId, p_field_key: key, p_decision: "edit", p_text: text });

/** An approved form the doctor wrote, with one medicine. */
async function approved() {
  const made = await rpc(eva.client, "create_consultation", { p_scheduled_at: "2026-11-24T09:00:00Z", p_language: "en", p_consent_recorded: false });
  const id = made.consultation_id as string;
  const form = await rpc(eva.client, "start_form_without_recording", { p_consultation_id: id, p_by_watson: false });
  await edit(form.id, "main_concern", "Wakes at three every night");
  const tea = await rpc(eva.client, "save_shop_product", { p_id: null, p_name: "Tulsi tea", p_description: "", p_price_cents: 650, p_photo_path: null, p_active: true });
  await rpc(eva.client, "prescribe", { p_consultation_id: id, p_product_id: tea.id, p_quantity: 2, p_instructions: "After dinner" });
  expect(await rpc(eva.client, "approve_form", { p_form_id: form.id })).toEqual({ ok: true });
  const token = sqlAsOwner(`select invite_token from public.consultations where id = '${id}';`);
  return { id, first: form.id as string, token };
}
const status = (id: string) => sqlAsOwner(`select status from public.consultations where id = '${id}';`);
const said = (formId: string) => sqlAsOwner(`select coalesce(practitioner_text, machine_text) from public.form_answers
  where form_id = '${formId}' and field_key = 'main_concern';`);
type Shown = { report: { answers: { field_key: string; practitioner_text: string | null }[]; prescriptions: { name: string; available: boolean }[] } };
const patientSees = async (token: string) => {
  const { report } = await rpc(browserClient(stack), "patient_report", { p_token: token }) as unknown as Shown;
  return { concern: report.answers.find((answer) => answer.field_key === "main_concern")?.practitioner_text,
    medicines: report.prescriptions.map((item) => `${item.name}${item.available ? "" : " (gone)"}`) };
};

describe("changing an approved form", () => {
  it("is the approving doctor's alone, makes a new version, and keeps the earlier one as it was", async () => {
    const { id, first } = await approved();
    expect(await rpc(finn.client, "start_form_change", { p_consultation_id: id })).toMatchObject({ ok: false, error_category: "NOT_FOUND" });
    const change = await rpc(eva.client, "start_form_change", { p_consultation_id: id });
    expect(change).toMatchObject({ ok: true });
    expect(status(id)).toBe("under_review");
    expect(sqlAsOwner(`select revision_number || ' ' || status || ' ' || (parent_form_id = '${first}') from public.forms where id = '${change.form_id}';`))
      .toBe("2 draft true");
    expect(said(change.form_id as string)).toBe("Wakes at three every night");
    expect(await rpc(eva.client, "start_form_change", { p_consultation_id: id })).toMatchObject({ ok: false, error_category: "INVALID_STATE_TRANSITION" });
    expect(await edit(change.form_id, "main_concern", "Sleeps through since the new routine")).toEqual({ ok: true });
    expect(await rpc(eva.client, "approve_form", { p_form_id: change.form_id })).toEqual({ ok: true });
    expect(status(id)).toBe("approved");
    expect([said(first), said(change.form_id as string)]).toEqual(["Wakes at three every night", "Sleeps through since the new routine"]);
    expect(sqlAsOwner(`select string_agg(revision_number || ':' || status || ':' || (approved_by = '${eva.id}'), ' ' order by revision_number)
      from public.forms where consultation_id = '${id}';`)).toBe("1:approved:true 2:approved:true");
  });

  it("is refused to anyone but the doctor who approved it", async () => {
    const { id, first } = await approved();
    sqlAsOwner(`set session_replication_role = replica; update public.forms set approved_by = '${finn.id}' where id = '${first}';`);
    expect(await rpc(eva.client, "start_form_change", { p_consultation_id: id })).toMatchObject({ ok: false, error_category: "NOT_THE_APPROVER" });
  });

  it("reaches the patient only once approved, medicines too; discarded, it never does", async () => {
    const { id, token } = await approved();
    expect(await patientSees(token)).toEqual({ concern: "Wakes at three every night", medicines: ["Tulsi tea"] });
    const change = await rpc(eva.client, "start_form_change", { p_consultation_id: id });
    await edit(change.form_id, "main_concern", "Better, still wakes at five");
    const item = sqlAsOwner(`select id from public.prescription_items where consultation_id = '${id}';`);
    expect(await rpc(eva.client, "unprescribe", { p_item_id: item })).toEqual({ ok: true });
    const oil = await rpc(eva.client, "save_shop_product", { p_id: null, p_name: "Brahmi oil", p_description: "", p_price_cents: 1200, p_photo_path: null, p_active: true });
    await rpc(eva.client, "prescribe", { p_consultation_id: id, p_product_id: oil.id, p_quantity: 1, p_instructions: "On the scalp at night" });
    expect(await patientSees(token)).toEqual({ concern: "Wakes at three every night", medicines: ["Tulsi tea (gone)"] });
    await rpc(eva.client, "approve_form", { p_form_id: change.form_id });
    expect(await patientSees(token)).toEqual({ concern: "Better, still wakes at five", medicines: ["Brahmi oil"] });

    const discarded = await rpc(eva.client, "start_form_change", { p_consultation_id: id });
    await edit(discarded.form_id, "main_concern", "Never sent");
    expect(await rpc(eva.client, "reject_form_revision", { p_form_id: discarded.form_id })).toEqual({ ok: true });
    expect(status(id)).toBe("approved");
    expect(await patientSees(token)).toEqual({ concern: "Better, still wakes at five", medicines: ["Brahmi oil"] });
  });
});
