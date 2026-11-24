// What a practitioner takes out of Watson (owner, 24 Oct: PDF or Excel, one patient or all of them).
// The form in its own order with the answers as the practitioner left them; never the conversation (owner, 23 Nov).
import { describe, expect, it } from "vitest";
import { allPatientsRows, answerText, bmi, forPatient, formRows, isTypedFormTemplate, type ConsultationRecord } from "./export";

const template = { title: "Ayurvedic consultation", sections: [
  { title: "About the patient", fields: [{ key: "age", label: "Age" }, { key: "work", label: "Work" }] },
  { title: "Assessment", fields: [{ key: "assessment", label: "Assessment", mode: "suggest" as const }] },
  { title: "For you only", fields: [{ key: "private_notes", label: "Private notes", mode: "manual" as const }] },
] };
const jana: ConsultationRecord = {
  patient: "Jana Nováková", contact: "+421905111222", scheduledAt: new Date(2026, 9, 27, 10, 0).toISOString(),
  practitioner: "Dr. Robin Raju", approvedAt: new Date(2026, 9, 27, 11, 30).toISOString(), template,
  answers: [
    { field_key: "age", machine_text: "42", practitioner_text: null, review: "accepted" },
    { field_key: "work", machine_text: "Teacher", practitioner_text: "Teacher, evening classes", review: "edited" },
    { field_key: "assessment", machine_text: "Vata imbalance", practitioner_text: null, review: "rejected" },
    { field_key: "private_notes", machine_text: null, practitioner_text: "Call back in a week", review: "edited" },
  ],
  revision: 1, revisionKind: "generated", templateHash: "abc123", signatures: [{
    field_key: "practitioner_signoff", signer_role: "practitioner", method: "wet_ink_on_print",
    signed_name: "Dr. Robin Raju", signed_at: "2026-10-27T11:29:00Z",
  }],
};

describe("a consultation, taken out", () => {
  it("recognises typed forms even when they have no approval gates", () => {
    expect(isTypedFormTemplate({
      title: "Typed",
      sections: [{ title: "Details", fields: [{ key: "age", label: "Age", value_type: "integer" }] }],
    })).toBe(true);
    expect(isTypedFormTemplate(template)).toBe(false);
  });

  it("keeps compatibility answer states out of legacy output", () => {
    const unanswered = { field_key: "age", machine_text: null, practitioner_text: null,
      review: "unreviewed", answer_state: "unanswered" };
    expect(answerText(unanswered, { key: "age", label: "Age" })).toBe("");
    expect(answerText(unanswered, { key: "age", label: "Age", value_type: "integer" }))
      .toBe("Not answered / Nezodpovedané");
  });

  it("renders typed booleans and repeater item labels bilingually", () => {
    const known = (value: unknown) => ({ field_key: "typed", machine_text: null,
      practitioner_text: null, review: "accepted", answer_state: "known", machine_value: value });
    expect(answerText(known(true), { key: "consent", label: "Consent", value_type: "boolean" }))
      .toBe("Yes / Áno");
    expect(answerText(known([{ item_id: "1", values: { name: "A", dose: "5 mg" } }]), {
      key: "medications", label: "Medications", value_type: "repeater",
      item_fields: [
        { key: "name", label: "Name / Názov", label_i18n: { en: "Name", sk: "Názov" }, value_type: "text" },
        { key: "dose", label: "Dose / Dávka", label_i18n: { en: "Dose", sk: "Dávka" }, value_type: "text" },
      ],
    }, "sk")).toBe("Názov: A · Dávka: 5 mg");
  });

  it("gives the form in its own order, as the practitioner left it, after who, when and how far it got", () => {
    expect(formRows(jana)).toEqual([
      ["Section", "Question", "Answer"],
      ["Consultation", "Patient", "Jana Nováková"],
      ["Consultation", "Phone or email", "+421905111222"],
      ["Consultation", "Date", "27/10/2026 10:00"],
      ["Consultation", "Practitioner", "Dr. Robin Raju"],
      ["Consultation", "Form", "Approved 27/10/2026 11:30"],
      ["Record", "Revision", "1 (generated)"],
      ["Record", "Template SHA-256", "abc123"],
      ["Signature", "Practitioner", "Dr. Robin Raju · wet ink on print · 2026-10-27T11:29:00Z"],
      ["About the patient", "Age", "42"],
      ["About the patient", "Work", "Teacher, evening classes"],
      ["Assessment", "Assessment", ""],
      ["For you only", "Private notes", "Call back in a week"],
    ]);
  });
});

describe("all patients, taken out at once", () => {
  it("is one row per consultation, one column per question, and says where a form is missing", () => {
    const ema: ConsultationRecord = { patient: "Ema Mráz", contact: "ema@example.com", scheduledAt: new Date(2026, 9, 20, 9, 0).toISOString(),
      practitioner: "Dr. Robin Raju", approvedAt: null, template: null, answers: [],
      revision: null, revisionKind: null, templateHash: null, signatures: [] };
    expect(allPatientsRows([jana, ema])).toEqual([
      ["Patient", "Phone or email", "Date", "Practitioner", "Form", "Age", "Work", "Assessment", "Private notes"],
      ["Jana Nováková", "+421905111222", "27/10/2026 10:00", "Dr. Robin Raju", "Approved 27/10/2026 11:30", "42", "Teacher, evening classes", "", "Call back in a week"],
      ["Ema Mráz", "ema@example.com", "20/10/2026 09:00", "Dr. Robin Raju", "No form yet", "", "", "", ""],
    ]);
  });
});

describe("the BMI, from height and weight as they were said", () => {
  it("works in centimetres or metres, with a decimal point or comma", () => {
    expect(bmi("172 cm", "68 kg")).toBe("23.0");
    expect(bmi("1,72 m", "68,5")).toBe("23.2");
    expect(bmi("Výška 165", "Váha 59 kg")).toBe("21.7");
  });
  it("is left out when either is missing, not plausible, or in other units", () => {
    expect(bmi("", "68 kg")).toBeNull();
    expect(bmi("172 cm", null)).toBeNull();
    expect(bmi("5 ft 8", "150 lb")).toBeNull();
    expect(bmi("about average", "68 kg")).toBeNull();
    expect(bmi("17 cm", "68 kg")).toBeNull();
  });
});

// Owner, 23 Nov: the intake stays with the doctor; the report and the prescriptions go to the patient.
describe("what the patient gets", () => {
  it("is their main complaints, the diagnosis, treatment and instructions; never the intake, safety or private notes", () => {
    const full = { title: "Ayurvedic consultation", sections: [
      { title: "About the patient", fields: [{ key: "age", label: "Age" }, { key: "weight", label: "Weight" }] },
      { title: "Present condition", fields: [{ key: "main_concern", label: "Main concern" }, { key: "better_worse", label: "Better or worse" }] },
      { title: "Assessment", fields: [{ key: "assessment", label: "Assessment", mode: "suggest" as const }, { key: "safety", label: "Safety", mode: "suggest" as const }] },
      { title: "Recommendation", fields: [{ key: "therapies", label: "Therapies" }, { key: "review", label: "Review" }] },
      { title: "General instructions", fields: [{ key: "daily_routine", label: "Daily routine" }] },
      { title: "For you only", fields: [{ key: "private_notes", label: "Private notes", mode: "manual" as const }] },
    ] };
    expect(forPatient(full).sections.map((section) => [section.title, section.fields.map((field) => field.key)])).toEqual([
      ["Present condition", ["main_concern"]],
      ["Assessment", ["assessment"]],
      ["Recommendation", ["therapies", "review"]],
      ["General instructions", ["daily_routine"]],
    ]);
  });
});
