// The doctor's own notes, and a form filled without the full transcript (owner's test team, 23 Nov:
// "the doctor's free-form notes during the call … all considered for the diagnosis", "the form filled
// alongside the conversation", and a call the patient said no to recording, filled in by hand).
import { beforeAll, describe, expect, it } from "vitest";
import { claimFormJob, localStack, newEngine, newPractitioner, rpc, sqlAsOwner, transcriptWithFormJob, type Practitioner } from "./local-stack";

const stack = localStack();
let eva: Practitioner;
let finn: Practitioner;
let engine: Practitioner;
beforeAll(async () => {
  [eva, finn, engine] = await Promise.all([
    newPractitioner(stack, "notes-eva"), newPractitioner(stack, "notes-finn"), newEngine(stack, "notes-engine"),
  ]);
});

type Job = { job_id: string; attempt: number; revision_kind: string; notes: string; lines: { position: number; speaker: string; text: string }[];
  template: { sections: { fields: { key: string }[] }[] } };

async function consultation(consent = true) {
  const made = await rpc(eva.client, "create_consultation", { p_scheduled_at: "2026-11-24T09:00:00Z", p_language: "en", p_consent_recorded: consent });
  return made.consultation_id as string;
}
const save = (who: Practitioner, id: string, text: string) => rpc(who.client, "save_doctor_notes", { p_consultation_id: id, p_text: text });
const status = (id: string) => sqlAsOwner(`select status from public.consultations where id = '${id}';`);
/** Two pieces of the call so far, as the live worker leaves them; the doctor's said second. */
function saidSoFar(id: string) {
  sqlAsOwner(`insert into public.live_pieces (consultation_id, speaker, seq, offset_seconds, storage_path, status, text) values
    ('${id}', 'practitioner', 0, 10, 'x/${id}/live/practitioner-0', 'done', 'How do you sleep?'),
    ('${id}', 'patient', 0, 0, 'x/${id}/live/patient-0', 'done', 'I wake at three every night.'),
    ('${id}', 'patient', 1, 20, 'x/${id}/live/patient-1', 'done', '');`);
}
const fillNow = (id: string) => rpc(eva.client, "fill_form_during_call", { p_consultation_id: id });
const unanswered = (job: Job) => job.template.sections.flatMap((section) => section.fields).map((field) => ({ key: field.key, text: null, evidence: [] }));

describe("the doctor's notes", () => {
  it("are the doctor's alone, and Watson reads them when it fills in the form", async () => {
    const id = await consultation();
    expect(await save(eva, id, "Pale. Tongue coated. Vata high?")).toEqual({ ok: true });
    expect(await save(eva, id, "Pale. Tongue coated.")).toEqual({ ok: true });
    expect((await eva.client.from("doctor_notes").select("text").eq("consultation_id", id).single()).data).toEqual({ text: "Pale. Tongue coated." });
    expect((await finn.client.from("doctor_notes").select("text").eq("consultation_id", id)).data).toEqual([]);
    expect(await save(finn, id, "Mine now")).toMatchObject({ ok: false, error_category: "NOT_FOUND" });
    expect(await save(eva, id, "x".repeat(20001))).toMatchObject({ ok: false, error_category: "VALIDATION" });
    transcriptWithFormJob(id);
    expect(((await claimFormJob(engine, id)) as unknown as Job).notes).toBe("Pale. Tongue coated.");
  });

  it("are final once the form is approved", async () => {
    const id = await consultation();
    sqlAsOwner(`update public.consultations set status = 'approved' where id = '${id}';`);
    expect(await save(eva, id, "Later thought")).toMatchObject({ ok: false, error_category: "INVALID_STATE_TRANSITION" });
  });
});

describe("filling in the form during the call", () => {
  it("reads the call so far and the notes, and leaves only a preview: the call goes on", async () => {
    const id = await consultation();
    saidSoFar(id);
    await save(eva, id, "Looks tired.");
    const queued = await fillNow(id);
    expect(queued).toMatchObject({ ok: true });
    expect(await fillNow(id)).toEqual(queued); // a second tap waits for the first
    const job = await claimFormJob(engine, id) as unknown as Job;
    expect(job.revision_kind).toBe("during_call");
    expect(job.lines).toEqual([
      { position: 0, speaker: "patient", text: "I wake at three every night." },
      { position: 1, speaker: "practitioner", text: "How do you sleep?" },
    ]);
    expect(job.notes).toBe("Looks tired.");
    // Never a form, whatever an engine sends.
    expect(await rpc(engine.client, "engine_complete_form_job", { p_job_id: job.job_id, p_attempt: job.attempt, p_answers: unanswered(job) }))
      .toMatchObject({ ok: false, error_category: "VALIDATION" });
    expect(await rpc(engine.client, "engine_complete_call_fill", { p_job_id: job.job_id, p_attempt: job.attempt, p_answers: [
      { key: "sleep", text: " Wakes at three every night " }, { key: "age", text: "" },
      { key: "private_notes", text: "Not the model's" }, { key: "no_such_field", text: "Invented" },
    ] })).toEqual({ ok: true });
    expect((await eva.client.from("form_jobs").select("status, preview").eq("id", job.job_id).single()).data)
      .toEqual({ status: "completed", preview: [{ key: "sleep", text: "Wakes at three every night" }] });
    expect(status(id)).toBe("ready_for_audio");
    expect(sqlAsOwner(`select count(*) from public.forms where consultation_id = '${id}';`)).toBe("0");
    expect((await finn.client.from("form_jobs").select("preview").eq("id", job.job_id)).data).toEqual([]);
  });

  it("needs something said, written or sent first", async () => {
    expect(await fillNow(await consultation())).toMatchObject({ ok: false, error_category: "NOTHING_TO_FILL" });
  });

  it("never holds back the form after the call, and one still queued when the call ends is set aside", async () => {
    const id = await consultation();
    saidSoFar(id);
    const { job_id } = await fillNow(id);
    transcriptWithFormJob(id); // the call ended and was transcribed: the form's own job is queued too
    expect(sqlAsOwner(`select count(*) from public.form_jobs where consultation_id = '${id}' and status = 'queued';`)).toBe("2");
    expect(((await claimFormJob(engine, id)) as unknown as Job).revision_kind).toBe("generated");
    expect(sqlAsOwner(`select status from public.form_jobs where id = '${job_id}';`)).toBe("cancelled");
  });

  it("that fails leaves the call where it was", async () => {
    const id = await consultation();
    saidSoFar(id);
    await fillNow(id);
    const job = await claimFormJob(engine, id);
    expect(await rpc(engine.client, "engine_fail_form_job", { p_job_id: job.job_id, p_attempt: job.attempt, p_error_category: "FORM_FAILED" })).toEqual({ ok: true });
    expect(status(id)).toBe("ready_for_audio");
  });
});

describe("a form without a recording", () => {
  it("is written by the doctor: every question empty, nothing for the engine", async () => {
    const id = await consultation(false);
    sqlAsOwner(`update public.consultations set patient_recording = 'declined' where id = '${id}';`);
    const written = await rpc(eva.client, "start_form_without_recording", { p_consultation_id: id, p_by_watson: false });
    expect(written).toMatchObject({ ok: true });
    expect(status(id)).toBe("draft_ready");
    expect(sqlAsOwner(`select job_id is null and transcript_id is null and status = 'draft' from public.forms where id = '${written.id}';`)).toBe("t");
    expect(sqlAsOwner(`select count(*) filter (where answer_state = 'unanswered' and machine_text is null) = count(*) and count(*) > 30
      from public.form_answers where form_id = '${written.id}';`)).toBe("t");
    expect(await rpc(eva.client, "review_form_answer", { p_form_id: written.id, p_field_key: "main_concern", p_decision: "edit", p_text: "Wakes at three" }))
      .toEqual({ ok: true });
    expect(await rpc(eva.client, "approve_form", { p_form_id: written.id })).toEqual({ ok: true });
  });

  it("is filled by Watson from the notes, with no conversation to read", async () => {
    const id = await consultation(false);
    const fill = () => rpc(eva.client, "start_form_without_recording", { p_consultation_id: id, p_by_watson: true });
    expect(await fill()).toMatchObject({ ok: false, error_category: "NOTHING_TO_FILL" });
    await save(eva, id, "Wakes at three every night. Coffee four times a day.");
    expect(await fill()).toMatchObject({ ok: true });
    expect(status(id)).toBe("extraction_processing");
    const job = await claimFormJob(engine, id) as unknown as Job;
    expect([job.lines, job.notes]).toEqual([[], "Wakes at three every night. Coffee four times a day."]);
    const answers = unanswered(job).map((answer) => answer.key === "sleep" ? { ...answer, text: "Wakes at three every night" } : answer);
    expect(await rpc(engine.client, "engine_complete_form_job", { p_job_id: job.job_id, p_attempt: job.attempt, p_answers: answers }))
      .toMatchObject({ ok: true });
    expect(status(id)).toBe("draft_ready");
    expect(sqlAsOwner(`select a.machine_text from public.form_answers a join public.forms f on f.id = a.form_id
      where f.consultation_id = '${id}' and f.transcript_id is null and a.field_key = 'sleep';`)).toBe("Wakes at three every night");
  });

  it("is tried again when Watson's fill from the notes failed, or written by the doctor after all", async () => {
    const id = await consultation(false);
    await save(eva, id, "Wakes at three every night.");
    await rpc(eva.client, "start_form_without_recording", { p_consultation_id: id, p_by_watson: true });
    const job = await claimFormJob(engine, id);
    await rpc(engine.client, "engine_fail_form_job", { p_job_id: job.job_id, p_attempt: job.attempt, p_error_category: "FORM_FAILED" });
    expect(status(id)).toBe("extraction_failed");
    expect(await rpc(eva.client, "start_form_without_recording", { p_consultation_id: id, p_by_watson: true })).toMatchObject({ ok: true });
    const again = await claimFormJob(engine, id);
    await rpc(engine.client, "engine_fail_form_job", { p_job_id: again.job_id, p_attempt: again.attempt, p_error_category: "FORM_FAILED" });
    expect(await rpc(eva.client, "start_form_without_recording", { p_consultation_id: id, p_by_watson: false })).toMatchObject({ ok: true });
    expect(status(id)).toBe("draft_ready");
  });

  it("is not for a consultation that was recorded, or someone else's", async () => {
    const id = await consultation();
    transcriptWithFormJob(id);
    expect(await rpc(eva.client, "start_form_without_recording", { p_consultation_id: id, p_by_watson: false }))
      .toMatchObject({ ok: false, error_category: "INVALID_STATE_TRANSITION" });
    expect(await rpc(finn.client, "start_form_without_recording", { p_consultation_id: await consultation(false), p_by_watson: false }))
      .toMatchObject({ ok: false, error_category: "NOT_FOUND" });
  });
});

describe("the doctor's voice notes", () => {
  async function claimNote(id: string) {
    for (let i = 0; i < 20; i++) {
      const note = (await rpc(engine.client, "engine_claim_voice_note")).note as { id: string } | null;
      if (!note) break;
      if (note.id === id) return note;
      await rpc(engine.client, "engine_voice_note_failed", { p_id: note.id });
    }
    throw new Error("voice note was never offered to the engine");
  }

  it("are the doctor's to add while the form is open, and their words join the notes", async () => {
    const id = await consultation(false);
    const note = crypto.randomUUID();
    expect(await rpc(finn.client, "add_voice_note", { p_consultation_id: id, p_id: note })).toMatchObject({ ok: false, error_category: "NOT_FOUND" });
    const { error } = await finn.client.storage.from("audio").upload(`${eva.id}/${id}/notes/${note}`, new Blob(["x"], { type: "audio/webm" }));
    expect(error).not.toBeNull();
    expect(await rpc(eva.client, "add_voice_note", { p_consultation_id: id, p_id: note })).toEqual({ ok: true });
    await claimNote(note);
    expect(await rpc(engine.client, "engine_voice_note_done", { p_id: note, p_text: " Tongue coated. " })).toEqual({ ok: true });
    expect((await eva.client.from("doctor_notes").select("text").eq("consultation_id", id).single()).data).toEqual({ text: "Tongue coated." });
    sqlAsOwner(`update public.consultations set status = 'approved' where id = '${id}';`);
    expect(await rpc(eva.client, "add_voice_note", { p_consultation_id: id, p_id: crypto.randomUUID() }))
      .toMatchObject({ ok: false, error_category: "INVALID_STATE_TRANSITION" });
  });
});
