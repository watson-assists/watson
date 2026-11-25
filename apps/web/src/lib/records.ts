// The practitioner's consultations as they are taken out of Watson (owner, 24 Oct): one, or all of
// them; never the conversation (owner, 23 Nov). Row-level security keeps every query to the practitioner's own.
import type { ConsultationRecord, FormAnswer, FormTemplate } from "./export";
import { currentFormRevision } from "./form-revisions";
import { PATIENT_COLUMNS, shownPatient, type PatientColumns, type Person } from "./patient";
import { loginName } from "./session";
import { supabase } from "./supabase";

type Row = PatientColumns & { id: string; scheduled_at: string; synthetic_patient_ref: string };
type Form = { consultation_id: string; template: unknown; approved_at: string | null;
  revision_number: number; revision_kind: string; template_hash: string;
  form_answers: FormAnswer[]; form_signatures: import("./export").FormSignature[] };

/** One consultation, or every one the practitioner has, newest first. */
export async function loadRecords(consultationId?: string): Promise<ConsultationRecord[] | null> {
  let consultations = supabase.from("consultations").select(`id, scheduled_at, synthetic_patient_ref, ${PATIENT_COLUMNS}`)
    .filter("released", "eq", false).order("scheduled_at", { ascending: false });
  if (consultationId) consultations = consultations.eq("id", consultationId);
  let forms = supabase.from("forms").select("consultation_id, template, approved_at, revision_number, revision_kind, template_hash, form_answers(field_key, machine_text, practitioner_text, review, value_type, answer_state, machine_value, practitioner_value), form_signatures(field_key, signer_role, method, signed_name, signed_at)")
    .neq("status", "superseded").order("revision_number", { ascending: true });
  if (consultationId) forms = forms.eq("consultation_id", consultationId);
  const [rows, filled, profile, user] = await Promise.all([
    consultations, forms, supabase.from("practitioner_profiles").select("display_name").maybeSingle(), supabase.auth.getUser(),
  ]);
  if (rows.error || filled.error) return null;
  const practitioner = profile.data?.display_name ?? loginName(user.data.user?.email);
  const grouped = new Map<string, Form[]>();
  for (const form of (filled.data ?? []) as Form[]) {
    grouped.set(form.consultation_id, [...(grouped.get(form.consultation_id) ?? []), form]);
  }
  const byConsultation = new Map([...grouped].flatMap(([id, revisions]) => {
    const current = currentFormRevision(revisions);
    return current ? [[id, current] as const] : [];
  }));
  const rowsOf = (rows.data ?? []) as unknown as Row[];
  const earlier = await earlierPatients(rowsOf);
  return rowsOf.map((row) => {
    const person = shownPatient(row, earlier);
    return { patient: person?.name ?? row.synthetic_patient_ref, contact: contactOf(person),
      scheduledAt: row.scheduled_at, practitioner, ...formPart(byConsultation.get(row.id)) };
  });
}

const contactOf = (person: Person | null | undefined) => person?.phone ?? person?.email ?? "";

/** The current form of a consultation, as a record carries it; empty when there is none yet. */
const formPart = (form: Form | undefined) => form ? {
  approvedAt: form.approved_at, template: form.template as FormTemplate, answers: form.form_answers,
  revision: form.revision_number, revisionKind: form.revision_kind, templateHash: form.template_hash, signatures: form.form_signatures,
} : { approvedAt: null, template: null, answers: [], revision: null, revisionKind: null, templateHash: null, signatures: [] };

/** The practitioner's own patients that consultations from before the patient check were linked to, by id. */
export async function earlierPatients(rows: PatientColumns[]): Promise<Map<string, Person>> {
  const ids = [...new Set(rows.flatMap((row) =>
    row.patient_association_state === "legacy_unverified" && row.legacy_patient_id ? [row.legacy_patient_id] : []))];
  if (ids.length === 0) return new Map();
  const { data } = await supabase.from("patients").select("id, name, phone, email").in("id", ids);
  return new Map((data ?? []).map(({ id, ...person }) => [id, person]));
}
