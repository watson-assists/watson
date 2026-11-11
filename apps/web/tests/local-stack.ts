// Helpers for tests that run against the local Supabase stack (`supabase start`).
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/database.types";

export const PASSWORD = "correct-horse-battery-1";
export const FIXTURE_WAV = readFileSync(
  new URL("../../../packages/test-fixtures/audio/en-patient-sleep.wav", import.meta.url),
);

export function localStack() {
  const raw = execSync("supabase status -o json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const status = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  return {
    url: status.API_URL as string,
    publishableKey: status.PUBLISHABLE_KEY as string,
    secretKey: status.SECRET_KEY as string,
  };
}
type Stack = ReturnType<typeof localStack>;

const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false } };

/** The engine credential. It reads everything but changes state only through functions. */
export function adminClient(stack: Stack) {
  return createClient<Database>(stack.url, stack.secretKey, NO_SESSION);
}

/** What the browser has: the public key, and whatever the signed-in user is allowed. */
export function browserClient(stack: Stack) {
  return createClient<Database>(stack.url, stack.publishableKey, NO_SESSION);
}

/** A brand-new practitioner with a unique email, signed in the way a browser would be. */
export async function newPractitioner(stack: Stack, label: string) {
  const email = `${label}-${randomUUID().slice(0, 8)}@watson.test`;
  const created = await adminClient(stack).auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (created.error) throw created.error;
  sqlAsOwner(`insert into private.user_roles (user_id, role) values ('${created.data.user.id}', 'practitioner');`);
  const client = browserClient(stack);
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return { id: created.data.user.id, email, client };
}
export type Practitioner = Awaited<ReturnType<typeof newPractitioner>>;

/** A database function's answer: {ok: true, ...} or {ok: false, error_category, field?}. */
export type Answer = Record<string, unknown> & {
  ok: boolean; error_category?: string; field?: string; consultation_id?: string; track_id?: string;
};

/** Calls a database function as this client and returns its answer; a refused call fails the test. */
export async function rpc(client: Practitioner["client"], name: string, args: object = {}): Promise<Answer> {
  const { data, error } = await client.rpc(name as never, args as never);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data as unknown as Answer;
}

/** A new account registered as an engine, the way the laptop's engine is. */
export async function newEngine(stack: Stack, label: string) {
  const who = await newPractitioner(stack, label);
  sqlAsOwner(`delete from private.user_roles where user_id = '${who.id}' and role = 'practitioner';`);
  const { error } = await adminClient(stack).rpc("register_engine", { p_user_id: who.id, p_label: label });
  if (error) throw error;
  return who;
}

export type FormJob = { job_id: string; attempt: number; consultation_id: string; documents: { document_id: string; pages: string[] }[] };

/** Claims form jobs until it gets this consultation's; others left by earlier runs are failed. */
export async function claimFormJob(engine: Practitioner, consultationId: string): Promise<FormJob> {
  for (let i = 0; i < 50; i++) {
    const job = (await rpc(engine.client, "engine_claim_form_job")).job as FormJob | null;
    if (!job) break;
    if (job.consultation_id === consultationId) return job;
    await rpc(engine.client, "engine_fail_form_job", { p_job_id: job.job_id, p_attempt: job.attempt, p_error_category: "FORM_FAILED" });
  }
  throw new Error("form job was never offered to the engine");
}

/** A finished transcript of one patient line and a queued form job, as transcription would leave them. */
export function transcriptWithFormJob(consultationId: string) {
  sqlAsOwner(`
    update public.consultations
      set form_template_version_id = coalesce(
        form_template_version_id,
        (select id from public.form_template_versions
         where is_built_in and template_key = 'watson_standard'
         order by version_number desc limit 1)
      )
      where id = '${consultationId}';
    with j as (insert into public.transcription_jobs (consultation_id, requested_by, status, finished_at)
               select id, practitioner_id, 'completed', now() from public.consultations where id = '${consultationId}' returning id),
    t as (insert into public.transcripts (consultation_id, job_id, schema_version, ordering, low_confidence_threshold, tracks)
          select '${consultationId}', id, '2.0.0', 'exact', 0.5, '[]' from j returning id),
    s as (insert into public.transcript_segments (id, transcript_id, position, speaker, start_seconds, end_seconds, machine_text)
          select gen_random_uuid(), t.id, 0, 'patient', 1, 4, 'I feel tired all the time.' from t returning 1)
    insert into public.form_jobs (consultation_id, transcript_id) select '${consultationId}', id from t;
    update public.consultations set status = 'extraction_processing' where id = '${consultationId}';`);
}

export async function createConsultation(who: Practitioner, options: { consent?: boolean; ref?: string } = {}) {
  const result = await rpc(who.client, "create_consultation", {
    p_synthetic_patient_ref: options.ref ?? "SYN-0042",
    p_scheduled_at: "2026-10-05T08:30:00Z",
    p_language: "en",
    p_consent_recorded: options.consent ?? true,
    p_scenario_notes: "sleep complaint",
  });
  if (!result.ok || !result.consultation_id) throw new Error(`create_consultation refused: ${result.error_category}`);
  return result.consultation_id;
}

export const SHA256_OF_FIXTURE = execSync(
  "sha256sum ../../packages/test-fixtures/audio/en-patient-sleep.wav", { encoding: "utf8" },
).split(" ")[0];

/** Uploads the fixture as one speaker's track and registers it, as the web app does. */
export async function attachTrack(who: Practitioner, consultationId: string, speaker: "practitioner" | "patient") {
  const path = `${who.id}/${consultationId}/${speaker}`;
  await who.client.storage.from("audio").remove([path]);
  const upload = await who.client.storage.from("audio").upload(path, FIXTURE_WAV, { contentType: "audio/wav" });
  if (upload.error) throw new Error(`upload refused: ${upload.error.message}`);
  return rpc(who.client, "register_audio_track", {
    p_consultation_id: consultationId, p_speaker: speaker, p_format: "wav",
    p_size_bytes: FIXTURE_WAV.byteLength, p_sha256: SHA256_OF_FIXTURE, p_duration_seconds: 7.49,
  });
}

/** Runs SQL as the database owner. For tests that must tamper with data directly. */
export function sqlAsOwner(sql: string) {
  return execSync(`docker exec -i supabase_db_watson psql -U postgres -d postgres -At -v ON_ERROR_STOP=1`, {
    input: sql, encoding: "utf8",
  }).trim();
}
