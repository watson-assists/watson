// Withdrawing consent stops all of Watson's work on the consultation (security review SEC-06, 18 Oct)
// and always succeeds while it is allowed, whatever forms were made before (found 17 Nov).
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { browserClient, claimFormJob, localStack, newEngine, newPractitioner, rpc, sqlAsOwner, transcriptWithFormJob, type Practitioner } from "./local-stack";

const stack = localStack();
const PDF = Buffer.from("%PDF-1.4\n% a tiny stand-in for a lab report\n%%EOF\n");
const TEMPLATE = JSON.parse(readFileSync(new URL("../../../packages/test-fixtures/templates/ayurveda-intake.json", import.meta.url), "utf8"));
const KEYS = (TEMPLATE.sections as { fields: { key: string }[] }[]).flatMap((s) => s.fields.map((f) => f.key));

let eva: Practitioner;
let engine: Practitioner;
beforeAll(async () => {
  [eva, engine] = await Promise.all([newPractitioner(stack, "withdraw"), newEngine(stack, "withdraw-engine")]);
  expect(await rpc(eva.client, "set_form_template", { p_definition: TEMPLATE })).toEqual({ ok: true });
});

async function consultation() {
  const made = await rpc(eva.client, "create_consultation", {
    p_synthetic_patient_ref: "SYN-0301", p_scheduled_at: "2026-11-20T07:30:00Z", p_language: "en", p_consent_recorded: true,
  });
  const { data } = await eva.client.from("consultations").select("id, invite_token").eq("id", made.consultation_id!).single();
  return data!;
}

async function sendDocument(token: string) {
  const visitor = browserClient(stack);
  const contact = `+4219${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`;
  expect(await rpc(visitor, "patient_identify", { p_token: token, p_name: "Jana Nováková", p_contact: contact })).toMatchObject({ ok: true });
  const added = await rpc(visitor, "patient_add_document", {
    p_token: token, p_file_name: "Blood test.pdf", p_media_type: "application/pdf", p_size_bytes: PDF.length,
  });
  expect((await visitor.storage.from("documents").upload(added.path as string, PDF, { contentType: "application/pdf" })).error).toBeNull();
  expect(await rpc(visitor, "patient_confirm_document", { p_token: token, p_document_id: added.document_id })).toEqual({ ok: true });
  return { id: added.document_id as string, path: added.path as string };
}

type Claimed = { document_id: string; attempt: number; storage_path: string } | null;
/** Claims documents until this one comes, setting older ones aside; null when it never comes. */
async function claim(documentId: string): Promise<Claimed> {
  for (let i = 0; i < 50; i++) {
    const { document } = await rpc(engine.client, "engine_claim_document") as unknown as { document: Claimed };
    if (!document) return null;
    if (document.document_id === documentId) return document;
    await rpc(engine.client, "engine_fail_document", { p_document_id: document.document_id, p_attempt: document.attempt, p_error_category: "DOCUMENT_FAILED" });
  }
  return null;
}

async function fill(consultationId: string, text: string) {
  const job = await claimFormJob(engine, consultationId);
  const answers = KEYS.map((key) => ({ key, text: `${text} ${key}`, evidence: [0] }));
  expect(await rpc(engine.client, "engine_complete_form_job", { p_job_id: job.job_id, p_attempt: job.attempt, p_answers: answers })).toMatchObject({ ok: true });
}

describe("withdrawing consent", () => {
  it("succeeds after the form was filled in twice", async () => {
    const { id } = await consultation();
    transcriptWithFormJob(id);
    await fill(id, "first");
    expect(await rpc(eva.client, "fill_form_again", { p_consultation_id: id })).toMatchObject({ ok: true });
    await fill(id, "second");
    expect(await rpc(eva.client, "withdraw_consent", { p_consultation_id: id })).toEqual({ ok: true });
    expect((await eva.client.from("forms").select("id").eq("consultation_id", id)).data).toEqual([]);
  });

  it("succeeds after the practitioner confirmed an attestation on a typed form", async () => {
    const versionId = sqlAsOwner(`select id from public.form_template_versions
      where template_key = 'massage_assessment_en_sk' and version_number = 1;`);
    const created = await rpc(eva.client, "create_consultation_with_template", {
      p_scheduled_at: "2026-12-01T09:00:00Z", p_language: "en", p_consent_recorded: true,
      p_form_template_version_id: versionId, p_patient_name: "Jana Nováková", p_patient_contact: "+421 905 111 223",
    });
    const id = created.consultation_id as string;
    transcriptWithFormJob(id);
    const job = await claimFormJob(engine, id) as Awaited<ReturnType<typeof claimFormJob>> & {
      template: { sections: { fields: { key: string; value_type: string }[] }[]; approval_gates: { type: string; field_key: string }[] };
    };
    const answers = job.template.sections.flatMap((section) => section.fields).map((field) => ({
      key: field.key, text: null, value_type: field.value_type, state: "unanswered", value: null, evidence: [], documents: [],
    }));
    expect(await rpc(engine.client, "engine_complete_form_job", { p_job_id: job.job_id, p_attempt: job.attempt, p_answers: answers, p_metrics: {} })).toMatchObject({ ok: true });
    const formId = sqlAsOwner(`select id from public.forms where consultation_id = '${id}' and status <> 'superseded';`);
    const gate = job.template.approval_gates.find((item) => item.type === "attestation")!;
    expect(await rpc(eva.client, "set_form_attestation", { p_form_id: formId, p_field_key: gate.field_key, p_decision: "confirmed" })).toEqual({ ok: true });
    expect(await rpc(eva.client, "withdraw_consent", { p_consultation_id: id })).toEqual({ ok: true });
  });

  it("stops a document that waits from ever being read", async () => {
    const { id, invite_token } = await consultation();
    const document = await sendDocument(invite_token);
    expect(await rpc(eva.client, "withdraw_consent", { p_consultation_id: id })).toEqual({ ok: true });
    expect(await claim(document.id)).toBeNull();
    const { data } = await eva.client.from("patient_documents").select("reading, error_category").eq("id", document.id).single();
    expect(data).toEqual({ reading: "failed", error_category: "CONSENT_WITHDRAWN" });
  });

  it("closes the file to an engine already reading it and refuses what it read", async () => {
    const { id, invite_token } = await consultation();
    const document = await sendDocument(invite_token);
    const claimed = (await claim(document.id))!;
    expect(claimed).not.toBeNull();
    expect(await rpc(eva.client, "withdraw_consent", { p_consultation_id: id })).toEqual({ ok: true });
    const read = await engine.client.storage.from("documents").download(claimed.storage_path);
    expect(read.data).toBeNull();
    expect(await rpc(engine.client, "engine_complete_document", {
      p_document_id: document.id, p_attempt: claimed.attempt, p_pages: ["Haemoglobin 128 g/l, within range."],
    })).toMatchObject({ ok: false });
    const { data } = await eva.client.from("patient_documents").select("reading, page_texts").eq("id", document.id).single();
    expect(data).toEqual({ reading: "failed", page_texts: null });
  });

  it("forgets what Watson read from the consultation's documents, and keeps the files for the practitioner", async () => {
    const { id, invite_token } = await consultation();
    const document = await sendDocument(invite_token);
    const claimed = (await claim(document.id))!;
    expect(await rpc(engine.client, "engine_complete_document", {
      p_document_id: document.id, p_attempt: claimed.attempt, p_pages: ["Haemoglobin 128 g/l, within range."],
    })).toEqual({ ok: true, readable: true });
    expect(await rpc(eva.client, "withdraw_consent", { p_consultation_id: id })).toEqual({ ok: true });
    const { data } = await eva.client.from("patient_documents").select("page_texts, removed_at").eq("id", document.id).single();
    expect(data).toEqual({ page_texts: null, removed_at: null });
    expect((await eva.client.storage.from("documents").download(document.path)).error).toBeNull();
  });
});
