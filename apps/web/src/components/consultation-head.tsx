"use client";

import { Archive } from "lucide-react";
import { useState } from "react";
import { PatientName } from "@/components/patient-name";
import { Notice } from "@/components/status";
import type { Loaded } from "@/lib/consultation-page";
import { euros } from "@/lib/fee";
import { dateTime, LANGUAGE_LABEL, WITHDRAWABLE } from "@/lib/status";

/** The consultation's name and details, and the two ways out of it: withdrawing consent, and archiving. */
export function ConsultationHead({ loaded, busy, onWithdraw, onArchive, onChanged }: {
  loaded: Loaded; busy: boolean;
  onWithdraw: () => Promise<boolean>; onArchive: () => Promise<boolean>; onChanged: () => void;
}) {
  const { consultation, shown } = loaded;
  const status = consultation.status;
  const [asking, setAsking] = useState<"withdraw" | "archive" | null>(null);
  const confirm = async (act: () => Promise<boolean>) => { if (await act()) setAsking(null); };
  const canWithdraw = consultation.consent_recorded_at !== null && WITHDRAWABLE.includes(status);
  return (
    <>
      <div className="wa-pagehead">
        <div className="wa-pagehead__text">
          <PatientName consultationId={consultation.id} shown={shown} fallback={consultation.synthetic_patient_ref} onChanged={onChanged} />
          <p className="wa-meta">
            {dateTime(consultation.scheduled_at)} · {LANGUAGE_LABEL[consultation.language]}
            {shown && ` · ${shown.phone ?? shown.email}`}
            {consultation.fee_cents !== null && ` · Fee ${euros(consultation.fee_cents)}`}
            {consultation.scenario_notes && ` · ${consultation.scenario_notes}`}
          </p>
          {(status === "approved" || status === "corrected") && (
            <p className="wa-hint">The form is approved, so consent can no longer be withdrawn here.</p>
          )}
        </div>
        {asking === null && status !== "archived" && (
          <div className="wa-actions">
            {canWithdraw && (
              <button type="button" className="wa-button wa-button--danger wa-button--small" onClick={() => setAsking("withdraw")}>
                Withdraw consent
              </button>
            )}
            <button type="button" className="wa-button wa-button--quiet wa-button--small" onClick={() => setAsking("archive")}>
              <Archive aria-hidden className="wa-icon wa-icon--sm" />Archive
            </button>
          </div>
        )}
      </div>
      {asking === "withdraw" && (
        <Notice tone="attention" title="Withdraw consent?" actions={<>
          <button type="button" className="wa-button wa-button--danger" disabled={busy} onClick={() => void confirm(onWithdraw)}>Withdraw consent</button>
          <button type="button" className="wa-button wa-button--secondary" disabled={busy} onClick={() => setAsking(null)}>Keep consent</button>
        </>}>
          Any transcription stops, and both audio tracks and the transcript are deleted. This cannot be undone.
        </Notice>
      )}
      {asking === "archive" && (
        <Notice tone="attention" title="Archive this consultation?" actions={<>
          <button type="button" className="wa-button wa-button--danger" disabled={busy} onClick={() => void confirm(onArchive)}>Archive consultation</button>
          <button type="button" className="wa-button wa-button--secondary" disabled={busy} onClick={() => setAsking(null)}>Keep consultation</button>
        </>}>
          It moves to Archived instead of being permanently deleted. Any transcription or form work still running will stop.
        </Notice>
      )}
    </>
  );
}
