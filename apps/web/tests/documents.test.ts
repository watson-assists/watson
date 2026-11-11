// Patients and their documents: a patient is known by phone or email, a document goes in only
// through a record made for it, only its practitioner and the engine reading it can open it, and
// a form may quote only that patient's documents.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, browserClient, claimFormJob, localStack, newEngine, newPractitioner, rpc, sqlAsOwner, transcriptWithFormJob, type Practitioner } from "./local-stack";

const stack = localStack();
const PDF = Buffer.from("%PDF-1.4\n% a tiny stand-in for a lab report\n%%EOF\n");
const TEMPLATE = readFileSync(new URL("../../../packages/test-fixtures/templates/ayurveda-intake.json", import.meta.url), "utf8");

let eva: Practitioner;
let finn: Practitioner;
let engine: Practitioner;
beforeAll(async () => {
  [eva, finn, engine] = await Promise.all([newPractitioner(stack, "eva"), newPractitioner(stack, "finn"), newEngine(stack, "doc-engine")]);
});

/** A consultation and its patient link's token. */
async function consultation(who: Practitioner) {
  const made = await rpc(who.client, "create_consultation", {
    p_synthetic_patient_ref: "SYN-0071", p_scheduled_at: "2026-10-20T07:30:00Z", p_language: "en", p_consent_recorded: true,
  });
  const { data } = await who.client.from("consultations").select("id, invite_token").eq("id", made.consultation_id!).single();
  return data!;
}

/** The patient's page: says who they are, then sends one PDF. */
async function sendDocument(token: string, contact = `+4219${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`) {
  const visitor = browserClient(stack);
  expect(await rpc(visitor, "patient_identify", { p_token: token, p_name: "Jana Nováková", p_contact: contact })).toMatchObject({ ok: true });
  const added = await rpc(visitor, "patient_add_document", {
    p_token: token, p_file_name: "Blood test 3 Oct.pdf", p_media_type: "application/pdf", p_size_bytes: PDF.length,
  });
  expect(added).toMatchObject({ ok: true });
  const upload = await visitor.storage.from("documents").upload(added.path as string, PDF, { contentType: "application/pdf" });
  expect(upload.error).toBeNull();
  expect(await rpc(visitor, "patient_confirm_document", { p_token: token, p_document_id: added.document_id })).toEqual({ ok: true });
  return { visitor, id: added.document_id as string, path: added.path as string };
}

/** Claims documents until it gets this one; anything older left by earlier runs is set aside. */
async function claim(documentId: string) {
  for (let i = 0; i < 50; i++) {
    const { document } = await rpc(engine.client, "engine_claim_document") as unknown as { document: { document_id: string; attempt: number; storage_path: string } | null };
    if (!document) break;
    if (document.document_id === documentId) return document;
    await rpc(engine.client, "engine_fail_document", { p_document_id: document.document_id, p_attempt: document.attempt, p_error_category: "DOCUMENT_FAILED" });
  }
  throw new Error("document was never offered to the engine");
}

describe("an unverified patient claim", () => {
  it("normalizes a phone per consultation without joining canonical patient records", async () => {
    const [first, second] = [await consultation(eva), await consultation(eva)];
    const visitor = browserClient(stack);
    const number = `+4219${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`;
    const spaced = `00${number.slice(1, 4)} ${number.slice(4, 7)}-${number.slice(7, 10)} ${number.slice(10)}`;
    const a = await rpc(visitor, "patient_identify", { p_token: first.invite_token, p_name: "Jana Nováková", p_contact: spaced });
    const b = await rpc(visitor, "patient_identify", { p_token: second.invite_token, p_name: "Jana Nováková", p_contact: number });
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect((await eva.client.from("patients").select("id")).data).toEqual([]);
    const linked = (await eva.client.from("consultations")
      .select("patient_id, patient_claim_phone, patient_association_state").in("id", [first.id, second.id])).data!;
    expect(linked).toEqual([
      { patient_id: null, patient_claim_phone: number, patient_association_state: "claimed" },
      { patient_id: null, patient_claim_phone: number, patient_association_state: "claimed" },
    ]);
  });

  it("normalizes an email claim and refuses an unusable contact or name", async () => {
    const { invite_token: token } = await consultation(eva);
    const visitor = browserClient(stack);
    const email = `Jana.${randomUUID().slice(0, 6)}@Example.com`;
    expect(await rpc(visitor, "patient_identify", { p_token: token, p_name: "Jana", p_contact: ` ${email} ` }))
      .toEqual({ ok: true });
    const { data } = await eva.client.from("consultations").select("patient_id, patient_claim_email").eq("invite_token", token).single();
    expect(data).toEqual({ patient_id: null, patient_claim_email: email.toLowerCase() });
    for (const contact of ["0900 123 456", "jana@", "", "+0 12"]) {
      expect(await rpc(visitor, "patient_identify", { p_token: token, p_name: "Jana", p_contact: contact }), contact)
        .toEqual({ ok: false, error_category: "VALIDATION", field: "contact" });
    }
    expect(await rpc(visitor, "patient_identify", { p_token: token, p_name: "  ", p_contact: email }))
      .toEqual({ ok: false, error_category: "VALIDATION", field: "name" });
    expect(await rpc(visitor, "patient_identify", { p_token: "0".repeat(64), p_name: "Jana", p_contact: email }))
      .toEqual({ ok: false, error_category: "NOT_FOUND" });
  });

  it("is invisible to other practitioners", async () => {
    const { invite_token: token } = await consultation(eva);
    await rpc(browserClient(stack), "patient_identify", { p_token: token, p_name: "Jana", p_contact: `+4219${Date.now() % 1e8}` });
    expect((await finn.client.from("patients").select("id")).data).toEqual([]);
  });
});

describe("a document from the patient's page", () => {
  it("needs the patient's name first, goes only to the path made for it, and shows on the link", async () => {
    const { id: consultationId, invite_token: token } = await consultation(eva);
    const visitor = browserClient(stack);
    const args = { p_token: token, p_file_name: "Blood test 3 Oct.pdf", p_media_type: "application/pdf", p_size_bytes: PDF.length };
    expect(await rpc(visitor, "patient_add_document", args)).toEqual({ ok: false, error_category: "PATIENT_MISSING" });

    await rpc(visitor, "patient_identify", { p_token: token, p_name: "Jana Nováková", p_contact: `+4219${Date.now() % 1e8}` });
    const added = await rpc(visitor, "patient_add_document", args);
    expect(added.path).toBe(`${eva.id}/${consultationId}/${added.document_id}`);
    expect(await rpc(visitor, "patient_confirm_document", { p_token: token, p_document_id: added.document_id }))
      .toEqual({ ok: false, error_category: "DOCUMENT_FILE_MISSING" });
    expect((await visitor.storage.from("documents").upload(`${eva.id}/${randomUUID()}`, PDF, { contentType: "application/pdf" })).error).not.toBeNull();
    expect((await visitor.storage.from("documents").upload(added.path as string, PDF, { contentType: "application/pdf" })).error).toBeNull();
    expect(await rpc(visitor, "patient_confirm_document", { p_token: token, p_document_id: added.document_id })).toEqual({ ok: true });

    // Once it is in, nobody overwrites it, and the patient's page cannot read files back.
    expect((await visitor.storage.from("documents").upload(added.path as string, PDF, { contentType: "application/pdf", upsert: true })).error).not.toBeNull();
    expect((await visitor.storage.from("documents").download(added.path as string)).error).not.toBeNull();

    const { data: details } = await visitor.rpc("invite_details", { p_token: token });
    expect(details).toMatchObject({
      ok: true, patient: { name: "Jana Nováková" },
      documents: [{ id: added.document_id, file_name: "Blood test 3 Oct.pdf", media_type: "application/pdf", size_bytes: PDF.length }],
    });

    // Its practitioner sees it and can open it; nobody else can.
    const mine = (await eva.client.from("patient_documents").select("consultation_id, source, reading").eq("id", added.document_id as string)).data;
    expect(mine).toEqual([{ consultation_id: consultationId, source: "patient", reading: "waiting" }]);
    expect((await eva.client.storage.from("documents").download(added.path as string)).error).toBeNull();
    expect((await finn.client.from("patient_documents").select("id").eq("id", added.document_id as string)).data).toEqual([]);
    expect((await finn.client.storage.from("documents").download(added.path as string)).error).not.toBeNull();
    const events = (await eva.client.from("audit_events").select("event_type, actor_role").eq("consultation_id", consultationId)).data!;
    expect(events).toContainEqual({ event_type: "document.added", actor_role: "patient" });
  });

  it("is refused in a format the engine cannot read, or over 10 MB", async () => {
    const { invite_token: token } = await consultation(eva);
    const visitor = browserClient(stack);
    await rpc(visitor, "patient_identify", { p_token: token, p_name: "Jana", p_contact: `+4219${Date.now() % 1e8}` });
    const add = (media: string, size: number) => rpc(visitor, "patient_add_document", { p_token: token, p_file_name: "x", p_media_type: media, p_size_bytes: size });
    expect(await add("text/html", 10)).toEqual({ ok: false, error_category: "DOCUMENT_FORMAT_UNSUPPORTED" });
    expect(await add("application/pdf", 10485761)).toEqual({ ok: false, error_category: "DOCUMENT_TOO_LARGE" });
  });

  it("revokes access immediately and retains a tombstone when patient storage cleanup is pending", async () => {
    const { invite_token: token } = await consultation(eva);
    const { invite_token: other } = await consultation(eva);
    const sent = await sendDocument(token);
    expect(await rpc(sent.visitor, "patient_remove_document", { p_token: other, p_document_id: sent.id })).toEqual({ ok: false, error_category: "NOT_FOUND" });
    expect(await rpc(sent.visitor, "patient_remove_document", { p_token: token, p_document_id: sent.id }))
      .toMatchObject({ ok: true, path: sent.path, cleanup_completed: false });
    // Anonymous, unrelated practitioner, and unassigned engine cannot list, read,
    // sign, or delete while the tombstone holds the path.
    for (const client of [sent.visitor, finn.client, engine.client]) {
      expect((await client.storage.from("documents").list(eva.id)).data?.some((o) => o.name === sent.id)).toBe(false);
      expect((await client.storage.from("documents").download(sent.path)).error).not.toBeNull();
      expect((await client.storage.from("documents").createSignedUrl(sent.path, 60)).error).not.toBeNull();
      await client.storage.from("documents").remove([sent.path]);
    }
    expect(sqlAsOwner(`select count(*) from storage.objects where bucket_id = 'documents' and name = '${sent.path}'`)).toBe("1");
    expect(sqlAsOwner(`select removed_at is not null and cleanup_completed_at is null from public.patient_documents where id = '${sent.id}'`)).toBe("t");
    expect(sqlAsOwner(`select page_texts is null and reading = 'failed' and engine_user_id is null from public.patient_documents where id = '${sent.id}'`)).toBe("t");

    // A trusted service client removes through Storage API and acknowledges cleanup.
    const admin = adminClient(stack);
    expect((await sent.visitor.rpc("complete_document_cleanup", { p_document_id: sent.id })).error).not.toBeNull();
    expect((await admin.storage.from("documents").remove([sent.path])).error).toBeNull();
    expect(await rpc(admin, "complete_document_cleanup", { p_document_id: sent.id })).toBe(true);
    expect(sqlAsOwner(`select cleanup_completed_at is not null from public.patient_documents where id = '${sent.id}'`)).toBe("t");
  });
});

describe("the practitioner", () => {
  it("does not count removed documents toward the active upload limit", async () => {
    const { id } = await consultation(eva);
    await rpc(eva.client, "set_patient", {
      p_consultation_id: id, p_name: "Jana", p_contact: `+4219${Date.now() % 1e8}`,
    });
    const add = () => rpc(eva.client, "add_document", {
      p_consultation_id: id, p_file_name: "Letter.pdf", p_media_type: "application/pdf", p_size_bytes: PDF.length,
    });
    const documents: string[] = [];
    for (let i = 0; i < 20; i++) {
      const result = await add();
      expect(result.ok).toBe(true);
      documents.push(result.document_id as string);
    }
    expect(await add()).toEqual({ ok: false, error_category: "DOCUMENT_LIMIT" });

    expect(await rpc(eva.client, "remove_document", { p_document_id: documents[0] }))
      .toMatchObject({ ok: true, cleanup_completed: false });
    expect(await add()).toMatchObject({ ok: true });
  });

  it("can name the patient, add a document and remove any of their patients' documents", async () => {
    const { id } = await consultation(eva);
    expect(await rpc(eva.client, "add_document", { p_consultation_id: id, p_file_name: "Letter.pdf", p_media_type: "application/pdf", p_size_bytes: PDF.length }))
      .toEqual({ ok: false, error_category: "PATIENT_MISSING" });
    expect(await rpc(eva.client, "set_patient", { p_consultation_id: id, p_name: "Jana", p_contact: `+4219${Date.now() % 1e8}` })).toMatchObject({ ok: true });
    expect(await rpc(finn.client, "set_patient", { p_consultation_id: id, p_name: "Jana", p_contact: "+421900000000" })).toEqual({ ok: false, error_category: "NOT_FOUND" });
    const added = await rpc(eva.client, "add_document", { p_consultation_id: id, p_file_name: "Letter.pdf", p_media_type: "application/pdf", p_size_bytes: PDF.length });
    expect((await eva.client.storage.from("documents").upload(added.path as string, PDF, { contentType: "application/pdf" })).error).toBeNull();
    expect(await rpc(eva.client, "confirm_document", { p_document_id: added.document_id })).toEqual({ ok: true });
    const assigned = await claim(added.document_id as string);
    expect((await engine.client.storage.from("documents").download(assigned.storage_path)).error).toBeNull();
    expect(await rpc(finn.client, "remove_document", { p_document_id: added.document_id })).toEqual({ ok: false, error_category: "NOT_FOUND" });
    expect(await rpc(eva.client, "remove_document", { p_document_id: added.document_id }))
      .toMatchObject({ ok: true, path: added.path, cleanup_completed: false });
    // Tombstones revoke reads even for the original practitioner and an assigned engine.
    const { error: downloadError } = await eva.client.storage.from("documents").download(added.path as string);
    expect(downloadError).not.toBeNull();
    expect((await finn.client.storage.from("documents").download(added.path as string)).error).not.toBeNull();
    expect((await engine.client.storage.from("documents").download(added.path as string)).error).not.toBeNull();
    for (const client of [eva.client, finn.client, engine.client]) {
      expect((await client.storage.from("documents").list(eva.id)).data?.some((o) => o.name === added.document_id)).toBe(false);
      expect((await client.storage.from("documents").createSignedUrl(added.path as string, 60)).error).not.toBeNull();
      await client.storage.from("documents").remove([added.path as string]);
    }
    expect(sqlAsOwner(`select count(*) from storage.objects where bucket_id = 'documents' and name = '${added.path}'`)).toBe("1");
    expect(sqlAsOwner(`select removed_at is not null and cleanup_completed_at is null from public.patient_documents where id = '${added.document_id}'`)).toBe("t");
    expect(sqlAsOwner(`select page_texts is null and reading = 'failed' and engine_user_id is null from public.patient_documents where id = '${added.document_id}'`)).toBe("t");
    expect(await rpc(eva.client, "read_document_again", { p_document_id: added.document_id }))
      .toEqual({ ok: false, error_category: "NOT_FOUND" });

    const admin = adminClient(stack);
    expect((await admin.storage.from("documents").remove([added.path as string])).error).toBeNull();
    expect(await rpc(admin, "complete_document_cleanup", { p_document_id: added.document_id as string })).toBe(true);
  });
});

describe("the engine", () => {
  it("reads a document it claimed, and marks one with nothing legible as unreadable", async () => {
    const { invite_token: token } = await consultation(eva);
    const first = await sendDocument(token);
    expect(await rpc(eva.client, "engine_claim_document")).toEqual({ ok: false, error_category: "NOT_AN_ENGINE" });

    const job = await claim(first.id);
    expect((await engine.client.storage.from("documents").download(job.storage_path)).error).toBeNull();
    expect(await rpc(engine.client, "engine_complete_document", { p_document_id: first.id, p_attempt: job.attempt, p_pages: ["Ferritin 9 µg/L (reference 15–150), low"] }))
      .toEqual({ ok: true, readable: true });
    const read = (await eva.client.from("patient_documents").select("reading, page_texts").eq("id", first.id).single()).data;
    expect(read).toEqual({ reading: "read", page_texts: ["Ferritin 9 µg/L (reference 15–150), low"] });
    // Finished: the engine can no longer open it.
    expect((await engine.client.storage.from("documents").download(first.path)).error).not.toBeNull();

    const second = await sendDocument(token);
    const again = await claim(second.id);
    expect(await rpc(engine.client, "engine_complete_document", { p_document_id: second.id, p_attempt: again.attempt, p_pages: ["  ", ""] }))
      .toEqual({ ok: true, readable: false });
    expect((await eva.client.from("patient_documents").select("reading").eq("id", second.id).single()).data).toEqual({ reading: "unreadable" });
  });

  it("may quote only the documents of the consultation's own patient in a form", async () => {
    expect(await rpc(eva.client, "set_form_template", { p_definition: JSON.parse(TEMPLATE) })).toEqual({ ok: true });
    const { id, invite_token: token } = await consultation(eva);
    const own = await sendDocument(token);
    const ownJob = await claim(own.id);
    await rpc(engine.client, "engine_complete_document", { p_document_id: own.id, p_attempt: ownJob.attempt, p_pages: ["Ferritin 9 µg/L, low"] });
    const { invite_token: strangerToken } = await consultation(eva);
    const stranger = await sendDocument(strangerToken);
    const strangerJob = await claim(stranger.id);
    await rpc(engine.client, "engine_complete_document", { p_document_id: stranger.id, p_attempt: strangerJob.attempt, p_pages: ["Someone else's results"] });

    // A transcript and a form job, as transcription would leave them.
    transcriptWithFormJob(id);
    const job = await claimFormJob(engine, id);
    expect(job.documents).toEqual([expect.objectContaining({ document_id: own.id, pages: ["Ferritin 9 µg/L, low"] })]);

    const keys = (JSON.parse(TEMPLATE).sections as { fields: { key: string }[] }[]).flatMap((s) => s.fields.map((f) => f.key));
    const answers = (quote: object) => keys.map((key) => key === "present_conditions"
      ? { key, text: "Low iron stores.", evidence: [0], documents: [quote] }
      : { key, text: null, evidence: [] });
    const complete = (quote: object) => rpc(engine.client, "engine_complete_form_job", { p_job_id: job.job_id, p_attempt: job.attempt, p_answers: answers(quote) });
    expect(await complete({ document_id: stranger.id, page: 1, text: "Someone else's results" })).toEqual({ ok: false, error_category: "VALIDATION", field: "answers" });
    expect(await complete({ document_id: own.id, page: 2, text: "Ferritin 9" })).toEqual({ ok: false, error_category: "VALIDATION", field: "answers" });
    expect(await complete({ document_id: own.id, page: 1, text: "Ferritin 9 µg/L, low" })).toMatchObject({ ok: true });
    const { data } = await eva.client.from("form_answers").select("document_quotes").eq("field_key", "present_conditions")
      .eq("form_id", (await eva.client.from("forms").select("id").eq("consultation_id", id).single()).data!.id).single();
    expect(data!.document_quotes).toEqual([{ document_id: own.id, page: 1, text: "Ferritin 9 µg/L, low" }]);
  });
});
