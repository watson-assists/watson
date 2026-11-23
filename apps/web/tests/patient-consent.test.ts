// The patient answers for themselves before joining (owner's test team, 23 Nov: "the patient does not
// get a consent screen which is necessary before joining the call"). Agreeing on their link is their
// consent; a call they declined goes ahead and nothing of it is kept, whatever the doctor's browser sends.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachTrack, browserClient, localStack, newPractitioner, rpc, sqlAsOwner, type Practitioner } from "./local-stack";

const stack = localStack();
let eva: Practitioner;
beforeAll(async () => {
  eva = await newPractitioner(stack, "consent-eva");
});
// The pieces these tests send are not audio: none may be left waiting for the engine tests that follow.
afterAll(() => sqlAsOwner(`update public.live_pieces set status = 'failed' where status = 'waiting'
  and consultation_id in (select id from public.consultations where practitioner_id = '${eva.id}');`));

/** A consultation, with or without the doctor's own record of consent, and the patient's link. */
async function consultation(doctorRecordedConsent: boolean) {
  const made = await rpc(eva.client, "create_consultation", {
    p_scheduled_at: "2026-11-23T09:00:00Z", p_language: "en", p_consent_recorded: doctorRecordedConsent,
  });
  const { data } = await eva.client.from("consultations").select("invite_token").eq("id", made.consultation_id!).single();
  return { id: made.consultation_id as string, token: data!.invite_token as string };
}
const answer = (token: string, agree: boolean) => rpc(browserClient(stack), "patient_recording_choice", { p_token: token, p_agree: agree });
const row = async (id: string) => (await eva.client.from("consultations")
  .select("status, patient_recording, consent_recorded_at").eq("id", id).single()).data;
async function livePiece(id: string) {
  await eva.client.storage.from("audio").upload(`${eva.id}/${id}/live/patient-0`, Buffer.from("OggS piece"), { contentType: "audio/ogg" });
  return rpc(eva.client, "add_live_piece", { p_consultation_id: id, p_speaker: "patient", p_seq: 0, p_offset_seconds: 0 });
}

describe("the patient's own answer to recording", () => {
  it("agreeing on their link is their consent: the call can be recorded", async () => {
    const { id, token } = await consultation(false);
    expect(await answer(token, true)).toEqual({ ok: true });
    expect(await row(id)).toMatchObject({ status: "ready_for_audio", patient_recording: "agreed", consent_recorded_at: expect.any(String) });
    expect(await rpc(browserClient(stack), "recording_question", { p_token: token })).toMatchObject({ ok: true, recording: "agreed" });
    expect(await livePiece(id)).toEqual({ ok: true });
  });

  it("a call the patient declined keeps nothing, even with the doctor's own record of consent", async () => {
    const { id, token } = await consultation(true);
    expect(await answer(token, false)).toEqual({ ok: true });
    expect(await row(id)).toMatchObject({ patient_recording: "declined" });
    await expect(livePiece(id)).rejects.toThrow(/RECORDING_DECLINED/);
    await expect(attachTrack(eva, id, "practitioner")).rejects.toThrow(/RECORDING_DECLINED/);
  });

  it("can be changed before anything is recorded, not after", async () => {
    const { id, token } = await consultation(true);
    await answer(token, false);
    expect(await answer(token, true)).toEqual({ ok: true });
    expect(await livePiece(id)).toEqual({ ok: true });
    expect(await answer(token, false)).toMatchObject({ ok: false, error_category: "RECORDING_KEPT" });
    expect(await row(id)).toMatchObject({ patient_recording: "agreed" });
  });

  it("needs the patient's own link", async () => {
    expect(await answer("0".repeat(64), true)).toMatchObject({ ok: false, error_category: "NOT_FOUND" });
  });
});
