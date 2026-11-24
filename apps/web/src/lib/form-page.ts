// What the form page reads: the consultation, its current form with every answer, the conversation the
// answers quote, the documents they quote, and what Watson did not have when it filled the form in.
import type { Tables } from "./database.types";
import type { Viewable } from "./documents";
import { supabase } from "./supabase";

export type Answer = Tables<"form_answers">;
export type Segment = Pick<Tables<"transcript_segments">, "position" | "speaker" | "start_seconds" | "machine_text" | "reviewed_text">;
type Localized = { en: string; sk: string };
type Option = { key: string; label: string; label_i18n?: Localized };
export type Field = { key: string; label: string; label_i18n?: Localized;
  mode?: "extract" | "suggest" | "manual"; value_type?: string; options?: Option[];
  item_fields?: Field[]; required?: boolean; clinician_confirmation?: boolean };
export type Template = { title: string; title_i18n?: Localized;
  sections: { title: string; title_i18n?: Localized; fields: Field[] }[];
  approval_gates?: { key: string; type: "attestation" | "signature"; field_key: string;
    signer_role?: "patient" | "practitioner" }[] };
export type DocumentQuote = { document_id: string; page: number; text: string };
export type Loaded = {
  consultation: Tables<"consultations">;
  patientName: string | null;
  form: Tables<"forms">;
  answers: Answer[];
  segments: Map<number, Segment>;
  // The patient's documents the answers quote: name and where to open it.
  documents: Map<string, Viewable>;
  // Documents Watson did not have when it filled the form in (read after the engine took the job,
  // and not quoted): reason to fill it in again.
  late: { file_name: string; source: string; uploaded_at: string }[];
  attestations: Tables<"form_attestations">[];
  signatures: Tables<"form_signatures">[];
  conflicts: Tables<"form_reconciliation_conflicts">[];
};

/** Who sent a document, in the practitioner's words. */
export const SENT_BY: Record<string, string> = {
  whatsapp: "sent by the patient on WhatsApp",
  patient: "sent by the patient from their link",
  practitioner: "added by you",
};

/** How far the practitioner's check of an answer got. */
export const CHIP: Record<Answer["review"], [string, string]> = {
  unreviewed: ["wa-chip--attention", "To check"],
  accepted: ["wa-chip--done", "Accepted"],
  edited: ["wa-chip--current", "Edited by you"],
  rejected: ["wa-chip--failed", "Rejected"],
};

export const documentQuotes = (answer: Answer) => (answer.document_quotes ?? []) as unknown as DocumentQuote[];

export async function fetchForm(id: string): Promise<Loaded | "missing" | "failed"> {
  const [consultation, form] = await Promise.all([
    supabase.from("consultations").select("*").eq("id", id).maybeSingle(),
    supabase.from("forms").select("*, form_jobs!forms_job_id_fkey(claimed_at)").eq("consultation_id", id)
      .neq("status", "superseded").order("revision_number", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (consultation.error || form.error) return "failed";
  if (!consultation.data || !form.data) return "missing";
  const [answers, segments, attestations, signatures, conflicts] = await Promise.all([
    supabase.from("form_answers").select("*").eq("form_id", form.data.id).order("position"),
    form.data.transcript_id
      ? supabase.from("transcript_segments").select("position, speaker, start_seconds, machine_text, reviewed_text").is("removed_at", null)
        .eq("transcript_id", form.data.transcript_id).order("position")
      : Promise.resolve({ data: [] as Segment[], error: null }), // made without a recording (owner's test team, 23 Nov)
    supabase.from("form_attestations").select("*").eq("form_id", form.data.id),
    supabase.from("form_signatures").select("*").eq("form_id", form.data.id),
    supabase.from("form_reconciliation_conflicts").select("*").eq("form_id", form.data.id).order("created_at"),
  ]);
  if (answers.error || segments.error || attestations.error || signatures.error || conflicts.error) return "failed";
  const quoted = [...new Set(answers.data.flatMap((answer) => documentQuotes(answer).map((quote) => quote.document_id)))];
  const [patient, documents, late] = await Promise.all([
    consultation.data.patient_id
      ? supabase.from("patients").select("name").eq("id", consultation.data.patient_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("patient_documents").select("id, file_name, storage_path, media_type").eq("consultation_id", id)
      .eq("reading", "read").is("removed_at", null),
    supabase.from("patient_documents").select("id, file_name, source, uploaded_at").eq("consultation_id", id)
      .eq("reading", "read").gt("read_at", form.data.form_jobs?.claimed_at ?? form.data.created_at).order("uploaded_at"),
  ]);
  return {
    consultation: consultation.data,
    patientName: patient.data?.name ?? consultation.data.patient_claim_name ?? null,
    form: form.data,
    answers: answers.data,
    segments: new Map(segments.data.map((segment) => [segment.position, segment])),
    documents: new Map((documents.data ?? []).map((document) => [document.id, document])),
    late: (late.data ?? []).filter((document) => document.uploaded_at !== null && !quoted.includes(document.id)) as Loaded["late"],
    attestations: attestations.data,
    signatures: signatures.data,
    conflicts: conflicts.data,
  };
}
