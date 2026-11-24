// What the consultation page reads, and what its four steps say. Row-level security keeps every query
// to the practitioner's own.
import type { Candidate } from "@/components/patient-check";
import type { Tables } from "./database.types";
import type { FormAnswer, FormTemplate } from "./export";
import { shownPatient, type Shown } from "./patient";
import { earlierPatients } from "./records";
import { dayMonth, summarise } from "./status";
import { supabase } from "./supabase";

export type Consultation = Tables<"consultations">;
export type Track = Tables<"audio_tracks">;
export type Patient = Pick<Tables<"patients">, "id" | "name" | "phone" | "email">;
export type History = Pick<Consultation, "id" | "scheduled_at" | "language" | "status" | "patient_association_state">;
export type PreviousContext = { scheduledAt: string; template: FormTemplate; answers: FormAnswer[] };
export type Loaded = {
  consultation: Consultation; tracks: Track[]; audioLeft: boolean; hasTranscript: boolean; patient: Patient | null;
  shown: Shown | null; candidate: Candidate | null; history: History[] | "failed" | null;
  previousContext: PreviousContext | null;
};

export const SPEAKERS = ["practitioner", "patient"] as const;
export const FORM_STATUSES = ["transcript_ready", "transcript_reviewed", "extraction_processing", "extraction_failed",
  "draft_ready", "under_review", "approved"];
export const HAS_TRANSCRIPT = ["transcript_ready", "transcript_under_review", "transcript_reviewed", "extraction_processing",
  "extraction_failed", "draft_ready", "under_review", "approved", "corrected", "archived"];

/** The patient's earlier consultations; null until the patient is known; "failed" when they could not be read. */
async function loadHistory(row: Consultation): Promise<Loaded["history"]> {
  if (!row.patient_id) return null;
  const earlier = await supabase.from("consultations").select("id, scheduled_at, language, status, patient_association_state")
    .eq("patient_id", row.patient_id).neq("id", row.id).lt("scheduled_at", row.scheduled_at)
    .filter("released", "eq", false).order("scheduled_at", { ascending: false });
  return earlier.error ? "failed" : earlier.data;
}

/** The previous appointment the doctor linked: when it was, and its approved form. */
async function loadPreviousContext(row: Consultation): Promise<PreviousContext | null> {
  if (!row.previous_consultation_id) return null;
  const [previous, previousForm] = await Promise.all([
    supabase.from("consultations").select("scheduled_at").eq("id", row.previous_consultation_id).maybeSingle(),
    supabase.from("forms").select("template, form_answers(field_key, machine_text, practitioner_text, review, value_type, answer_state, machine_value, practitioner_value)")
      .eq("consultation_id", row.previous_consultation_id).eq("status", "approved")
      .order("revision_number", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (!previous.data || !previousForm.data) return null;
  return { scheduledAt: previous.data.scheduled_at, template: previousForm.data.template as unknown as FormTemplate,
    answers: previousForm.data.form_answers as FormAnswer[] };
}

/** Who the consultation is with, and whom to ask the doctor about (components/patient-check.tsx). */
async function loadPerson(row: Consultation, patient: Patient | null) {
  const columns = { ...row, patients: patient };
  const earlier = await earlierPatients([columns]);
  const shown = shownPatient(columns, earlier);
  const before = row.legacy_patient_id ? earlier.get(row.legacy_patient_id) : undefined;
  const candidate = shown?.check === "earlier" && before ? { id: row.legacy_patient_id!, ...before }
    : shown?.check === "typed" ? (await supabase.from("patients").select("id, name, phone, email")
      .eq(row.patient_claim_phone ? "phone" : "email", row.patient_claim_phone ?? row.patient_claim_email!).maybeSingle()).data
    : null;
  return { shown, candidate };
}

export async function fetchConsultation(id: string, userId: string): Promise<Loaded | "missing" | "failed"> {
  const [consultation, tracks, transcript] = await Promise.all([
    supabase.from("consultations").select("*").eq("id", id).maybeSingle(),
    supabase.from("audio_tracks").select("*").eq("consultation_id", id),
    supabase.from("transcripts").select("id").eq("consultation_id", id).neq("review_status", "superseded").maybeSingle(),
  ]);
  if (consultation.error || tracks.error || transcript.error) return "failed";
  if (!consultation.data) return "missing";
  const row = consultation.data;
  // After a withdrawal, files that could not be deleted are offered for deletion again.
  const files = row.status === "consent_withdrawn" ? (await supabase.storage.from("audio").list(`${userId}/${id}`)).data ?? [] : [];
  const patient = row.patient_id
    ? (await supabase.from("patients").select("id, name, phone, email").eq("id", row.patient_id).maybeSingle()).data
    : null;
  const [history, previousContext, person] = await Promise.all([loadHistory(row), loadPreviousContext(row), loadPerson(row, patient)]);
  return { consultation: row, tracks: tracks.data, audioLeft: files.length > 0, hasTranscript: transcript.data !== null,
    patient, ...person, history, previousContext };
}

/** What each of the four steps says under its bar. */
export function stepLines({ consultation, tracks, hasTranscript }: Loaded): string[] {
  const { stages } = summarise(consultation.status);
  // A form made without a recording (owner's test team, 23 Nov): nothing was recorded or transcribed.
  const unrecorded = stages[1] === "done" && tracks.length === 0 && !hasTranscript;
  return [
    consultation.consent_withdrawn_at ? `Withdrawn ${dayMonth(consultation.consent_withdrawn_at)}`
      : consultation.patient_recording === "declined" ? "Patient said no to recording"
      : consultation.patient_recording === "agreed" ? `Patient agreed ${dayMonth(consultation.patient_recording_at!)}`
      : consultation.consent_recorded_at ? `Recorded ${dayMonth(consultation.consent_recorded_at)}` : "Not recorded yet",
    unrecorded ? "Not recorded" : stages[1] === "done" ? "Recorded" : stages[1] === "current" && tracks.length > 0 ? "Saved in part" : "Not yet",
    unrecorded ? "No transcript" : { current: consultation.status === "transcription_processing" ? "Transcribing" : "Ready to start", failed: "Failed", done: "Done" }[
      stages[2] as "current" | "failed" | "done"] ?? "Not yet",
    ({ transcript_ready: "Not set up", transcript_reviewed: "Not set up", extraction_processing: "Filling in",
      extraction_failed: "Failed", draft_ready: "Ready to check", under_review: "Checking", approved: "Approved" } as Record<string, string>)[
      consultation.status] ?? "Not yet",
  ];
}
