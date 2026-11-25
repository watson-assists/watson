"use client";

import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { FieldError, Notice } from "@/components/status";
import { call, explain } from "@/lib/api";
import { HOUR_CHOICES, WEEKDAYS, type Hours, type OwnPage } from "@/lib/booking";
import { FEE_RULE, feeSchema, fromCents, toCents } from "@/lib/fee";
import { PAYMENTS } from "@/lib/features";
import { LANGUAGE_LABEL, type ConsultationLanguage } from "@/lib/status";

// The hours patients can book and the page they see (design system: ScreenCalendar).
// One form, one save: save_booking_page checks everything again and writes it in one go.

const LANGUAGES: ConsultationLanguage[] = ["en", "sk", "de"];
const DEFAULT_SPAN: [string, string] = ["09:00", "17:00"];
const activeHours = (hours: Hours): Hours => Object.fromEntries(
  Object.entries(hours).filter(([, span]) => span).sort(([left], [right]) => Number(left) - Number(right)),
);

/** What each refused field should say. */
const FIELD: Record<string, string> = {
  display_name: "Enter the name patients should see.",
  hours: "Each day needs a start before its end.",
  languages: "Choose the languages you consult in.",
  fee_cents: FEE_RULE,
};

type Values = { hours: Hours; length: number; gap: number; fee: string; name: string; offer: string; about: string; languages: ConsultationLanguage[] };
type SetValue = <K extends keyof Values>(key: K, value: Values[K]) => void;
type ErrorOf = (field: string) => string | null;

/** The page as saved, or a new one: 45-minute consultations with 15 minutes between. */
const startingValues = (page: OwnPage | null): Values => ({
  hours: page?.hours ?? {}, length: page?.length_minutes ?? 45, gap: page?.gap_minutes ?? 15, fee: fromCents(page?.fee_cents ?? null),
  name: page?.display_name ?? "", offer: page?.offer ?? "", about: page?.about ?? "", languages: page?.languages ?? [],
});

/** quietSave: another button on the screen is the one next step (Connect Google Calendar). */
export function BookingSettings({ page, aside, quietSave, onSaved }: {
  page: OwnPage | null; aside?: ReactNode; quietSave?: boolean; onSaved: () => void;
}) {
  const [values, setValues] = useState<Values>(() => startingValues(page));
  const [savedHours, setSavedHours] = useState<Hours>(() => activeHours(page?.hours ?? {}));
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [problem, setProblem] = useState<{ field?: string; message: string } | null>(null);
  const set: SetValue = (key, value) => setValues((now) => ({ ...now, [key]: value }));
  const hoursToSave = activeHours(values.hours);
  const hoursChanged = JSON.stringify(hoursToSave) !== JSON.stringify(activeHours(savedHours));
  const setDay = (day: string, span: [string, string] | undefined) => {
    setState("idle");
    setValues((now) => ({ ...now, hours: { ...now.hours, [day]: span } }));
  };

  async function save() {
    setProblem(null);
    if (!feeSchema.safeParse(values.fee).success) return setProblem({ field: "fee_cents", message: FIELD.fee_cents });
    setState("saving");
    const outcome = await call<{ slug: string }>("save_booking_page", {
      p_display_name: values.name, p_offer: values.offer, p_about: values.about, p_languages: values.languages,
      p_hours: hoursToSave, p_length_minutes: values.length, p_gap_minutes: values.gap, p_fee_cents: toCents(values.fee) as number,
    });
    if (!outcome.ok) {
      setState("idle");
      return setProblem({ field: outcome.field, message: (outcome.field && FIELD[outcome.field]) ?? explain(outcome.error_category) });
    }
    setSavedHours(hoursToSave);
    setState("saved");
    onSaved();
  }

  const error: ErrorOf = (field) => (problem?.field === field ? problem.message : null);
  return (
    <form className="wa-form" noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="wa-split">
        <HoursPanel values={values} set={set} setDay={setDay} changed={hoursChanged} saved={page !== null} error={error} />
        <div style={{ display: "grid", gap: 24, alignContent: "start" }}>
          <PagePanel values={values} set={set} page={page} error={error} />
          {aside}
        </div>
      </div>
      {problem && !problem.field && <Notice tone="failed" title="Not saved">{problem.message}</Notice>}
      <div className="wa-actions">
        <button type="submit" className={`wa-button ${quietSave ? "wa-button--secondary" : "wa-button--primary"}`} disabled={state === "saving"} aria-busy={state === "saving" || undefined}>
          Save changes
        </button>
        {state === "saved" && <span role="status" className="wa-meta">Saved</span>}
      </div>
    </form>
  );
}

/** The days and hours patients can book, how long each consultation is, the gap between, and the usual fee. */
function HoursPanel({ values, set, setDay, changed, saved, error }: {
  values: Values; set: SetValue; setDay: (day: string, span: [string, string] | undefined) => void; changed: boolean; saved: boolean; error: ErrorOf;
}) {
  return (
    <section className="wa-panel" aria-labelledby="hours">
      <div className="wa-panel__head"><h2 className="wa-heading" id="hours">Hours patients can book</h2></div>
      {changed && <Notice tone="attention" title="Hours changed but not saved">
        {saved
          ? "Patients can still book during your previously saved hours until you save these changes."
          : "Patients cannot book until you save your booking page."}
      </Notice>}
      <ul className="wa-hours">
        {WEEKDAYS.map((weekday, i) => <DayHours key={weekday} weekday={weekday} day={String(i + 1)} span={values.hours[String(i + 1)]} setDay={setDay} />)}
      </ul>
      <FieldError id="hours-error" message={error("hours")} />
      <div className="wa-fields-row">
        <div className="wa-field">
          <label className="wa-label" htmlFor="length">Each consultation</label>
          <div className="wa-select">
            <select id="length" value={values.length} onChange={(e) => set("length", Number(e.target.value))}>
              {[30, 45, 60, 90].map((m) => <option key={m} value={m}>{m} minutes</option>)}
            </select>
          </div>
        </div>
        <div className="wa-field">
          <label className="wa-label" htmlFor="gap">Time between</label>
          <div className="wa-select">
            <select id="gap" value={values.gap} onChange={(e) => set("gap", Number(e.target.value))}>
              {[0, 15, 30].map((m) => <option key={m} value={m}>{m ? `${m} minutes` : "None"}</option>)}
            </select>
          </div>
        </div>
        {PAYMENTS && <div className="wa-field">
          <label className="wa-label" htmlFor="fee">Usual fee</label>
          <div className="wa-affixed">
            <span className="wa-affix" aria-hidden>€</span>
            <input id="fee" className="wa-input" inputMode="decimal" autoComplete="off" placeholder="40.00" value={values.fee}
              aria-invalid={Boolean(error("fee_cents"))} aria-describedby="fee-error" onChange={(e) => set("fee", e.target.value)} />
          </div>
          <FieldError id="fee-error" message={error("fee_cents")} />
        </div>}
      </div>
      {PAYMENTS && <p className="wa-hint">Patients who book on your page pay your usual fee. Each consultation you create starts with it, and you can change it there. 0 or empty is free.</p>}
    </section>
  );
}

function DayHours({ weekday, day, span, setDay }: {
  weekday: string; day: string; span: [string, string] | undefined; setDay: (day: string, span: [string, string] | undefined) => void;
}) {
  return (
    <li>
      <label className="wa-check">
        <input type="checkbox" checked={Boolean(span)} onChange={(e) => setDay(day, e.target.checked ? DEFAULT_SPAN : undefined)} />
        <span className="wa-check__text"><span className="wa-check__label">{weekday}</span></span>
      </label>
      {span ? (
        <div className="wa-hours__times">
          {([0, 1] as const).map((end) => (
            <span key={end} style={{ display: "contents" }}>
              {end === 1 && "to"}
              <div className="wa-select">
                <select aria-label={`${weekday} ${end ? "until" : "from"}`} value={span[end]}
                  onChange={(e) => setDay(day, end ? [span[0], e.target.value] : [e.target.value, span[1]])}>
                  {HOUR_CHOICES.map((time) => <option key={time}>{time}</option>)}
                </select>
              </div>
            </span>
          ))}
        </div>
      ) : <div className="wa-hours__times">Patients cannot book</div>}
    </li>
  );
}

/** What patients see of the practice: the name, the offer, the languages, about the doctor, and the link to book. */
function PagePanel({ values, set, page, error }: { values: Values; set: SetValue; page: OwnPage | null; error: ErrorOf }) {
  const link = page ? `${typeof window === "undefined" ? "" : window.location.origin}/book/?p=${page.slug}` : null;
  return (
    <section className="wa-panel" aria-labelledby="yours">
      <div className="wa-panel__head">
        <h2 className="wa-heading" id="yours">Your page for patients</h2>
        {page && <Link className="wa-button wa-button--quiet wa-button--small" href={`/book/?p=${page.slug}`} target="_blank">
          <ExternalLink aria-hidden className="wa-icon wa-icon--sm" />See it as a patient</Link>}
      </div>
      <div className="wa-field">
        <label className="wa-label" htmlFor="shown">Name patients see</label>
        <input id="shown" className="wa-input" value={values.name} aria-invalid={Boolean(error("display_name"))} aria-describedby="shown-error"
          onChange={(e) => set("name", e.target.value)} />
        <FieldError id="shown-error" message={error("display_name")} />
      </div>
      <div className="wa-field">
        <label className="wa-label" htmlFor="offer">What you offer</label>
        <p className="wa-hint" id="offer-hint">One line, under your name.</p>
        <input id="offer" className="wa-input" maxLength={140} aria-describedby="offer-hint" value={values.offer} onChange={(e) => set("offer", e.target.value)} />
      </div>
      <fieldset className="wa-field" style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="wa-label" style={{ marginBottom: 8 }}>Languages you consult in</legend>
        <div className="wa-actions">
          {LANGUAGES.map((language) => (
            <label key={language} className="wa-check">
              <input type="checkbox" checked={values.languages.includes(language)}
                onChange={(e) => set("languages", e.target.checked ? [...values.languages, language] : values.languages.filter((l) => l !== language))} />
              <span className="wa-check__text"><span className="wa-check__label">{LANGUAGE_LABEL[language]}</span></span>
            </label>
          ))}
        </div>
        <FieldError id="languages-error" message={error("languages")} />
      </fieldset>
      <div className="wa-field">
        <label className="wa-label" htmlFor="about">About you</label>
        <textarea id="about" className="wa-textarea" maxLength={1000} value={values.about} onChange={(e) => set("about", e.target.value)} />
      </div>
      {link && (
        <div className="wa-field">
          <span className="wa-label" id="link-label">Your booking link</span>
          <div className="wa-invite">
            <input className="wa-input" readOnly value={link} aria-labelledby="link-label" />
            <CopyButton text={link} />
          </div>
          <p className="wa-hint">Put it on your website or send it to new patients.</p>
        </div>
      )}
    </section>
  );
}
