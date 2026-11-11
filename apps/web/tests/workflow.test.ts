// The rules of MASTER_BUILD_SPEC.md sections 10.2, 10.4 and 15, exercised through
// the same database functions the web app calls.
import { beforeAll, describe, expect, it } from "vitest";
import {
  attachTrack, createConsultation, FIXTURE_WAV, localStack, newPractitioner, rpc,
  SHA256_OF_FIXTURE, sqlAsOwner, type Practitioner,
} from "./local-stack";

const stack = localStack();
let cara: Practitioner;
beforeAll(async () => {
  cara = await newPractitioner(stack, "cara");
});

const statusOf = async (id: string) =>
  (await cara.client.from("consultations").select("status").eq("id", id).single()).data?.status;
const eventsOf = async (id: string) =>
  (await cara.client.from("audit_events").select("event_type, result, metadata_without_clinical_content").eq("consultation_id", id).order("seq")).data ?? [];

describe("creating a consultation", () => {
  it("waits for consent when none is recorded, then moves on when it is", async () => {
    const id = await createConsultation(cara, { consent: false });
    expect(await statusOf(id)).toBe("consent_pending");
    expect(await rpc(cara.client, "record_consent", { p_consultation_id: id })).toEqual({ ok: true });
    expect(await statusOf(id)).toBe("ready_for_audio");
  });

  it("refuses a patient reference that is not synthetic", async () => {
    for (const ref of ["Maria Novak", "maria@example.com", "SYN-", "SYN-123456789", "syn-1"]) {
      const result = await rpc(cara.client, "create_consultation", { p_synthetic_patient_ref: ref, p_scheduled_at: "2026-10-05T08:30:00Z", p_language: "en", p_consent_recorded: true });
      expect(result, ref).toEqual({ ok: false, error_category: "VALIDATION", field: "synthetic_patient_ref" });
    }
  });

  it("refuses notes that are too long", async () => {
    const result = await rpc(cara.client, "create_consultation", { p_synthetic_patient_ref: "SYN-7", p_scheduled_at: "2026-10-05T08:30:00Z", p_language: "en", p_consent_recorded: true, p_scenario_notes: "x".repeat(501) });
    expect(result).toEqual({ ok: false, error_category: "VALIDATION", field: "scenario_notes" });
  });
});

describe("a transition the rules do not allow", () => {
  it("is refused, changes nothing, and is recorded", async () => {
    const id = await createConsultation(cara, { consent: true });
    expect(await rpc(cara.client, "record_consent", { p_consultation_id: id })).toEqual({ ok: false, error_category: "INVALID_STATE_TRANSITION" });
    expect(await statusOf(id)).toBe("ready_for_audio");
    expect((await eventsOf(id)).at(-1)).toEqual({
      event_type: "state.transition_rejected", result: "rejected",
      metadata_without_clinical_content: { attempted: "record_consent", from_status: "ready_for_audio" },
    });
  });
});

describe("audio", () => {
  it("cannot be attached before consent, neither the file nor its record", async () => {
    const id = await createConsultation(cara, { consent: false });
    const upload = await cara.client.storage.from("audio").upload(`${cara.id}/${id}/patient`, FIXTURE_WAV);
    expect(upload.error).not.toBeNull();
    const register = await rpc(cara.client, "register_audio_track", { p_consultation_id: id, p_speaker: "patient", p_format: "wav", p_size_bytes: FIXTURE_WAV.byteLength, p_sha256: SHA256_OF_FIXTURE });
    expect(register).toEqual({ ok: false, error_category: "CONSENT_MISSING" });
  });

  it("moves the consultation on when both tracks are attached, and back when one is removed", async () => {
    const id = await createConsultation(cara);
    expect((await attachTrack(cara, id, "practitioner")).ok).toBe(true);
    expect(await statusOf(id)).toBe("ready_for_audio");
    expect((await attachTrack(cara, id, "patient")).ok).toBe(true);
    expect(await statusOf(id)).toBe("audio_imported");

    expect(await rpc(cara.client, "remove_audio_track", { p_consultation_id: id, p_speaker: "patient" })).toEqual({ ok: true });
    expect(await statusOf(id)).toBe("ready_for_audio");
    expect((await eventsOf(id)).map((event) => event.event_type)).toEqual([
      "form_template.pinned", "consultation.created", "consent.recorded",
      "audio.imported", "audio.imported", "audio.removed",
    ]);
  });

  it("is refused when the record does not match what was stored", async () => {
    const id = await createConsultation(cara);
    const base = { p_consultation_id: id, p_speaker: "patient", p_format: "wav", p_size_bytes: FIXTURE_WAV.byteLength, p_sha256: SHA256_OF_FIXTURE };
    expect(await rpc(cara.client, "register_audio_track", base)).toEqual({ ok: false, error_category: "AUDIO_FILE_MISSING" });

    await cara.client.storage.from("audio").upload(`${cara.id}/${id}/patient`, FIXTURE_WAV, { contentType: "audio/wav" });
    expect(await rpc(cara.client, "register_audio_track", { ...base, p_size_bytes: 12 })).toEqual({ ok: false, error_category: "AUDIO_CORRUPT" });
    expect(await rpc(cara.client, "register_audio_track", { ...base, p_format: "exe" })).toEqual({ ok: false, error_category: "AUDIO_FORMAT_UNSUPPORTED" });
    expect(await rpc(cara.client, "register_audio_track", { ...base, p_size_bytes: 60 * 1024 * 1024 })).toEqual({ ok: false, error_category: "AUDIO_TOO_LARGE" });
    expect(await rpc(cara.client, "register_audio_track", { ...base, p_duration_seconds: 9000 })).toEqual({ ok: false, error_category: "AUDIO_DURATION_INVALID" });
    expect(await rpc(cara.client, "register_audio_track", { ...base, p_sha256: "not-a-hash" })).toMatchObject({ ok: false, error_category: "VALIDATION" });
    expect((await rpc(cara.client, "register_audio_track", base)).ok).toBe(true);
    // The same speaker cannot be attached twice.
    expect(await rpc(cara.client, "register_audio_track", base)).toEqual({ ok: false, error_category: "INVALID_STATE_TRANSITION" });
  });
});

describe("the audit log", () => {
  it("holds no clinical content and verifies as an unbroken chain", async () => {
    const id = await createConsultation(cara);
    await attachTrack(cara, id, "patient");
    const events = await eventsOf(id);
    expect(JSON.stringify(events)).not.toContain("sleep complaint"); // the scenario notes never reach the log
    expect((await cara.client.rpc("verify_audit_chain", { p_consultation_id: id })).data).toBe(true);
  });

  it("no longer verifies after an event is altered or removed", async () => {
    const altered = await createConsultation(cara);
    await attachTrack(cara, altered, "patient");
    sqlAsOwner(`update public.audit_events set result = 'failure' where consultation_id = '${altered}' and event_type = 'consent.recorded';`);
    expect((await cara.client.rpc("verify_audit_chain", { p_consultation_id: altered })).data).toBe(false);

    const removed = await createConsultation(cara);
    await attachTrack(cara, removed, "patient");
    sqlAsOwner(`delete from public.audit_events where consultation_id = '${removed}' and event_type = 'consent.recorded';`);
    expect((await cara.client.rpc("verify_audit_chain", { p_consultation_id: removed })).data).toBe(false);
  });

  it("refuses metadata keys outside the allow-list", async () => {
    const id = await createConsultation(cara);
    expect(() => sqlAsOwner(`select private.log_event('${id}', 'x.y', 'tester', 'practitioner', 'consultation', null, 'success', '{"transcript_text": "anything"}');`)).toThrow();
  });
});
