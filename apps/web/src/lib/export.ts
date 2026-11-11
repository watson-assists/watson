// What a practitioner takes out of Watson (owner, 24 Oct: "the doctor and/or patient can pull data
// out via both pdf and excel … for a doctor they can export all info of their patients at once").
// The same rows feed the Excel sheets and the printed page.
import { asClock, asDayMonthYear } from "./dates";

export type OutputLanguage = "en" | "sk" | "both";
type Localized = { en: string; sk: string };
export type FormOption = { key: string; label: string; label_i18n?: Localized };
export type FormField = { key: string; label: string; label_i18n?: Localized;
  mode?: "extract" | "suggest" | "manual"; value_type?: string; options?: FormOption[];
  item_fields?: FormField[] };
export type FormTemplate = { title: string; title_i18n?: Localized;
  sections: { title: string; title_i18n?: Localized; fields: FormField[] }[] };
export type FormAnswer = { field_key: string; machine_text: string | null; practitioner_text: string | null;
  review: string; value_type?: string; answer_state?: string; machine_value?: unknown; practitioner_value?: unknown };
export type FormSignature = { field_key: string; signer_role: string; method: string; signed_name: string; signed_at: string };
export type Turn = { start_seconds: number; speaker: "practitioner" | "patient"; machine_text: string; reviewed_text: string | null };
export type ConsultationRecord = {
  patient: string; contact: string; scheduledAt: string; practitioner: string;
  /** When the form was approved; null for a draft, or when there is no form. */
  approvedAt: string | null;
  /** The form as it was filled in; null when Watson has not filled one in yet. */
  template: FormTemplate | null;
  answers: FormAnswer[];
  turns: Turn[];
  revision: number | null;
  revisionKind: string | null;
  templateHash: string | null;
  signatures: FormSignature[];
};

const when = (iso: string) => `${asDayMonthYear(new Date(iso))} ${asClock(new Date(iso))}`;

/** Typed forms use state/value review even when they have no approval gates. */
export const isTypedFormTemplate = (template: FormTemplate) =>
  template.sections.some((section) => section.fields.some((field) => field.value_type !== undefined));

/** The answer as the practitioner left it: their own words, else Watson's, unless they rejected it. */
export const translated = (fallback: string, text: Localized | undefined, language: OutputLanguage) =>
  language === "both" ? fallback : text?.[language] ?? fallback;

export const answerText = (answer: FormAnswer | undefined, field?: FormField,
  language: OutputLanguage = "both"): string => {
  if (!answer || answer.review === "rejected") return "";
  const state = answer.answer_state;
  if (field?.value_type && state && state !== "known") {
    const stateText = ({
    unanswered: { en: "Not answered", sk: "Nezodpovedané" },
    explicit_none: { en: "Explicitly none", sk: "Výslovne žiadne" },
    unknown: { en: "Unknown", sk: "Neznáme" },
    not_applicable: { en: "Not applicable", sk: "Nevzťahuje sa" },
    } as Record<string, Localized>)[state];
    return !stateText ? state : language === "both"
      ? `${stateText.en} / ${stateText.sk}` : stateText[language];
  }
  const value = answer.review === "edited" ? answer.practitioner_value : answer.machine_value;
  if (value !== undefined && value !== null) {
    if (field?.value_type === "single_choice") {
      const option = field.options?.find((item) => item.key === value);
      return option ? translated(option.label, option.label_i18n, language) : String(value);
    }
    if (field?.value_type === "multi_choice" && Array.isArray(value)) {
      return value.map((key) => {
        const option = field.options?.find((item) => item.key === key);
        return option ? translated(option.label, option.label_i18n, language) : String(key);
      }).join(", ");
    }
    if (field?.value_type === "boolean") {
      const labels = value ? { en: "Yes", sk: "Áno" } : { en: "No", sk: "Nie" };
      return language === "both" ? `${labels.en} / ${labels.sk}` : labels[language];
    }
    if (field?.value_type === "repeater" && Array.isArray(value)) return value.map((row) => {
      const values = (row as { values?: Record<string, unknown> }).values ?? {};
      if (!field.item_fields?.length) {
        return Object.values(values).filter((item) => item !== null).join(" · ");
      }
      return field.item_fields.flatMap((item) => {
        const itemValue = values[item.key];
        if (itemValue === null || itemValue === undefined || itemValue === "") return [];
        const shown = answerText({ field_key: item.key, machine_text: null, practitioner_text: null,
          review: "accepted", answer_state: "known", machine_value: itemValue }, item, language);
        return [`${translated(item.label, item.label_i18n, language)}: ${shown}`];
      }).join(" · ");
    }).filter(Boolean).join("; ");
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  return answer.practitioner_text ?? answer.machine_text ?? "";
};

/** "Approved 27/10/2026 11:30", "Draft, not yet approved" or "No form yet". */
export const formState = (record: ConsultationRecord) =>
  !record.template ? "No form yet" : record.approvedAt ? `Approved ${when(record.approvedAt)}` : "Draft, not yet approved";

/** One consultation: who, when and how far the form got, then every question in the form's own order. */
export function formRows(record: ConsultationRecord): string[][] {
  const answers = new Map(record.answers.map((answer) => [answer.field_key, answer]));
  const revision = record.revision === null ? "—"
    : `${record.revision}${record.revisionKind ? ` (${record.revisionKind.replaceAll("_", " ")})` : ""}`;
  return [
    ["Section", "Question", "Answer"],
    ["Consultation", "Patient", record.patient],
    ["Consultation", "Phone or email", record.contact],
    ["Consultation", "Date", when(record.scheduledAt)],
    ["Consultation", "Practitioner", record.practitioner],
    ["Consultation", "Form", formState(record)],
    ["Record", "Revision", revision],
    ["Record", "Template SHA-256", record.templateHash ?? "—"],
    ...record.signatures.map((signature) => [
      "Signature",
      signature.signer_role === "patient" ? "Patient" : "Practitioner",
      `${signature.signed_name} · ${signature.method.replaceAll("_", " ")} · ${signature.signed_at}`,
    ]),
    ...(record.template?.sections ?? []).flatMap((section) =>
      section.fields.map((field) => [section.title, field.label, answerText(answers.get(field.key), field)])),
  ];
}

/** 75 -> "1:15". */
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** The conversation, each line as corrected. */
export function conversationRows(record: ConsultationRecord): string[][] {
  return [
    ["Time", "Who", "Words"],
    ...record.turns.map((turn) => [clock(turn.start_seconds), turn.speaker === "patient" ? "Patient" : "Practitioner",
      turn.reviewed_text ?? turn.machine_text]),
  ];
}

/** Every consultation, one row each; a column for every question asked in any of their forms. */
export function allPatientsRows(records: ConsultationRecord[]): string[][] {
  const questions = new Map<string, string>(); // field key -> label, in the order first met
  for (const record of records) {
    for (const field of record.template?.sections.flatMap((section) => section.fields) ?? []) {
      if (!questions.has(field.key)) questions.set(field.key, field.label);
    }
  }
  return [
    ["Patient", "Phone or email", "Date", "Practitioner", "Form", ...questions.values()],
    ...records.map((record) => {
      const answers = new Map(record.answers.map((answer) => [answer.field_key, answer]));
      const fields = new Map(record.template?.sections.flatMap((section) => section.fields)
        .map((field) => [field.key, field]) ?? []);
      return [record.patient, record.contact, when(record.scheduledAt), record.practitioner, formState(record),
        ...[...questions.keys()].map((key) => answerText(answers.get(key), fields.get(key)))];
    }),
  ];
}
