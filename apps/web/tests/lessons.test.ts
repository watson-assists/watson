// What Watson learns from a doctor's corrections (plan step 4, 25 Nov 2026). The engine gets the
// doctor's corrections on approved forms with each job, keeps the lessons it derived for the doctor
// to see, and the doctor can make it forget one. Nobody else sees them.
import { beforeAll, describe, expect, it } from "vitest";
import { claimFormJob, localStack, newEngine, newPractitioner, rpc, sqlAsOwner, transcriptWithFormJob, type Practitioner } from "./local-stack";

const stack = localStack();
let eva: Practitioner;
let finn: Practitioner;
let engine: Practitioner;
beforeAll(async () => {
  [eva, finn, engine] = await Promise.all([
    newPractitioner(stack, "lessons-eva"), newPractitioner(stack, "lessons-finn"), newEngine(stack, "lessons-engine"),
  ]);
});

type History = { edits: { key: string; watson: string; doctor: string; consultation: string }[];
  answered: Record<string, number>; cleared: Record<string, number>; kept: string[]; forgotten: string[] };

/** An approved form where Watson wrote "Pitta imbalance" and the doctor made it "Pitta vitiation", and cleared the referral. */
async function corrected(assessment = "Pitta imbalance", doctor = "Pitta vitiation") {
  const made = await rpc(eva.client, "create_consultation", { p_scheduled_at: "2026-11-25T09:00:00Z", p_language: "en", p_consent_recorded: true });
  const id = made.consultation_id as string;
  transcriptWithFormJob(id);
  const job = await claimFormJob(engine, id) as unknown as { job_id: string; attempt: number; template: { sections: { fields: { key: string }[] }[] } };
  const answers = job.template.sections.flatMap((section) => section.fields).map((field) => ({
    key: field.key, evidence: [0],
    text: field.key === "assessment" ? assessment : field.key === "referral" ? "See a gastroenterologist" : null,
  }));
  await rpc(engine.client, "engine_complete_form_job", { p_job_id: job.job_id, p_attempt: job.attempt, p_answers: answers });
  const form = sqlAsOwner(`select id from public.forms where consultation_id = '${id}' and status = 'draft';`);
  await rpc(eva.client, "review_form_answer", { p_form_id: form, p_field_key: "assessment", p_decision: "edit", p_text: doctor });
  await rpc(eva.client, "review_form_answer", { p_form_id: form, p_field_key: "referral", p_decision: "reject" });
  expect(await rpc(eva.client, "approve_form", { p_form_id: form })).toEqual({ ok: true });
  return id;
}

describe("lessons from corrections", () => {
  it("are learned from the doctor's own approved forms only, and kept for them alone", async () => {
    const first = await corrected();
    await corrected("Vata imbalance", "Vata vitiation");
    const id = await rpc(eva.client, "create_consultation", { p_scheduled_at: "2026-11-25T10:00:00Z", p_language: "en", p_consent_recorded: true });
    transcriptWithFormJob(id.consultation_id as string);
    const job = await claimFormJob(engine, id.consultation_id as string) as unknown as { job_id: string; history: History };
    expect(job.history.edits).toEqual(expect.arrayContaining([
      { key: "assessment", watson: "Pitta imbalance", doctor: "Pitta vitiation", consultation: first },
    ]));
    expect(job.history.edits).toHaveLength(2);
    expect(job.history.answered).toMatchObject({ assessment: 2, referral: 2 });
    expect(job.history.cleared).toEqual({ referral: 2 });
    // The words the doctor let stand: theirs, never Watson's words they replaced or cleared.
    expect(job.history.kept).toEqual(expect.arrayContaining(["pitta", "vata", "vitiation"]));
    expect(job.history.kept).not.toContain("imbalance");
    expect(job.history.kept).not.toContain("gastroenterologist");

    // What the engine derived (clinical_worker.lessons), kept for the doctor.
    const said = 'You write "vitiation" where Watson wrote "imbalance".';
    expect(await rpc(engine.client, "engine_save_lessons", { p_job_id: job.job_id,
      p_lessons: [{ key: "word:imbalance>vitiation", said, seen: 2 }] })).toEqual({ ok: true });
    expect((await eva.client.from("practitioner_lessons").select("key, said")).data).toEqual([{ key: "word:imbalance>vitiation", said }]);
    expect((await finn.client.from("practitioner_lessons").select("key")).data).toEqual([]);
    expect(await rpc(eva.client, "engine_save_lessons", { p_job_id: job.job_id, p_lessons: [] })).toMatchObject({ ok: false, error_category: "NOT_AN_ENGINE" });
  });

  it("can be forgotten, stay forgotten, and come back", async () => {
    const id = await rpc(eva.client, "create_consultation", { p_scheduled_at: "2026-11-25T11:00:00Z", p_language: "en", p_consent_recorded: true });
    transcriptWithFormJob(id.consultation_id as string);
    const job = await claimFormJob(engine, id.consultation_id as string) as unknown as { job_id: string };
    await rpc(engine.client, "engine_save_lessons", { p_job_id: job.job_id, p_lessons: [{ key: "empty:referral", said: "You usually clear the referral.", seen: 2 }] });
    expect(await rpc(finn.client, "forget_lesson", { p_key: "empty:referral", p_forget: true })).toMatchObject({ ok: false, error_category: "NOT_FOUND" });
    expect(await rpc(eva.client, "forget_lesson", { p_key: "empty:referral", p_forget: true })).toEqual({ ok: true });
    // The engine's next save neither brings it back nor removes it.
    await rpc(engine.client, "engine_save_lessons", { p_job_id: job.job_id, p_lessons: [] });
    expect(sqlAsOwner(`select count(*) from public.practitioner_lessons where practitioner_id = '${eva.id}' and key = 'empty:referral' and forgotten_at is not null;`)).toBe("1");
    const next = await rpc(eva.client, "create_consultation", { p_scheduled_at: "2026-11-25T12:00:00Z", p_language: "en", p_consent_recorded: true });
    transcriptWithFormJob(next.consultation_id as string);
    const later = await claimFormJob(engine, next.consultation_id as string) as unknown as { history: History };
    expect(later.history.forgotten).toContain("empty:referral");
    expect(await rpc(eva.client, "forget_lesson", { p_key: "empty:referral", p_forget: false })).toEqual({ ok: true });
  });
});
