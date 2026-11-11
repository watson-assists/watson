// Transcription jobs and the engine contract (MASTER_BUILD_SPEC.md sections 8.2, 11, 12.4 and 12.7),
// exercised through the database functions a practitioner's browser and an engine call.
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  adminClient, attachTrack, createConsultation, localStack, newEngine, newPractitioner, rpc, SHA256_OF_FIXTURE, sqlAsOwner,
  type Practitioner,
} from "./local-stack";

const stack = localStack();
type Job = { job_id: string; attempt: number; consultation_id: string; language: string; tracks: { storage_path: string }[] };

/** Calls a database function as this practitioner or engine. */
const call = (who: Practitioner, name: string, args: object = {}) => rpc(who.client, name, args);

/** A consultation with consent and both tracks, ready for transcription. */
async function ready(who: Practitioner) {
  const id = await createConsultation(who);
  await attachTrack(who, id, "practitioner");
  await attachTrack(who, id, "patient");
  return id;
}

async function startAndClaim(who: Practitioner, engine: Practitioner) {
  const id = await ready(who);
  expect((await call(who, "start_transcription", { p_consultation_id: id })).ok).toBe(true);
  const job = (await call(engine, "engine_claim_job")).job as Job;
  expect(job.consultation_id).toBe(id);
  return { id, job };
}

const segment = (position: number, speaker: string, text: string, extra: object = {}) => ({
  segment_id: randomUUID(), position, speaker, start_seconds: position * 2, end_seconds: position * 2 + 1.5,
  machine_text: text, reviewed_text: null, confidence: 0.9, possibly_not_speech: false,
  review_status: "unreviewed", overlap: null, ...extra,
});

function transcript(consultationId: string, segments = [segment(0, "practitioner", "Good morning."), segment(1, "patient", "I sleep badly.")]) {
  return {
    schema_version: "2.0.0", consultation_id: consultationId, created_at_utc: new Date().toISOString(),
    ordering: "approximate", low_confidence_threshold: 0.5,
    tracks: ["practitioner", "patient"].map((speaker) => ({
      speaker, audio_sha256: SHA256_OF_FIXTURE, duration_seconds: 7.49, offset_seconds: 0, sync_method: "none",
      language: "en", language_probability: 0.99,
      transcription_model: { provider: "faster-whisper", model: "tiny", revision: null, device: "cpu", compute_type: "int8" },
    })),
    segments,
  };
}

const complete = (engine: Practitioner, job: Job, body: object, attempt = job.attempt) =>
  call(engine, "engine_complete_job", { p_job_id: job.job_id, p_attempt: attempt, p_transcript: body, p_metrics: {} });
const heartbeat = (engine: Practitioner, job: Job, attempt = job.attempt, audioSeconds: number | null = null) =>
  call(engine, "engine_heartbeat", { p_job_id: job.job_id, p_attempt: attempt, p_stage: "transcribing_patient", p_audio_seconds: audioSeconds });

let cara: Practitioner;
let engine: Practitioner;
const statusOf = async (id: string) =>
  (await cara.client.from("consultations").select("status").eq("id", id).single()).data?.status;
const eventsOf = async (id: string) =>
  ((await cara.client.from("audit_events").select("event_type").eq("consultation_id", id).order("seq")).data ?? [])
    .map((e) => e.event_type);

beforeAll(async () => {
  cara = await newPractitioner(stack, "cara");
  engine = await newEngine(stack, "engine");
});
beforeEach(() => {
  // One queue serves every test; start each from an empty one.
  sqlAsOwner("update public.transcription_jobs set status = 'cancelled', finished_at = now() where status in ('queued', 'processing');");
});

describe("who may do what", () => {
  it("refuses an engine account that tries to act as a practitioner", async () => {
    const result = await call(engine, "create_consultation", {
      p_synthetic_patient_ref: "SYN-1", p_scheduled_at: "2026-10-05T08:30:00Z", p_language: "en", p_consent_recorded: true,
    });
    expect(result).toEqual({ ok: false, error_category: "NOT_A_PRACTITIONER" });
  });

  it("refuses to make an engine of an account that has consultations", async () => {
    await createConsultation(cara);
    const { error } = await adminClient(stack).rpc("register_engine", { p_user_id: cara.id, p_label: "nope" });
    expect(error?.message).toMatch(/has consultations/);
  });

  it("refuses engine functions to practitioners", async () => {
    expect(await call(cara, "engine_claim_job")).toEqual({ ok: false, error_category: "NOT_AN_ENGINE" });
  });

  it("lets the engine read a job's audio only while it works on that job", async () => {
    const id = await ready(cara);
    const path = `${cara.id}/${id}/patient`;
    expect((await engine.client.storage.from("audio").download(path)).error).not.toBeNull();
    await call(cara, "start_transcription", { p_consultation_id: id });
    const job = (await call(engine, "engine_claim_job")).job as Job;
    expect((await engine.client.storage.from("audio").download(path)).error).toBeNull();
    expect((await complete(engine, job, transcript(id))).ok).toBe(true);
    expect((await engine.client.storage.from("audio").download(path)).error).not.toBeNull();
  });
});

describe("a job from start to transcript", () => {
  it("queues, runs and delivers a transcript the practitioner can read", async () => {
    const { id, job } = await startAndClaim(cara, engine);
    expect(job).toMatchObject({ attempt: 1, language: "en" });
    expect(job.tracks).toHaveLength(2);
    expect(await call(cara, "engine_status")).toMatchObject({ online: true });
    expect(await heartbeat(engine, job)).toEqual({ ok: true, continue: true });

    expect((await complete(engine, job, transcript(id))).ok).toBe(true);
    expect(await statusOf(id)).toBe("extraction_processing");
    const { data: current } = await cara.client.from("transcripts").select("id").eq("consultation_id", id).single();
    const { data: segments } = await cara.client.from("transcript_segments")
      .select("position, speaker, machine_text").eq("transcript_id", current?.id ?? "").order("position");
    expect(segments).toEqual([
      { position: 0, speaker: "practitioner", machine_text: "Good morning." },
      { position: 1, speaker: "patient", machine_text: "I sleep badly." },
    ]);
    expect(await eventsOf(id)).toEqual(expect.arrayContaining(["transcription.queued", "transcription.started", "transcription.completed"]));
  });

  it("cancels a job only while it waits for an engine", async () => {
    const id = await ready(cara);
    await call(cara, "start_transcription", { p_consultation_id: id });
    expect(await call(cara, "cancel_transcription", { p_consultation_id: id })).toEqual({ ok: true });
    expect(await statusOf(id)).toBe("audio_imported");
    await call(cara, "start_transcription", { p_consultation_id: id });
    await call(engine, "engine_claim_job");
    expect((await call(cara, "cancel_transcription", { p_consultation_id: id })).ok).toBe(false);
  });

  it("never hands one job to two engines", async () => {
    const second = await newEngine(stack, "engine-two");
    await call(cara, "start_transcription", { p_consultation_id: await ready(cara) });
    const answers = await Promise.all([call(engine, "engine_claim_job"), call(second, "engine_claim_job")]);
    expect(answers.filter((a) => a.job).length).toBe(1);
  });
});

describe("attempts", () => {
  it("takes back a stalled job and refuses everything from the stalled attempt", async () => {
    const { id, job } = await startAndClaim(cara, engine);
    sqlAsOwner(`update public.transcription_jobs set heartbeat_at = now() - interval '3 minutes' where id = '${job.job_id}';`);
    const retry = (await call(engine, "engine_claim_job")).job as Job;
    expect(retry).toMatchObject({ job_id: job.job_id, attempt: 2 });

    expect(await heartbeat(engine, job, 1)).toEqual({ ok: true, continue: false });
    expect(await complete(engine, job, transcript(id), 1)).toEqual({ ok: false, error_category: "JOB_NOT_YOURS" });
    expect(await call(engine, "engine_fail_job", { p_job_id: job.job_id, p_attempt: 1, p_error_category: "TRANSCRIPTION_FAILED" }))
      .toEqual({ ok: false, error_category: "JOB_NOT_YOURS" });
    expect((await complete(engine, retry, transcript(id))).ok).toBe(true);
    expect(await eventsOf(id)).toContain("transcription.requeued");
  });

  it("fails a job that stalled three times", async () => {
    const { id, job } = await startAndClaim(cara, engine);
    sqlAsOwner(`update public.transcription_jobs set attempt = 3, heartbeat_at = now() - interval '3 minutes' where id = '${job.job_id}';`);
    await call(engine, "engine_claim_job");
    expect(await statusOf(id)).toBe("transcription_failed");
    const { data } = await cara.client.from("transcription_jobs").select("status, error_category").eq("id", job.job_id).single();
    expect(data).toEqual({ status: "failed", error_category: "ENGINE_STALLED" });
  });

  it("stops a job that runs past its time limit", async () => {
    const { id, job } = await startAndClaim(cara, engine);
    sqlAsOwner(`update public.transcription_jobs set claimed_at = now() - interval '6 minutes' where id = '${job.job_id}';`);
    expect(await heartbeat(engine, job, job.attempt, 10)).toEqual({ ok: true, continue: false });
    expect(await statusOf(id)).toBe("transcription_failed");
  });
});

describe("a transcript is checked whole before it is written", () => {
  const bad = (id: string): [string, object][] => [
    ["a segment that ends before it starts", transcript(id, [segment(0, "patient", "SECRET-SENTENCE", { end_seconds: 0, start_seconds: 5 })])],
    ["a confidence above 1", transcript(id, [segment(0, "patient", "SECRET-SENTENCE", { confidence: 2 })])],
    ["missing text", transcript(id, [segment(0, "patient", "x", { machine_text: null })])],
    ["a gap in positions", transcript(id, [segment(0, "patient", "a"), segment(2, "patient", "b")])],
    ["an overlap when the tracks share no clock", transcript(id, [segment(0, "patient", "a", { overlap: true })])],
    ["exact order when the tracks were not recorded together", { ...transcript(id), ordering: "exact" }],
    ["a track that is not the registered file", { ...transcript(id), tracks: transcript(id).tracks.map((t) => ({ ...t, audio_sha256: "0".repeat(64) })) }],
    ["an unknown speaker", transcript(id, [segment(0, "narrator", "SECRET-SENTENCE")])],
  ];

  it("refuses each kind of bad transcript without writing anything or echoing its text", async () => {
    const { id, job } = await startAndClaim(cara, engine);
    for (const [what, body] of bad(id)) {
      const answer = await complete(engine, job, body);
      expect(answer, what).toEqual({ ok: false, error_category: "VALIDATION", field: "transcript" });
      expect(JSON.stringify(answer)).not.toContain("SECRET");
    }
    expect(await statusOf(id)).toBe("transcription_processing");
    expect((await cara.client.from("transcripts").select("id").eq("consultation_id", id)).data).toEqual([]);
  });
});

describe("withdrawing consent", () => {
  it("stops the engine, removes the records, and records the files' deletion only once they are gone", async () => {
    const { id, job } = await startAndClaim(cara, engine);
    expect(await call(cara, "withdraw_consent", { p_consultation_id: id })).toEqual({ ok: true });
    expect(await heartbeat(engine, job)).toEqual({ ok: true, continue: false });
    expect(await complete(engine, job, transcript(id))).toEqual({ ok: false, error_category: "JOB_NOT_YOURS" });
    expect(await statusOf(id)).toBe("consent_withdrawn");

    expect(await call(cara, "confirm_audio_deleted", { p_consultation_id: id })).toEqual({ ok: false, error_category: "AUDIO_NOT_DELETED" });
    expect(await eventsOf(id)).not.toContain("audio.deleted");
    const removed = await cara.client.storage.from("audio").remove(["practitioner", "patient"].map((s) => `${cara.id}/${id}/${s}`));
    expect(removed.error).toBeNull();
    expect(await call(cara, "confirm_audio_deleted", { p_consultation_id: id })).toEqual({ ok: true });
    expect(await eventsOf(id)).toEqual(expect.arrayContaining(["audio.deletion_requested", "audio.deleted"]));
  });
});
