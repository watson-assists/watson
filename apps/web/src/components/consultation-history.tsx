"use client";

import Link from "next/link";
import { useState } from "react";
import { Notice, StatusChip } from "@/components/status";
import { call, explain } from "@/lib/api";
import type { Consultation, History, PreviousContext } from "@/lib/consultation-page";
import { answerText } from "@/lib/export";
import { dateTime, LANGUAGE_LABEL } from "@/lib/status";

// The patient's earlier consultations: the list, one linked as the previous appointment, and its dated values.

export function PreviousValues({ context }: { context: PreviousContext }) {
  const answers = new Map(context.answers.map((answer) => [answer.field_key, answer]));
  return <section className="wa-panel" aria-labelledby="previous-values-title">
    <h2 className="wa-heading" id="previous-values-title">Dated values from {dateTime(context.scheduledAt)}</h2>
    <p className="wa-hint">Read-only historical context. These values are never copied into the current form.</p>
    {context.template.sections.map((section) => <div key={section.title}>
      <h3 className="wa-label">{section.title}</h3>
      <dl className="wa-printed__answers">{section.fields.map((field) => {
        const value = answerText(answers.get(field.key), field);
        return value ? <div key={field.key}><dt>{field.label}</dt><dd>{value}</dd></div> : null;
      })}</dl>
    </div>)}
  </section>;
}

export function PreviousAppointmentSelector({ consultation, history, onChanged, onProblem }: {
  consultation: Consultation;
  history: History[] | "failed" | null;
  onChanged: () => void;
  onProblem: (message: string | null) => void;
}) {
  const [selected, setSelected] = useState(consultation.previous_consultation_id ?? "");
  const [busy, setBusy] = useState(false);
  const eligible = Array.isArray(history)
    ? history.filter((item) => ["verified", "practitioner_confirmed"].includes(item.patient_association_state))
    : [];

  if (!["consent_pending", "ready_for_audio"].includes(consultation.status)
      || consultation.patient_id === null
      || !["verified", "practitioner_confirmed"].includes(consultation.patient_association_state)
      || history === null
      || history === "failed") return null;

  async function save() {
    setBusy(true);
    onProblem(null);
    const outcome = await call("link_previous_consultation", {
      p_consultation_id: consultation.id,
      p_previous_consultation_id: selected || null,
    });
    setBusy(false);
    if (!outcome.ok) return onProblem(explain(outcome.error_category));
    onChanged();
  }

  return (
    <section className="wa-panel" aria-labelledby="previous-appointment-title">
      <h2 className="wa-heading" id="previous-appointment-title">Previous appointment</h2>
      <p className="wa-hint" id="previous-appointment-hint">
        Optional. Link one earlier appointment for this confirmed patient. Its approved values remain dated history, not current answers.
      </p>
      {eligible.length === 0 ? (
        <p className="wa-text">No eligible earlier appointment is available to link.</p>
      ) : (
        <div className="wa-fields-row" style={{ alignItems: "end" }}>
          <div className="wa-field">
            <label className="wa-label" htmlFor="previous-appointment">Earlier appointment</label>
            <div className="wa-select">
              <select id="previous-appointment" value={selected} aria-describedby="previous-appointment-hint"
                onChange={(event) => setSelected(event.target.value)}>
                <option value="">Not linked</option>
                {eligible.map((item) => (
                  <option key={item.id} value={item.id}>
                    {dateTime(item.scheduled_at)} · {LANGUAGE_LABEL[item.language]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button type="button" className="wa-button wa-button--secondary" disabled={busy || selected === (consultation.previous_consultation_id ?? "")}
            aria-busy={busy || undefined} onClick={save}>
            {busy ? "Saving…" : "Save link"}
          </button>
        </div>
      )}
    </section>
  );
}

export function PatientHistory({ history }: { history: History[] | "failed" | null }) {
  return (
    <section className="wa-panel" aria-labelledby="history-title">
      <div className="wa-panel__head">
        <h2 className="wa-heading" id="history-title">Past consultations</h2>
      </div>
      {history === null ? (
        <p className="wa-text">Confirm who this patient is to see their earlier consultations safely.</p>
      ) : history === "failed" ? (
        <Notice tone="failed" title="Past consultations could not be loaded">Check your connection and reload the page.</Notice>
      ) : history.length === 0 ? (
        <p className="wa-text">No earlier consultations for this patient.</p>
      ) : (
        <ul className="wa-done-list">
          {history.map((consultation) => (
            <li key={consultation.id}>
              <Link href={`/consultation/?id=${consultation.id}`} className="wa-row__ref" style={{ color: "inherit" }}>
                {dateTime(consultation.scheduled_at)}
              </Link>
              <span className="wa-meta">{LANGUAGE_LABEL[consultation.language]}</span>
              <span style={{ marginLeft: "auto" }}><StatusChip status={consultation.status} /></span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
