"use client";

import { Check, CircleX, Eye, FileText, ImageIcon, LoaderCircle, Plus, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { Notice } from "@/components/status";
import { call, explain, FIELD_MESSAGE } from "@/lib/api";
import type { Tables } from "@/lib/database.types";
import type { Person } from "@/lib/patient";
import { DocumentViewer } from "@/components/document-viewer";
import { DOCUMENT_ACCEPT, openDocument, sendDocument, showsInPage } from "@/lib/documents";
import { dateTime, dayMonth } from "@/lib/status";
import { supabase } from "@/lib/supabase";

type Patient = Pick<Tables<"patients">, "id" | "name" | "phone" | "email">;
type Document = Pick<Tables<"patient_documents">,
  "id" | "consultation_id" | "file_name" | "media_type" | "source" | "uploaded_at" | "reading" | "page_texts" | "storage_path" | "removed_at" | "cleanup_completed_at"
> & { consultations: { scheduled_at: string } | null };

/** This consultation's documents, and once the patient is confirmed, those from their other visits too (SEC-02). */
async function fetchDocuments(consultationId: string, patientId: string | undefined): Promise<Document[]> {
  const { data } = await supabase.from("patient_documents")
    .select("id, consultation_id, file_name, media_type, source, uploaded_at, reading, page_texts, storage_path, removed_at, cleanup_completed_at, consultations(scheduled_at)")
    .or(patientId ? `consultation_id.eq.${consultationId},patient_id.eq.${patientId}` : `consultation_id.eq.${consultationId}`)
    .not("uploaded_at", "is", null).order("uploaded_at", { ascending: false });
  return (data ?? []) as Document[];
}

const FROM: Record<string, string> = { patient: "sent by the patient", practitioner: "added by you", whatsapp: "sent on WhatsApp" };

/**
 * Who the patient is, and every document they or you added, with what Watson could read. `patient` is the
 * confirmed record; `person` is who the consultation is with as shown, which may still be what they typed.
 */
export function DocumentsPanel({ consultationId, patient, person, onChanged }: {
  consultationId: string;
  patient: Patient | null;
  person: Person | null;
  onChanged: () => void;
}) {
  const [documents, setDocuments] = useState<Document[] | null>(null);
  const [editing, setEditing] = useState(person === null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Document | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const patientId = patient?.id;
  const load = useCallback(() => void fetchDocuments(consultationId, patientId).then(setDocuments), [consultationId, patientId]);
  useEffect(() => {
    let current = true;
    fetchDocuments(consultationId, patientId).then((result) => current && setDocuments(result));
    return () => { current = false; };
  }, [consultationId, patientId]);

  // While Watson is reading something, look again every few seconds.
  const reading = documents?.some((document) => document.removed_at === null && (document.reading === "waiting" || document.reading === "reading"));
  useEffect(() => {
    if (!reading) return;
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [reading, load]);

  async function add(event: ChangeEvent<HTMLInputElement>) {
    const chosen = [...(event.target.files ?? [])];
    event.target.value = "";
    if (chosen.length === 0) return;
    setBusy(true);
    setProblem(null);
    const failures: string[] = [];
    for (const file of chosen) {
      const failed = await sendDocument(
        file,
        (mediaType) => call<{ document_id: string; path: string }>("add_document", {
          p_consultation_id: consultationId, p_file_name: file.name, p_media_type: mediaType, p_size_bytes: file.size,
        }),
        (documentId) => call("confirm_document", { p_document_id: documentId }),
      );
      if (failed) failures.push(`${file.name}: ${failed}`);
    }
    setBusy(false);
    if (failures.length > 0) setProblem(failures.join(" "));
    load();
  }

  async function remove(document: Document) {
    setBusy(true);
    const outcome = await call<{ path: string }>("remove_document", { p_document_id: document.id });
    if (outcome.ok) {
      const { data, error } = await supabase.functions.invoke<{ ok: boolean }>("document-cleanup", { body: { document_id: document.id } });
      if (error || !data?.ok) setProblem("Access was revoked, but storage cleanup is pending. Retry removal.");
    } else setProblem(explain(outcome.error_category));
    setBusy(false);
    setRemoving(null);
    load();
  }

  async function readAgain(document: Document) {
    const outcome = await call("read_document_again", { p_document_id: document.id });
    if (!outcome.ok) setProblem(explain(outcome.error_category));
    load();
  }

  const notOpened = () => setProblem("The document could not be opened. Try again.");
  async function open(document: Document) {
    if (showsInPage(document.media_type)) return setViewing(document);
    if (!(await openDocument(document.storage_path))) notOpened();
  }

  const any = documents !== null && documents.length > 0;
  return (
    <section className="wa-panel" aria-labelledby="documents-title">
      <div className="wa-panel__head">
        <div style={{ display: "grid", gap: 4 }}>
          <h2 className="wa-heading" id="documents-title">Documents</h2>
          {any && <DocumentCounts documents={documents} />}
        </div>
        {person && !editing && (
          <button type="button" className="wa-button wa-button--secondary wa-button--small" disabled={busy} onClick={() => picker.current?.click()}>
            <Plus aria-hidden className="wa-icon wa-icon--sm" />Add a document
          </button>
        )}
        <input ref={picker} type="file" accept={DOCUMENT_ACCEPT} multiple hidden aria-label="Documents to add" onChange={add} />
      </div>
      {editing ? <PatientDetails consultationId={consultationId} person={person} onSaved={() => { setEditing(false); onChanged(); }}
        onCancel={() => setEditing(false)} onProblem={setProblem} />
        : person && (
          <p className="wa-meta" style={{ margin: 0 }}>
            {person.name} · {person.phone ?? person.email}{" "}
            <button type="button" className="wa-button wa-button--quiet wa-button--small" onClick={() => setEditing(true)}>Change</button>
          </p>
        )}
      {any && (
        <ul className="wa-docs" aria-label="The patient's documents">
          {documents.map((document) => (
            <DocumentRow key={document.id} document={document} consultationId={consultationId} busy={busy} asking={removing === document.id}
              onOpen={() => void open(document)} onAsk={() => setRemoving(document.id)} onKeep={() => setRemoving(null)}
              onRemove={() => void remove(document)} onReadAgain={() => void readAgain(document)} />
          ))}
        </ul>
      )}
      {documents && documents.length === 0 && person && !editing && (
        <p className="wa-text">No documents yet. The patient can send them from their link.</p>
      )}
      {problem && <Notice tone="failed" title="That did not work">{problem}</Notice>}
      <DocumentViewer document={viewing} onClose={() => setViewing(null)} onFailed={() => { setViewing(null); notOpened(); }} />
      {any && (
        <p className="wa-hint">Watson uses what it reads when it fills in your form, and shows the page each answer comes from. Only you can open these documents.</p>
      )}
    </section>
  );
}

function DocumentCounts({ documents }: { documents: Document[] }) {
  const active = documents.filter((document) => document.removed_at === null);
  return (
    <ul className="wa-facts">
      <li>{active.filter((document) => document.source !== "practitioner").length} sent by the patient</li>
      <li>{active.filter((document) => document.reading === "read").length} read by Watson</li>
    </ul>
  );
}

/** Who the patient is: their name and phone or email, under which their documents are kept. */
function PatientDetails({ consultationId, person, onSaved, onCancel, onProblem }: {
  consultationId: string; person: Person | null; onSaved: () => void; onCancel: () => void; onProblem: (problem: string | null) => void;
}) {
  const [name, setName] = useState(person?.name ?? "");
  const [contact, setContact] = useState(person?.phone ?? person?.email ?? "");
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    onProblem(null);
    setFieldError(null);
    const outcome = await call("set_patient", { p_consultation_id: consultationId, p_name: name, p_contact: contact });
    setBusy(false);
    if (outcome.ok) return onSaved();
    // A refused field is shown under it; anything else in the panel's notice.
    if (outcome.field) return setFieldError({ field: outcome.field, message: FIELD_MESSAGE[outcome.field] ?? explain(outcome.error_category) });
    onProblem(explain(outcome.error_category));
  }
  const error = (field: string) => fieldError?.field === field ? fieldError.message : null;
  return (
    <form className="wa-form" style={{ gap: 12 }} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <p className="wa-text">
        {person ? "Change the patient\u2019s name, phone number or email." :
          "Who is the patient? The patient can also fill this in from their link. Their documents are kept under their phone number or email."}
      </p>
      <div className="wa-field">
        <label className="wa-label" htmlFor="patient-name">Patient&apos;s name</label>
        <input id="patient-name" className="wa-input" value={name} maxLength={120} aria-invalid={Boolean(error("name"))}
          onChange={(event) => setName(event.target.value)} />
        {error("name") && <p className="wa-error">{error("name")}</p>}
      </div>
      <div className="wa-field">
        <label className="wa-label" htmlFor="patient-contact">Phone or email</label>
        <input id="patient-contact" className="wa-input" value={contact} maxLength={254} aria-invalid={Boolean(error("contact"))}
          onChange={(event) => setContact(event.target.value)} />
        {error("contact") ? <p className="wa-error">{error("contact")}</p> : <p className="wa-hint">With the country code, like +421 900 123 456.</p>}
      </div>
      <div className="wa-actions">
        <button type="submit" className="wa-button wa-button--primary" disabled={busy}>Save patient</button>
        {person && <button type="button" className="wa-button wa-button--quiet" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

/** One document: what it is, where it came from, what Watson read, and opening or removing it. */
function DocumentRow({ document, consultationId, busy, asking, onOpen, onAsk, onKeep, onRemove, onReadAgain }: {
  document: Document; consultationId: string; busy: boolean; asking: boolean;
  onOpen: () => void; onAsk: () => void; onKeep: () => void; onRemove: () => void; onReadAgain: () => void;
}) {
  const pages = document.reading === "read" && document.page_texts ? document.page_texts.length : null;
  return (
    <li className="wa-doc">
      {document.media_type === "application/pdf" ? <FileText aria-hidden className="wa-icon" /> : <ImageIcon aria-hidden className="wa-icon" />}
      <div className="wa-doc__body">
        <p className="wa-doc__name">{document.file_name}</p>
        <p className="wa-doc__meta">
          {pages !== null && `${pages} ${pages === 1 ? "page" : "pages"} · `}
          {FROM[document.source]} {dateTime(document.uploaded_at!)}
          {document.consultation_id !== consultationId && document.consultations &&
            ` · from the consultation of ${dayMonth(document.consultations.scheduled_at)}`}
        </p>
      </div>
      <div className="wa-doc__end">
        {document.removed_at ? <Removed document={document} busy={busy} onRetry={onRemove} />
          : <>
            <Reading document={document} onTryAgain={onReadAgain} />
            {asking ? (
              <>
                <button type="button" className="wa-button wa-button--danger wa-button--small" disabled={busy} onClick={onRemove}>Remove for good</button>
                <button type="button" className="wa-button wa-button--quiet wa-button--small" onClick={onKeep}>Keep</button>
              </>
            ) : (
              <>
                <button type="button" className="wa-button wa-button--secondary wa-button--small" aria-label={`Open ${document.file_name}`} onClick={onOpen}>
                  <Eye aria-hidden className="wa-icon wa-icon--sm" />Open
                </button>
                <button type="button" className="wa-button wa-button--quiet wa-button--small" aria-label={`Remove ${document.file_name}`} onClick={onAsk}>
                  Remove
                </button>
              </>
            )}
          </>}
      </div>
    </li>
  );
}

function Removed({ document, busy, onRetry }: { document: Document; busy: boolean; onRetry: () => void }) {
  return (
    <>
      <span className={`wa-chip ${document.cleanup_completed_at ? "wa-chip--done" : "wa-chip--attention"}`}>
        {document.cleanup_completed_at ? "Removed" : "Removal pending"}
      </span>
      {!document.cleanup_completed_at && (
        <button type="button" className="wa-button wa-button--quiet wa-button--small" disabled={busy}
          aria-label={`Retry removal of ${document.file_name}`} onClick={onRetry}>
          Retry removal
        </button>
      )}
    </>
  );
}

function Reading({ document, onTryAgain }: { document: Document; onTryAgain: () => void }) {
  switch (document.reading) {
    case "read":
      return <span className="wa-chip wa-chip--done"><Check aria-hidden className="wa-icon wa-icon--sm" />Read by Watson</span>;
    case "unreadable":
      return <span className="wa-chip"><Eye aria-hidden className="wa-icon wa-icon--sm" />Read it yourself</span>;
    case "failed":
      return (
        <>
          <span className="wa-chip wa-chip--failed"><CircleX aria-hidden className="wa-icon wa-icon--sm" />Not read</span>
          <button type="button" className="wa-button wa-button--quiet wa-button--small" onClick={onTryAgain}>
            <RotateCcw aria-hidden className="wa-icon wa-icon--sm" />Try again
          </button>
        </>
      );
    default:
      return <span className="wa-chip wa-chip--current"><LoaderCircle aria-hidden className="wa-icon wa-icon--sm wa-spin" />Reading…</span>;
  }
}
