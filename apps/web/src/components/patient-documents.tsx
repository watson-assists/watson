"use client";

import { Camera, Check, FileText, ImageIcon, Lock, MessageCircle, Plus } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Notice } from "@/components/status";
import { call, explain, FIELD_MESSAGE } from "@/lib/api";
import { DOCUMENT_ACCEPT, fileSize, sendDocument } from "@/lib/documents";
import { supabase } from "@/lib/supabase";
import { WATSON_WHATSAPP, whatsappLink } from "@/lib/whatsapp";

export type SentDocument = {
  id: string; file_name: string; media_type: string; size_bytes: number; created_at: string;
  removed_at: string | null; cleanup_completed_at: string | null;
};
type Props = {
  token: string;
  whatsappCode: string;
  patient: { name: string; contact: string } | null;
  documents: SentDocument[];
  onChanged: () => void;
};

/** On the patient's link: who they are, and the documents they send their practitioner. */
export function PatientDocuments({ token, whatsappCode, patient, documents, onChanged }: Props) {
  const [name, setName] = useState(patient?.name ?? "");
  const [contact, setContact] = useState(patient?.contact ?? "");
  const [saved, setSaved] = useState(patient ? `${patient.name}\n${patient.contact}` : "");
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [sending, setSending] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  // On Watson's own gateway the number is the owner's: given to this link only, never in the page's code.
  const [watson, setWatson] = useState(WATSON_WHATSAPP);
  useEffect(() => {
    call<{ number: string | null }>("watson_whatsapp", { p_token: token })
      .then((answer) => { if (answer.ok && answer.number) setWatson(answer.number); });
  }, [token]);
  const files = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);

  /** Saves the name and phone or email when they changed. False when they were refused. */
  async function identify(): Promise<boolean> {
    const typed = `${name.trim()}\n${contact.trim()}`;
    if (typed === saved) return true;
    const outcome = await call("patient_identify", { p_token: token, p_name: name, p_contact: contact });
    if (outcome.ok) {
      setSaved(typed);
      return true;
    }
    if (outcome.field) setFieldError({ field: outcome.field, message: FIELD_MESSAGE[outcome.field] ?? explain(outcome.error_category) });
    else setProblem(explain(outcome.error_category));
    return false;
  }

  async function send(event: ChangeEvent<HTMLInputElement>) {
    const chosen = [...(event.target.files ?? [])];
    event.target.value = ""; // the same file can be chosen again
    if (chosen.length === 0) return;
    setProblem(null);
    setFieldError(null);
    if (!(await identify())) return;
    setSending(chosen.map((file) => file.name));
    const failures: string[] = [];
    for (const file of chosen) {
      const failed = await sendDocument(
        file,
        (mediaType) => call<{ document_id: string; path: string }>("patient_add_document", {
          p_token: token, p_file_name: file.name, p_media_type: mediaType, p_size_bytes: file.size,
        }),
        (documentId) => call("patient_confirm_document", { p_token: token, p_document_id: documentId }),
      );
      if (failed) failures.push(`${file.name}: ${failed}`);
      setSending((left) => left.filter((other) => other !== file.name));
    }
    if (failures.length > 0) setProblem(failures.join(" "));
    onChanged();
  }

  async function remove(document: SentDocument) {
    setProblem(null);
    const outcome = await call<{ path: string }>("patient_remove_document", { p_token: token, p_document_id: document.id });
    if (!outcome.ok) return setProblem(explain(outcome.error_category));
    const { data, error } = await supabase.functions.invoke<{ ok: boolean }>("document-cleanup", {
      body: { document_id: document.id, token },
    });
    if (error || !data?.ok) setProblem("Access was revoked, but storage cleanup is pending. Retry removal.");
    onChanged();
  }

  const error = (field: string) => fieldError?.field === field ? fieldError.message : null;
  return (
    <section className="wa-panel wa-patient-entry" aria-labelledby="documents-title">
      <h2 className="wa-heading" id="documents-title">Documents for your practitioner</h2>
      <p className="wa-text">
        Lab results, reports or a list of your medicines. Your practitioner sees them before the call, and Watson, their assistant, reads them to prepare.
      </p>
      <div className="wa-field">
        <label className="wa-label" htmlFor="patient-name">Your name</label>
        <input id="patient-name" className="wa-input" autoComplete="name" value={name} maxLength={120}
          aria-invalid={Boolean(error("name"))} aria-describedby={error("name") ? "patient-name-error" : undefined}
          onChange={(event) => setName(event.target.value)} />
        {error("name") && <p id="patient-name-error" className="wa-error">{error("name")}</p>}
      </div>
      <div className="wa-field">
        <label className="wa-label" htmlFor="patient-contact">Phone or email</label>
        <input id="patient-contact" className="wa-input" autoComplete="tel" value={contact} maxLength={254}
          aria-invalid={Boolean(error("contact"))} aria-describedby={error("contact") ? "patient-contact-error" : "patient-contact-hint"}
          onChange={(event) => setContact(event.target.value)} />
        {error("contact") ? <p id="patient-contact-error" className="wa-error">{error("contact")}</p> : (
          <p id="patient-contact-hint" className="wa-hint">
            Your documents are kept under this, so they are there at your next consultation too. No account needed.
          </p>
        )}
      </div>

      {(documents.length > 0 || sending.length > 0) && <SentList documents={documents} sending={sending} onRemove={(document) => void remove(document)} />}

      <div className="wa-actions">
        <button type="button" className="wa-button wa-button--secondary" disabled={sending.length > 0} onClick={() => files.current?.click()}>
          <Plus aria-hidden className="wa-icon" />Add a document
        </button>
        <button type="button" className="wa-button wa-button--secondary wa-only-touch" disabled={sending.length > 0} onClick={() => camera.current?.click()}>
          <Camera aria-hidden className="wa-icon" />Take a photo
        </button>
        <input ref={files} type="file" accept={DOCUMENT_ACCEPT} multiple hidden aria-label="Documents to send" onChange={send} />
        <input ref={camera} type="file" accept="image/*" capture="environment" hidden aria-label="Photo to send" onChange={send} />
      </div>
      {problem && <Notice tone="failed" title="Not sent">{problem}</Notice>}
      <WhatsAppInstead number={watson} code={whatsappCode} />
      <p className="wa-hint" style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <Lock aria-hidden className="wa-icon wa-icon--sm" />PDF or photo, up to 10 MB each. Only your practitioner can open them.
      </p>
    </section>
  );
}

/** The documents the patient sent, and those still on their way. */
function SentList({ documents, sending, onRemove }: { documents: SentDocument[]; sending: string[]; onRemove: (document: SentDocument) => void }) {
  return (
    <ul className="wa-docs" aria-label="Documents you sent">
      {documents.map((document) => (
        <li key={document.id} className="wa-doc">
          {document.media_type === "application/pdf" ? <FileText aria-hidden className="wa-icon" /> : <ImageIcon aria-hidden className="wa-icon" />}
          <div className="wa-doc__body">
            <p className="wa-doc__name">{document.file_name}</p>
            <p className="wa-doc__meta">{fileSize(document.size_bytes)}</p>
          </div>
          <div className="wa-doc__end">
            {document.removed_at ? (
              <span className={`wa-chip ${document.cleanup_completed_at ? "wa-chip--done" : "wa-chip--attention"}`}>
                {document.cleanup_completed_at ? "Removed" : "Removal pending"}
              </span>
            ) : (
              <span className="wa-chip wa-chip--done"><Check aria-hidden className="wa-icon wa-icon--sm" />Sent</span>
            )}
            {(!document.removed_at || !document.cleanup_completed_at) && (
              <button type="button" className="wa-button wa-button--quiet wa-button--small" aria-label={
                document.removed_at ? `Retry removal of ${document.file_name}` : `Remove ${document.file_name}`
              } onClick={() => onRemove(document)}>
                {document.removed_at ? "Retry removal" : "Remove"}
              </button>
            )}
          </div>
        </li>
      ))}
      {sending.map((fileName) => (
        <li key={fileName} className="wa-doc" aria-busy="true">
          <FileText aria-hidden className="wa-icon" />
          <div className="wa-doc__body">
            <p className="wa-doc__name">{fileName}</p>
            <p className="wa-doc__meta">Sending…</p>
          </div>
          <div className="wa-doc__end" />
          <div className="wa-bar" aria-hidden />
        </li>
      ))}
    </ul>
  );
}

/** On a phone, WhatsApp is the easier way to send documents. */
function WhatsAppInstead({ number, code }: { number: string; code: string }) {
  return (
    <div className="wa-whatsapp">
      <p className="wa-text" style={{ margin: 0 }}>On your phone? Send them on WhatsApp instead. Watson answers there with your link.</p>
      <a className="wa-button wa-button--secondary" target="_blank" rel="noopener noreferrer"
        href={whatsappLink(number, `Watson ${code}`)}>
        <MessageCircle aria-hidden className="wa-icon" />Message Watson on WhatsApp
      </a>
    </div>
  );
}
