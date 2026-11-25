// Home: the practitioner's consultations, how they are found, sorted and counted, and what each needs next.
import { clockTime, viewerZone } from "./booking";
import type { ConsultationTab } from "./consultation-tabs";
import type { PatientColumns, Shown } from "./patient";
import { dateTime, LANGUAGE_LABEL, summarise, type ConsultationStatus } from "./status";

export type Row = {
  id: string; synthetic_patient_ref: string; scheduled_at: string; updated_at: string;
  language: keyof typeof LANGUAGE_LABEL; status: ConsultationStatus;
  fee_cents: number | null; paid_at: string | null;
  forms: { form_answers: { machine_text: string | null }[] }[];
} & PatientColumns & { person: Shown | null };
/** The patient's name once known, else the consultation's reference. */
export const who = (row: Row) => row.person?.name ?? row.synthetic_patient_ref;

// Finding and ordering patients (owner, 24 Oct: "the ability to search ... sorted by patient last name").
export type Sort = "name" | "date";
const plain = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
/** A row matches by the patient's name, email or phone, or by the consultation's number; accents optional. */
export function matches(row: Row, query: string): boolean {
  const wanted = plain(query.trim());
  if (!wanted) return true;
  const digits = wanted.replace(/\D/g, "");
  return [row.person?.name, row.person?.email, row.synthetic_patient_ref].some((text) => text && plain(text).includes(wanted))
    || (digits.length >= 3 && (row.person?.phone ?? "").replace(/\D/g, "").includes(digits));
}
const collator = new Intl.Collator("sk", { sensitivity: "base" });
const lastName = (name: string) => name.trim().split(/\s+/).at(-1) ?? "";
export const newestFirst = (a: Row, b: Row) => Date.parse(b.scheduled_at) - Date.parse(a.scheduled_at);
/** By last name, then first name; consultations without a named patient last, newest first. */
export function byLastName(a: Row, b: Row): number {
  if (!a.person || !b.person) return a.person ? -1 : b.person ? 1 : newestFirst(a, b);
  return collator.compare(lastName(a.person.name), lastName(b.person.name)) || collator.compare(a.person.name, b.person.name);
}

/** What the practitioner does next, on the card. */
export const NEXT: Partial<Record<ConsultationStatus, string>> = {
  consent_pending: "Record the patient's consent",
  ready_for_audio: "Start the call",
  audio_imported: "The call is recorded: start the transcript",
  transcription_processing: "Watson is writing the transcript",
  transcription_failed: "The transcript stopped. Try again.",
  transcript_ready: "Fill in the form",
  transcript_under_review: "Finish checking the transcript",
  transcript_reviewed: "Fill in the form",
  extraction_processing: "Watson is reading the conversation",
  extraction_failed: "The form stopped. Try again.",
};

export const DAY = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" });
export const greeting = (hour: number) => (hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening");
export const plural = (n: number, one: string, many: string) => `${n === 1 ? "One" : n} ${n === 1 ? one : many}`;

export const TABS: readonly [ConsultationTab, string][] = [
  ["booked", "Booked"], ["paid", "Paid"], ["completed", "Completed"], ["archived", "Archived"],
];
export const TAB_EMPTY: Record<ConsultationTab, string> = {
  booked: "New and unpaid consultations appear here.",
  paid: "Paid consultations stay here until their work is completed.",
  completed: "Approved, corrected and consent-withdrawn consultations appear here.",
  archived: "Archived consultations are kept here instead of being permanently deleted.",
};

/** The four hero numbers, each a filter inside the active consultation tab. Pressed again: all. */
export type Filter = "needs" | "working" | "today" | "approved";
const WEEK_MS = 7 * 86_400_000;
export const FILTER: Record<Filter, (row: Row, now: Date) => boolean> = {
  needs: (row) => summarise(row.status).group === "Needs you",
  working: (row) => summarise(row.status).group === "Watson is working",
  today: (row, now) => new Date(row.scheduled_at).toDateString() === now.toDateString(),
  approved: (row, now) => ["approved", "corrected"].includes(row.status) && Date.parse(row.updated_at) > now.getTime() - WEEK_MS,
};
export const TILES: [Filter, string][] = [["needs", "Need you"], ["working", "Watson is working"], ["today", "Booked today"], ["approved", "Approved this week"]];

/** "at 11:00" today, else "on Thu 22 Oct 2026, 11:00". */
export const nextWhen = (iso: string, now: Date) =>
  new Date(iso).toDateString() === now.toDateString() ? `at ${clockTime(iso, viewerZone())}` : `on ${dateTime(iso)}`;
