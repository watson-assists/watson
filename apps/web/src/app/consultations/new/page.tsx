"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "@/lib/zod";
import { AppShell } from "@/components/app-shell";
import { FieldError, Notice } from "@/components/status";
import { call, explain } from "@/lib/api";
import { asClock, asDateInput, fromDateInputAndClock, fromDayAndClock } from "@/lib/dates";
import { feeSchema, fromCents, toCents } from "@/lib/fee";
import { PAYMENTS } from "@/lib/features";
import { defaultTemplateId, templateLabel } from "@/lib/form-templates";
import type { Tables } from "@/lib/database.types";
import { RequireSession } from "@/lib/session";
import { LANGUAGE_LABEL } from "@/lib/status";
import { supabase } from "@/lib/supabase";

const schema = z.object({
  day: z.string().refine((day) => fromDateInputAndClock(day, "12:00") !== null, "Choose a date."),
  clock: z.string().refine((clock) => fromDayAndClock("1/1/2026", clock) !== null, "Write the time on the 24-hour clock, like 14:30."),
  language: z.enum(["en", "de", "sk", "auto"], "Choose the language of the consultation."),
  consent_recorded: z.boolean(),
  scenario_notes: z.string().max(500, "Keep the notes under 500 characters."),
  fee: feeSchema,
  // The patient (owner, 24 Oct): name and phone or email together, or neither (the patient gives them).
  patient_name: z.string().max(120, "Keep the name under 120 characters."),
  patient_contact: z.string().max(254, "Keep it under 254 characters."),
  form_template_version_id: z.string().uuid("Choose a consultation form."),
}).superRefine((values, context) => {
  const name = values.patient_name.trim();
  const contact = values.patient_contact.trim();
  if (name && !contact) context.addIssue({ code: "custom", path: ["patient_contact"], message: "Add their phone (with its country code, like +421) or their email." });
  if (contact && !name) context.addIssue({ code: "custom", path: ["patient_name"], message: "Add the patient's name too." });
});
type Values = z.infer<typeof schema>;

export default function NewConsultationPage() {
  return <RequireSession>{(user) => <AppShell user={user}><NewConsultation /></AppShell>}</RequireSession>;
}

type Known = { name: string; phone: string | null; email: string | null };
type TemplateVersion = Pick<Tables<"form_template_versions">,
  "id" | "template_key" | "version_number" | "schema_version" | "definition">;

function NewConsultation() {
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(null);
  const [known, setKnown] = useState<Known[]>([]);
  const [templates, setTemplates] = useState<TemplateVersion[]>([]);
  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { day: "", clock: "", language: "en", consent_recorded: true, scenario_notes: "", fee: "", patient_name: "", patient_contact: "", form_template_version_id: "" },
  });

  useEffect(() => {
    // Patients seen before, suggested as the name is typed. Row-level security keeps them the practitioner's own.
    supabase.from("patients").select("name, phone, email").order("name").then(({ data }) => setKnown(data ?? []));
    // The usual fee, set in Practice, unless the practitioner has typed one already.
    if (PAYMENTS) supabase.from("practitioner_profiles").select("fee_cents").maybeSingle().then(({ data }) => {
      if (data?.fee_cents && !getValues("fee")) setValue("fee", fromCents(data.fee_cents));
    });
    Promise.all([
      supabase.from("form_template_versions")
        .select("id, template_key, version_number, schema_version, definition")
        .order("is_built_in", { ascending: false }).order("template_key").order("version_number", { ascending: false }),
      supabase.from("form_template_defaults").select("form_template_version_id").maybeSingle(),
    ]).then(([available, current]) => {
      const rows = available.data ?? [];
      setTemplates(rows);
      setValue("form_template_version_id", defaultTemplateId(rows, current.data?.form_template_version_id));
    });
  }, [getValues, setValue]);

  useEffect(() => {
    const now = new Date();
    setValue("day", asDateInput(now));
    setValue("clock", asClock(now));
  }, [setValue]);

  async function create(values: Values) {
    setFailure(null);
    const outcome = await call<{ consultation_id: string }>("create_consultation_with_template", {
      p_scheduled_at: fromDateInputAndClock(values.day, values.clock)!.toISOString(),
      p_language: values.language,
      p_consent_recorded: values.consent_recorded,
      p_scenario_notes: values.scenario_notes,
      p_fee_cents: toCents(values.fee) ?? undefined,
      p_patient_name: values.patient_name.trim() || undefined,
      p_patient_contact: values.patient_contact.trim() || undefined,
      p_form_template_version_id: values.form_template_version_id,
    });
    if (outcome.ok) return router.push(`/consultation/?id=${outcome.consultation_id}`);
    if (outcome.field === "contact") return setError("patient_contact", { message: "That phone or email cannot be used. A phone needs its country code, like +421 905 123 456." });
    if (outcome.field === "name") return setError("patient_name", { message: "Write the patient's name, up to 120 characters." });
    setFailure(explain(outcome.error_category));
  }

  return (
    <>
      <Link href="/consultations/" className="wa-crumb"><ChevronLeft aria-hidden className="wa-icon wa-icon--sm" />Consultations</Link>
      <h1 className="wa-title">New consultation</h1>
      <div className="wa-split">
        <form onSubmit={handleSubmit(create)} noValidate className="wa-panel" aria-label="Consultation details">
          <div className="wa-form">
            <fieldset className="wa-form" style={{ border: 0, margin: 0, padding: 0 }}>
              <legend className="wa-label" style={{ marginBottom: 4 }}>Patient</legend>
              <p className="wa-hint" id="patient-hint" style={{ marginTop: -8 }}>
                Start typing to choose someone you have seen before. Leave both empty to let the patient fill them in from their link.
              </p>
              <div className="wa-fields-row">
                <div className="wa-field">
                  <label className="wa-label" htmlFor="patient-name">Patient&apos;s name</label>
                  <input id="patient-name" className="wa-input" list="patients" autoComplete="off"
                    aria-invalid={Boolean(errors.patient_name)} aria-describedby="patient-hint patient-name-error"
                    {...register("patient_name", {
                      onChange: (event) => {
                        const seen = known.find((patient) => patient.name === event.target.value);
                        if (seen && !getValues("patient_contact")) setValue("patient_contact", seen.phone ?? seen.email ?? "");
                      },
                    })} />
                  <datalist id="patients">
                    {known.map((patient) => <option key={`${patient.name}-${patient.phone ?? patient.email}`} value={patient.name}>{patient.phone ?? patient.email}</option>)}
                  </datalist>
                  <FieldError id="patient-name-error" message={errors.patient_name?.message} />
                </div>
                <div className="wa-field">
                  <label className="wa-label" htmlFor="patient-contact">Phone or email</label>
                  <input id="patient-contact" className="wa-input" autoComplete="off" placeholder="+421 905 123 456"
                    aria-invalid={Boolean(errors.patient_contact)} aria-describedby="patient-contact-error" {...register("patient_contact")} />
                  <FieldError id="patient-contact-error" message={errors.patient_contact?.message} />
                </div>
              </div>
            </fieldset>

            <div className="wa-fields-row">
              <div className="wa-field">
                <label className="wa-label" htmlFor="day">Date</label>
                <input id="day" type="date" className="wa-input" autoComplete="off" aria-invalid={Boolean(errors.day)}
                  aria-describedby="day-error" {...register("day")} />
                <FieldError id="day-error" message={errors.day?.message} />
              </div>
              <div className="wa-field">
                <label className="wa-label" htmlFor="clock">Time (24-hour)</label>
                <input id="clock" className="wa-input" autoComplete="off" placeholder="14:30" aria-invalid={Boolean(errors.clock)}
                  aria-describedby="clock-error" {...register("clock")} />
                <FieldError id="clock-error" message={errors.clock?.message} />
              </div>
              <div className="wa-field">
                <label className="wa-label" htmlFor="language">Language spoken</label>
                <div className="wa-select">
                  <select id="language" aria-invalid={Boolean(errors.language)}
                    aria-describedby="language-hint language-error" {...register("language")}>
                    {Object.entries(LANGUAGE_LABEL).map(([code, label]) => (
                      <option key={code} value={code}>{label}</option>
                    ))}
                  </select>
                </div>
                <FieldError id="language-error" message={errors.language?.message} />
              </div>
            </div>

            <div className="wa-field">
              <label className="wa-label" htmlFor="form-template">Consultation form</label>
              <p className="wa-hint" id="form-template-hint">Pinned to this consultation. Changing the Practice default later will not change this record.</p>
              <div className="wa-select">
                <select id="form-template" aria-invalid={Boolean(errors.form_template_version_id)}
                  aria-describedby="form-template-hint form-template-error" {...register("form_template_version_id")}>
                  {templates.map((version) => (
                    <option key={version.id} value={version.id}>{templateLabel(version)}</option>
                  ))}
                </select>
              </div>
              <FieldError id="form-template-error" message={errors.form_template_version_id?.message} />
            </div>
            <p className="wa-hint" id="language-hint" style={{ marginTop: -12 }}>
              English unless you choose another. The transcript is made in this language; &ldquo;Mixed or unsure&rdquo; lets Watson guess, which is less reliable.
            </p>

            {PAYMENTS && <div className="wa-field">
              <label className="wa-label" htmlFor="fee">Fee</label>
              <p className="wa-hint" id="fee-hint">The patient pays this when they open your link, before the call. It starts at your usual fee, set in Practice; 0 makes the consultation free, with no payment.</p>
              <div className="wa-affixed" style={{ maxWidth: 200 }}>
                <span className="wa-affix" aria-hidden>€</span>
                <input id="fee" className="wa-input" inputMode="decimal" autoComplete="off" placeholder="40.00"
                  aria-invalid={Boolean(errors.fee)} aria-describedby="fee-hint fee-error" {...register("fee")} />
              </div>
              <FieldError id="fee-error" message={errors.fee?.message} />
            </div>}

            <div className="wa-field">
              <label className="wa-label" htmlFor="notes">Notes</label>
              <p className="wa-hint" id="notes-hint">For example &ldquo;sleep complaint, patient mentions a supplement&rdquo;.</p>
              <textarea id="notes" className="wa-textarea" aria-invalid={Boolean(errors.scenario_notes)}
                aria-describedby="notes-hint notes-error" {...register("scenario_notes")} />
              <FieldError id="notes-error" message={errors.scenario_notes?.message} />
            </div>

            <label className="wa-check">
              <input type="checkbox" {...register("consent_recorded")} />
              <span className="wa-check__text">
                <span className="wa-check__label">Consent to transcription is recorded</span>
                <span className="wa-hint">If you leave this off, it is recorded when you start the video call.</span>
              </span>
            </label>

            {failure && <Notice tone="failed" title="The consultation was not created">{failure}</Notice>}
            <div className="wa-actions">
              <button type="submit" className="wa-button wa-button--primary" disabled={isSubmitting} aria-busy={isSubmitting || undefined}>
                {isSubmitting ? "Creating…" : "Create consultation"}
              </button>
              <Link href="/consultations/" className="wa-button wa-button--secondary">Cancel</Link>
            </div>
          </div>
        </form>
        <aside className="wa-aside" aria-labelledby="next-title">
          <h2 className="wa-heading" id="next-title" style={{ color: "var(--ink)" }}>What happens next</h2>
          <ol>
            <li>Watson numbers the consultation and remembers the patient: next time, start typing their name.</li>
            <li>Send the patient their link. If you set a fee, they pay it there.</li>
            <li>Start the video call. Both voices are recorded.</li>
            <li>When you end the call, Watson writes the transcript and fills in your form.</li>
            <li>Check each answer against its quote, then approve.</li>
          </ol>
        </aside>
      </div>
    </>
  );
}
