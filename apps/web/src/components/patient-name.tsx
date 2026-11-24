"use client";

import { Pencil } from "lucide-react";
import { useState, type FormEvent } from "react";
import { FieldError } from "@/components/status";
import { call, explain } from "@/lib/api";
import type { Shown } from "@/lib/patient";

/** The patient's name, and changing it where the doctor sees it (owner, 23 Nov). The phone or email stay as they are. */
export function PatientName({ consultationId, shown, fallback, onChanged }: {
  consultationId: string; shown: Shown | null; fallback: string; onChanged: () => void;
}) {
  const [name, setName] = useState<string | null>(null); // null: not changing it
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!shown || name === null) return;
    setBusy(true);
    setProblem(null);
    const outcome = await call("set_patient", { p_consultation_id: consultationId, p_name: name, p_contact: shown.phone ?? shown.email ?? "" });
    setBusy(false);
    if (!outcome.ok) return setProblem(outcome.field === "name" ? "Write the patient\u2019s name, up to 120 characters." : explain(outcome.error_category));
    setName(null);
    onChanged();
  }

  if (name === null) {
    return (
      <div className="wa-actions" style={{ alignItems: "center" }}>
        <h1 className="wa-title">{shown?.name ?? fallback}</h1>
        {shown && (
          <button type="button" className="wa-button wa-button--quiet wa-button--small" onClick={() => { setProblem(null); setName(shown.name); }}>
            <Pencil aria-hidden className="wa-icon wa-icon--sm" />Change name
          </button>
        )}
      </div>
    );
  }
  return (
    <form className="wa-form" style={{ gap: 12 }} onSubmit={(event) => void save(event)}>
      <div className="wa-field">
        <label className="wa-label" htmlFor="patient-rename">Patient&apos;s name</label>
        <input id="patient-rename" className="wa-input" value={name} maxLength={120} autoFocus autoComplete="off"
          aria-invalid={Boolean(problem)} aria-describedby="patient-rename-error" onChange={(event) => setName(event.target.value)} />
        <FieldError id="patient-rename-error" message={problem ?? undefined} />
      </div>
      <div className="wa-actions">
        <button type="submit" className="wa-button wa-button--primary" disabled={busy}>Save name</button>
        <button type="button" className="wa-button wa-button--quiet" disabled={busy} onClick={() => setName(null)}>Cancel</button>
      </div>
    </form>
  );
}
