"use client";

import { Download, FileText, Pencil, Printer, RefreshCw } from "lucide-react";
import Link from "next/link";
import type { CSSProperties } from "react";
import { Notice } from "@/components/status";
import { forPatient, type FormTemplate } from "@/lib/export";
import { SENT_BY, type Answer, type Loaded } from "@/lib/form-page";
import { dateTime } from "@/lib/status";

/** The top of the form: whose it is, how it was made, how far the check got, and taking it out. */
export function FormHero({ loaded, counts, suggested, busy, onDownload }: {
  loaded: Loaded; counts: { answered: number; asked: number; checked: number };
  suggested: Answer[]; busy: boolean; onDownload: () => void;
}) {
  const { consultation, patientName, form, documents } = loaded;
  const template = form.template as unknown as FormTemplate;
  const approved = form.status === "approved";
  const { answered, asked, checked } = counts;
  return (
    <section className="wa-hero" aria-labelledby="form-title">
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 24 }}>
        <div style={{ display: "grid", gap: 6 }}>
          <p className="wa-hero__eyebrow">{template.title}</p>
          <h1 className="wa-hero__title" id="form-title">{patientName ?? consultation.synthetic_patient_ref}</h1>
          <p className="wa-hero__meta">
            {form.job_id === null ? `Written by you, without a recording, for the consultation of ${dateTime(consultation.scheduled_at)}` : <>
              Filled in by Watson from {form.transcript_id ? "the call" : "your notes"} of {dateTime(consultation.scheduled_at)}
              {documents.size > 0 && ` and ${documents.size === 1 ? "one document" : `${documents.size} documents`}`} · {answered} of {asked} answered
              {asked > answered && ` · ${asked - answered} ${form.transcript_id ? "not discussed" : "not in your notes"}`}
            </>}
          </p>
          <div className="wa-actions" style={{ marginTop: 8 }}>
            <button type="button" className="wa-button wa-button--secondary" disabled={busy} onClick={onDownload}>
              <Download aria-hidden className="wa-icon" />Download as Excel
            </button>
            <Link href={`/print/?id=${consultation.id}`} className="wa-button wa-button--secondary">
              <Printer aria-hidden className="wa-icon" />Print or save as PDF
            </Link>
            {approved && forPatient(template).sections.length > 0 && (
              <Link href={`/print/?id=${consultation.id}&for=patient`} className="wa-button wa-button--secondary">
                <FileText aria-hidden className="wa-icon" />Print for the patient
              </Link>
            )}
          </div>
        </div>
        {!approved && answered > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div className="wa-ring" style={{ "--p": checked / answered } as CSSProperties}>
              <span>{checked}/{answered}<small>checked</small></span>
            </div>
          </div>
        )}
      </div>
      {suggested.length > 0 && form.job_id !== null && (
        <div className="wa-suggests">
          <p className="wa-suggests__title">Watson suggests · decide yourself</p>
          {suggested.map((answer) => (
            <p key={answer.field_key} className="wa-suggests__text">{answer.review === "edited" ? answer.practitioner_text : answer.machine_text}</p>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Where the form stands: approved (and, for the doctor who approved it, changed as a new version);
 * being changed; or missing documents that arrived after Watson filled it in.
 */
export function FormNotices({ loaded, mine, changing, busy, onChange, onDiscard, onFillAgain }: {
  loaded: Loaded; mine: boolean; changing: boolean; busy: boolean;
  onChange: () => void; onDiscard: () => void; onFillAgain: () => void;
}) {
  const { consultation, form, late } = loaded;
  const approved = form.status === "approved";
  return (
    <>
      {approved && (
        <Notice title={`Approved ${form.approved_at ? dateTime(form.approved_at) : ""}`} actions={mine && (
          <button type="button" className="wa-button wa-button--secondary" disabled={busy} onClick={onChange}>
            <Pencil aria-hidden className="wa-icon" />Change the form
          </button>
        )}>This form is final. It is the record of the consultation.{mine && " A change becomes a new version; this one is kept."}</Notice>
      )}
      {changing && (
        <Notice tone="attention" title="Changing the approved form" actions={
          <button type="button" className="wa-button wa-button--secondary" disabled={busy} onClick={onDiscard}>Discard changes</button>
        }>
          Change any answer below, then approve the changes. Until then the patient sees the form as you approved it before.
        </Notice>
      )}
      {!approved && form.transcript_id && late.length > 0 && ["draft_ready", "under_review"].includes(consultation.status) && (
        <Notice tone="attention" title={late.length === 1 ? "A document arrived after Watson filled this in" : `${late.length} documents arrived after Watson filled this in`}
          actions={<button type="button" className="wa-button wa-button--secondary wa-button--small" disabled={busy} onClick={onFillAgain}>
            <RefreshCw aria-hidden className="wa-icon wa-icon--sm" />Fill in again</button>}>
          {late.map((document) => `${document.file_name}, ${SENT_BY[document.source] ?? "sent"} on ${dateTime(document.uploaded_at)}`).join("; ")}.
          {" "}Watson can fill in the form again with {late.length === 1 ? "it" : "them"}, in about 5 minutes. Answers you have already checked stay as you left them.
        </Notice>
      )}
    </>
  );
}
