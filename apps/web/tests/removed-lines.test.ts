// Parts of the conversation the doctor removes (owner's test team, 23 Nov: "parts of the conversation
// does not need to be in the transcript"). A removed line is never given to the engine, can be put back
// until the form is approved, and its words are erased once it is.
import { beforeAll, describe, expect, it } from "vitest";
import { claimFormJob, localStack, newEngine, newPractitioner, rpc, sqlAsOwner, transcriptWithFormJob, type Practitioner } from "./local-stack";

const stack = localStack();
let eva: Practitioner;
let finn: Practitioner;
let engine: Practitioner;
beforeAll(async () => {
  [eva, finn, engine] = await Promise.all([
    newPractitioner(stack, "remove-eva"), newPractitioner(stack, "remove-finn"), newEngine(stack, "remove-engine"),
  ]);
});

/** A consultation whose transcript has two lines and a form job waiting; the second line is the one to remove. */
async function twoLines() {
  const made = await rpc(eva.client, "create_consultation", { p_scheduled_at: "2026-11-23T09:00:00Z", p_language: "en", p_consent_recorded: true });
  const id = made.consultation_id as string;
  transcriptWithFormJob(id);
  const aside = sqlAsOwner(`
    insert into public.transcript_segments (id, transcript_id, position, speaker, start_seconds, end_seconds, machine_text)
      select gen_random_uuid(), t.id, 1, 'patient', 5, 8, 'By the way, my neighbour drinks too much.'
      from public.transcripts t where t.consultation_id = '${id}' returning id;`).split("\n")[0]!;
  return { id, aside };
}
const remove = (who: Practitioner, segment: string, removed: boolean) =>
  rpc(who.client, "remove_transcript_line", { p_segment_id: segment, p_remove: removed });

describe("removing parts of the conversation", () => {
  it("leaves a removed line out of what Watson reads for the form, and puts it back on Undo", async () => {
    const { id, aside } = await twoLines();
    expect(await remove(eva, aside, true)).toEqual({ ok: true });
    const job = await claimFormJob(engine, id) as unknown as { lines: { position: number }[] };
    expect(job.lines.map((line) => line.position)).toEqual([0]);
    expect(await remove(eva, aside, false)).toEqual({ ok: true });
    expect(sqlAsOwner(`select removed_at is null from public.transcript_segments where id = '${aside}';`)).toBe("t");
  });

  it("is the consultation's own practitioner's to do", async () => {
    const { aside } = await twoLines();
    expect(await remove(finn, aside, true)).toMatchObject({ ok: false, error_category: "NOT_FOUND" });
  });

  it("erases a removed line's words once the form is approved, and then nothing more is removed", async () => {
    const { id, aside } = await twoLines();
    await remove(eva, aside, true);
    sqlAsOwner(`update public.consultations set status = 'approved' where id = '${id}';`);
    expect(sqlAsOwner(`select machine_text = '' and reviewed_text is null from public.transcript_segments where id = '${aside}';`)).toBe("t");
    expect(sqlAsOwner(`select count(*) from public.transcript_segments s join public.transcripts t on t.id = s.transcript_id
      where t.consultation_id = '${id}' and s.machine_text = 'I feel tired all the time.';`)).toBe("1");
    expect(await remove(eva, aside, false)).toMatchObject({ ok: false, error_category: "INVALID_STATE_TRANSITION" });
  });
});
