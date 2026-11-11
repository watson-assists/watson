"use client";

import { Check, ChevronLeft, Download, FileText, Pencil, Printer, RefreshCw, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { Notice } from "@/components/status";
import { call, explain, isId } from "@/lib/api";
import { clock } from "@/lib/audio";
import { openDocument } from "@/lib/documents";
import { downloadConsultation } from "@/lib/download";
import type { Tables } from "@/lib/database.types";
import { isTypedFormTemplate } from "@/lib/export";
import { loadRecords } from "@/lib/records";
import { RequireSession } from "@/lib/session";
import { dateTime } from "@/lib/status";
import { supabase } from "@/lib/supabase";

type Answer = Tables<"form_answers">;
type Segment = Pick<Tables<"transcript_segments">, "position" | "speaker" | "start_seconds" | "machine_text" | "reviewed_text">;
type Option = { key: string; label: string; label_i18n?: { en: string; sk: string } };
type Field = { key: string; label: string; label_i18n?: { en: string; sk: string };
  mode?: "extract" | "suggest" | "manual"; value_type?: string; options?: Option[];
  item_fields?: Field[]; required?: boolean; clinician_confirmation?: boolean };
type Template = { title: string; title_i18n?: { en: string; sk: string };
  sections: { title: string; title_i18n?: { en: string; sk: string }; fields: Field[] }[];
  approval_gates?: { key: string; type: "attestation" | "signature"; field_key: string;
    signer_role?: "patient" | "practitioner" }[] };
type DocumentQuote = { document_id: string; page: number; text: string };
type Loaded = {
  consultation: Tables<"consultations">;
  patientName: string | null;
  form: Tables<"forms">;
  answers: Answer[];
  segments: Map<number, Segment>;
  // The patient's documents the answers quote: name and where to open it.
  documents: Map<string, { file_name: string; storage_path: string }>;
  // Documents Watson did not have when it filled the form in (read after the engine took the job,
  // and not quoted): reason to fill it in again.
  late: { file_name: string; source: string; uploaded_at: string }[];
  attestations: Tables<"form_attestations">[];
  signatures: Tables<"form_signatures">[];
  conflicts: Tables<"form_reconciliation_conflicts">[];
};

/** Who sent a document, in the practitioner's words. */
const SENT_BY: Record<string, string> = {
  whatsapp: "sent by the patient on WhatsApp",
  patient: "sent by the patient from their link",
  practitioner: "added by you",
};
const documentQuotes = (answer: Answer) => (answer.document_quotes ?? []) as unknown as DocumentQuote[];

export default function FormPage() {
  return (
    <RequireSession>
      {(user) => (
        <AppShell user={user}>
          <Suspense fallback={<p className="wa-meta" role="status">Loading the form…</p>}>
            <FormView />
          </Suspense>
        </AppShell>
      )}
    </RequireSession>
  );
}

async function fetchForm(id: string): Promise<Loaded | "missing" | "failed"> {
  const [consultation, form] = await Promise.all([
    supabase.from("consultations").select("*").eq("id", id).maybeSingle(),
    supabase.from("forms").select("*, form_jobs!forms_job_id_fkey(claimed_at)").eq("consultation_id", id)
      .neq("status", "superseded").order("revision_number", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (consultation.error || form.error) return "failed";
  if (!consultation.data || !form.data) return "missing";
  const [answers, segments, attestations, signatures, conflicts] = await Promise.all([
    supabase.from("form_answers").select("*").eq("form_id", form.data.id).order("position"),
    supabase.from("transcript_segments").select("position, speaker, start_seconds, machine_text, reviewed_text")
      .eq("transcript_id", form.data.transcript_id).order("position"),
    supabase.from("form_attestations").select("*").eq("form_id", form.data.id),
    supabase.from("form_signatures").select("*").eq("form_id", form.data.id),
    supabase.from("form_reconciliation_conflicts").select("*").eq("form_id", form.data.id).order("created_at"),
  ]);
  if (answers.error || segments.error || attestations.error || signatures.error || conflicts.error) return "failed";
  const quoted = [...new Set(answers.data.flatMap((answer) => documentQuotes(answer).map((quote) => quote.document_id)))];
  const [patient, documents, late] = await Promise.all([
    consultation.data.patient_id
      ? supabase.from("patients").select("name").eq("id", consultation.data.patient_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("patient_documents").select("id, file_name, storage_path").eq("consultation_id", id)
      .eq("reading", "read").is("removed_at", null),
    supabase.from("patient_documents").select("id, file_name, source, uploaded_at").eq("consultation_id", id)
      .eq("reading", "read").gt("read_at", form.data.form_jobs?.claimed_at ?? form.data.created_at).order("uploaded_at"),
  ]);
  return {
    consultation: consultation.data,
    patientName: patient.data?.name ?? consultation.data.patient_claim_name ?? null,
    form: form.data,
    answers: answers.data,
    segments: new Map(segments.data.map((segment) => [segment.position, segment])),
    documents: new Map((documents.data ?? []).map((document) => [document.id, document])),
    late: (late.data ?? []).filter((document) => document.uploaded_at !== null && !quoted.includes(document.id)) as Loaded["late"],
    attestations: attestations.data,
    signatures: signatures.data,
    conflicts: conflicts.data,
  };
}

const CHIP: Record<Answer["review"], [string, string]> = {
  unreviewed: ["wa-chip--attention", "To check"],
  accepted: ["wa-chip--done", "Accepted"],
  edited: ["wa-chip--current", "Edited by you"],
  rejected: ["wa-chip--failed", "Rejected"],
};

function FormView() {
  const id = useSearchParams().get("id") ?? "";
  const [loaded, setLoaded] = useState<Loaded | "missing" | "failed" | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const aside = useRef<HTMLElement>(null);
  const router = useRouter();

  const load = useCallback(() => {
    fetchForm(id).then(setLoaded);
  }, [id]);
  useEffect(() => {
    if (!isId(id)) return;
    let current = true;
    fetchForm(id).then((result) => current && setLoaded(result));
    return () => {
      current = false;
    };
  }, [id]);

  // Bring the first lit line of the conversation into view, inside its own panel only.
  useEffect(() => {
    const panel = aside.current;
    const lit = panel?.querySelector<HTMLElement>(".wa-turn--lit");
    if (panel && lit) panel.scrollTo({ top: lit.offsetTop - 80, behavior: "smooth" });
  }, [active, loaded]);

  const back = (
    <Link href={`/consultation/?id=${id}`} className="wa-crumb"><ChevronLeft aria-hidden className="wa-icon wa-icon--sm" />Consultation</Link>
  );
  if (!isId(id) || loaded === "missing") return <>{back}<p className="wa-text">There is no form for this consultation yet.</p></>;
  if (loaded === "failed") return <>{back}<Notice tone="failed" title="The form could not be loaded">Check your connection and reload the page.</Notice></>;
  if (loaded === null) return <p className="wa-meta" role="status">Loading the form…</p>;

  const { consultation, patientName, form, answers, segments, documents, late } = loaded;
  const template = form.template as unknown as Template;
  if (isTypedFormTemplate(template)) {
    return <TypedFormView loaded={loaded} template={template} reload={load} back={back} />;
  }
  const fields = new Map(template.sections.flatMap((section) => section.fields).map((field) => [field.key, field]));
  const byKey = new Map(answers.map((answer) => [answer.field_key, answer]));
  const approved = form.status === "approved";
  const answered = answers.filter((answer) => answer.machine_text !== null).length;
  const toCheck = answers.filter((answer) => answer.machine_text !== null && answer.review === "unreviewed").length;
  // A field only the practitioner fills in, such as private notes (owner, 24 Oct): never "not discussed".
  const manual = (answer: Answer) => fields.get(answer.field_key)?.mode === "manual";
  const asked = answers.filter((answer) => !manual(answer)).length;
  const isEmpty = (answer: Answer) => !manual(answer) && answer.machine_text === null && answer.review !== "edited";
  const suggested = answers.filter((answer) => fields.get(answer.field_key)?.mode === "suggest" && !isEmpty(answer) && answer.review !== "rejected");
  const checked = answered - toCheck;
  // The answer whose quotes are lit: the one picked, else the first still to check.
  const focus = active ?? answers.find((answer) => !isEmpty(answer) && answer.review === "unreviewed")?.field_key ?? null;
  const lit = new Set(byKey.get(focus ?? "")?.evidence ?? []);

  async function decide(key: string, decision: "accept" | "reject" | "edit" | "undo", text?: string) {
    setBusy(true);
    setProblem(null);
    const outcome = await call("review_form_answer", {
      p_form_id: form.id, p_field_key: key, p_decision: decision, p_text: text,
    });
    setBusy(false);
    if (!outcome.ok) return setProblem(explain(outcome.error_category));
    setEditing(null);
    load();
  }
  async function approve() {
    setBusy(true);
    setProblem(null);
    const outcome = await call("approve_form", { p_form_id: form.id });
    setBusy(false);
    if (!outcome.ok) return setProblem(explain(outcome.error_category));
    load();
  }
  async function fillAgain() {
    setBusy(true);
    setProblem(null);
    const outcome = await call("fill_form_again", { p_consultation_id: consultation.id });
    if (outcome.ok) return router.push(`/consultation/?id=${consultation.id}`);
    setBusy(false);
    setProblem(explain(outcome.error_category));
  }
  async function downloadExcel() {
    setBusy(true);
    setProblem(null);
    const records = await loadRecords(consultation.id);
    setBusy(false);
    if (!records?.length) return setProblem("The form could not be loaded. Check your connection and try again.");
    downloadConsultation(records[0]);
  }
  function edit(answer: Answer) {
    setEditing(answer.field_key);
    setDraft(answer.practitioner_text ?? answer.machine_text ?? "");
  }

  function card(answer: Answer) {
    const field = fields.get(answer.field_key);
    const label = field?.label ?? answer.field_key;
    const empty = isEmpty(answer);
    const text = answer.review === "edited" ? answer.practitioner_text : answer.machine_text;
    const own = manual(answer);
    const [chipClass, chipText] = own ? ["wa-chip--done", "Only for you"] : empty ? ["wa-chip--done", "Not discussed"] : CHIP[answer.review];
    const settled = answer.review !== "unreviewed";
    const modifier = empty ? " wa-answer--empty" : answer.review === "rejected" ? " wa-answer--rejected wa-answer--settled" : settled ? " wa-answer--settled" : "";
    const quotes = answer.evidence.map((position) => segments.get(position)).filter((segment) => segment !== undefined);
    return (
      <article key={answer.field_key} className={`wa-answer${modifier}${focus === answer.field_key ? " wa-answer--active" : ""}`}
        aria-labelledby={`f-${answer.field_key}`} onClick={() => setActive(answer.field_key)} onFocus={() => setActive(answer.field_key)}>
        <div className="wa-answer__head">
          <h3 className="wa-answer__label" id={`f-${answer.field_key}`}>
            {label}{field?.mode === "suggest" && <> <span className="wa-tag wa-tag--attention">Suggestion</span></>}
          </h3>
          <span className={`wa-chip ${chipClass}`}>
            {answer.review === "accepted" && <Check aria-hidden className="wa-icon wa-icon--sm" />}
            {answer.review === "edited" && <Pencil aria-hidden className="wa-icon wa-icon--sm" />}
            {answer.review === "rejected" && <X aria-hidden className="wa-icon wa-icon--sm" />}
            {chipText}
          </span>
        </div>
        {editing === answer.field_key ? (
          <form className="wa-field" onSubmit={(event) => { event.preventDefault(); decide(answer.field_key, "edit", draft); }}>
            <label className="wa-label" htmlFor={`e-${answer.field_key}`}>Your answer</label>
            <textarea id={`e-${answer.field_key}`} className="wa-input wa-textarea" value={draft} maxLength={4000}
              onChange={(event) => setDraft(event.target.value)} autoFocus />
            <div className="wa-actions">
              <button type="submit" className="wa-button wa-button--secondary wa-button--small" disabled={busy || !draft.trim()}>Save</button>
              <button type="button" className="wa-button wa-button--quiet wa-button--small" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </form>
        ) : (
          <>
            {(!own || text) && <p className="wa-answer__text">{empty ? "Not discussed in the conversation." : text}</p>}
            {own && <p className="wa-hint">Only you see this. Watson does not fill it in, and it is never shared.</p>}
          </>
        )}
        {field?.mode === "suggest" && !empty && answer.review === "unreviewed" && (
          <p className="wa-hint">Watson&apos;s reading of the conversation, not a diagnosis. Accept it only if it is your assessment.</p>
        )}
        {(quotes.length > 0 || documentQuotes(answer).length > 0) && (
          <ul className="wa-quotes" aria-label="Where this comes from">
            {quotes.map((segment) => (
              <li key={segment.position} className={`wa-quote wa-quote--${segment.speaker}`}>
                <div>
                  <span className="wa-quote__who">{segment.speaker === "patient" ? "Patient" : "Practitioner"} · {clock(Number(segment.start_seconds))}</span>
                  <p className="wa-quote__text">{segment.reviewed_text ?? segment.machine_text}</p>
                </div>
              </li>
            ))}
            {documentQuotes(answer).map((quote, index) => {
              const document = documents.get(quote.document_id);
              return (
                <li key={`d${index}`} className="wa-quote wa-quote--document">
                  <div>
                    <span className="wa-quote__who" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                      <FileText aria-hidden className="wa-icon wa-icon--sm" />
                      {document ? (
                        <button type="button" className="wa-link" onClick={() => void openDocument(document.storage_path)}>{document.file_name}</button>
                      ) : "A removed document"} · page {quote.page}
                    </span>
                    <p className="wa-quote__text">{quote.text}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {own && !approved && editing !== answer.field_key && (
          <div className="wa-actions">
            <button type="button" className="wa-button wa-button--secondary" disabled={busy} onClick={() => edit(answer)}>
              <Pencil aria-hidden className="wa-icon wa-icon--sm" />{text ? "Edit" : "Write"}
            </button>
          </div>
        )}
        {!own && !approved && editing !== answer.field_key && (
          <div className="wa-actions">
            {settled ? (
              <button type="button" className="wa-button wa-button--quiet wa-button--small" disabled={busy}
                onClick={() => decide(answer.field_key, "undo")}>Change</button>
            ) : (
              <>
                <button type="button" className="wa-button wa-button--secondary wa-button--small" disabled={busy}
                  onClick={() => decide(answer.field_key, "accept")}><Check aria-hidden className="wa-icon wa-icon--sm" />Accept</button>
                <button type="button" className="wa-button wa-button--secondary wa-button--small" disabled={busy}
                  onClick={() => edit(answer)}><Pencil aria-hidden className="wa-icon wa-icon--sm" />Edit</button>
                <button type="button" className="wa-button wa-button--quiet wa-button--small" disabled={busy}
                  onClick={() => decide(answer.field_key, "reject")}>Reject</button>
              </>
            )}
          </div>
        )}
      </article>
    );
  }

  return (
    <>
      {back}
      <section className="wa-hero" aria-labelledby="form-title">
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 24 }}>
          <div style={{ display: "grid", gap: 6 }}>
            <p className="wa-hero__eyebrow">{template.title}</p>
            <h1 className="wa-hero__title" id="form-title">{patientName ?? consultation.synthetic_patient_ref}</h1>
            <p className="wa-hero__meta">
              Filled in by Watson from the call of {dateTime(consultation.scheduled_at)}
              {documents.size > 0 && ` and ${documents.size === 1 ? "one document" : `${documents.size} documents`}`} · {answered} of {asked} answered
              {asked > answered && ` · ${asked - answered} not discussed`}
            </p>
            <div className="wa-actions" style={{ marginTop: 8 }}>
              <button type="button" className="wa-button wa-button--secondary" disabled={busy} onClick={() => void downloadExcel()}>
                <Download aria-hidden className="wa-icon" />Download as Excel
              </button>
              <Link href={`/print/?id=${consultation.id}`} className="wa-button wa-button--secondary">
                <Printer aria-hidden className="wa-icon" />Print or save as PDF
              </Link>
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
        {suggested.length > 0 && (
          <div className="wa-suggests">
            <p className="wa-suggests__title">Watson suggests · decide yourself</p>
            {suggested.map((answer) => (
              <p key={answer.field_key} className="wa-suggests__text">{answer.review === "edited" ? answer.practitioner_text : answer.machine_text}</p>
            ))}
          </div>
        )}
      </section>
      {approved && (
        <Notice title={`Approved ${form.approved_at ? dateTime(form.approved_at) : ""}`}>This form is final. It is the record of the consultation.</Notice>
      )}
      {!approved && late.length > 0 && ["draft_ready", "under_review"].includes(consultation.status) && (
        <Notice tone="attention" title={late.length === 1 ? "A document arrived after Watson filled this in" : `${late.length} documents arrived after Watson filled this in`}
          actions={<button type="button" className="wa-button wa-button--secondary wa-button--small" disabled={busy} onClick={fillAgain}>
            <RefreshCw aria-hidden className="wa-icon wa-icon--sm" />Fill in again</button>}>
          {late.map((document) => `${document.file_name}, ${SENT_BY[document.source] ?? "sent"} on ${dateTime(document.uploaded_at)}`).join("; ")}.
          {" "}Watson can fill in the form again with {late.length === 1 ? "it" : "them"}, in about 5 minutes. Answers you have already checked stay as you left them.
        </Notice>
      )}
      {problem && <Notice tone="failed" title="That did not work">{problem}</Notice>}
      <div className="wa-review">
        <div className="wa-sheet">
          {template.sections.map((section, index) => {
            const members = section.fields.map((field) => byKey.get(field.key)).filter((answer) => answer !== undefined);
            const tucked = members.filter((answer) => isEmpty(answer) && editing !== answer.field_key);
            return (
              <section key={section.title} className="wa-sheet__section" aria-labelledby={`s-${index}`}>
                <h2 className="wa-sheet__title" id={`s-${index}`}>{section.title}</h2>
                {members.filter((answer) => !tucked.includes(answer)).map(card)}
                {tucked.length > 0 && (
                  <p className="wa-tucked">
                    Not discussed:
                    {tucked.map((answer) => approved ? (
                      <strong key={answer.field_key}>{fields.get(answer.field_key)?.label ?? answer.field_key}</strong>
                    ) : (
                      <button key={answer.field_key} type="button" className="wa-button wa-button--quiet wa-button--small"
                        aria-label={`Add an answer: ${fields.get(answer.field_key)?.label ?? answer.field_key}`}
                        disabled={busy} onClick={() => edit(answer)}>
                        {fields.get(answer.field_key)?.label ?? answer.field_key}
                      </button>
                    ))}
                  </p>
                )}
              </section>
            );
          })}
        </div>
        <aside className="wa-review__aside" aria-label="The conversation" ref={aside}>
          <h2 className="wa-heading">The conversation</h2>
          <p className="wa-hint">Lines the selected answer comes from are lit.</p>
          <ol className="wa-turns">
            {[...segments.values()].map((segment) => (
              <li key={segment.position} className={`wa-turn wa-turn--${segment.speaker}${lit.has(segment.position) ? " wa-turn--lit" : ""}`}>
                <div className="wa-turn__body">
                  <p className="wa-turn__head" style={{ margin: 0 }}>
                    <span className="wa-turn__who">{segment.speaker === "patient" ? "Patient" : "Practitioner"}</span>
                    <span className="wa-turn__time">{clock(Number(segment.start_seconds))}</span>
                  </p>
                  <p className="wa-turn__text">{segment.reviewed_text ?? segment.machine_text}</p>
                </div>
              </li>
            ))}
          </ol>
        </aside>
      </div>
      {!approved && (
        <div className="wa-approve">
          <p className="wa-meta" role="status">
            {toCheck === 0 ? "Every answer is checked." : `${toCheck} ${toCheck === 1 ? "answer" : "answers"} still to check`}
          </p>
          <button type="button" className="wa-button wa-button--primary" disabled={busy || toCheck > 0} onClick={approve}>
            Approve form
          </button>
        </div>
      )}
    </>
  );
}

type TypedDraft = { state: string; value: unknown };

function effectiveValue(answer: Answer) {
  return answer.review === "edited" ? answer.practitioner_value : answer.machine_value;
}

function valueText(field: Field, answer: Answer): string {
  if (answer.review === "rejected") return "Rejected — no current value";
  if (answer.answer_state !== "known") return ({
    unanswered: "Not answered",
    explicit_none: "Explicitly none",
    unknown: "Unknown",
    not_applicable: "Not applicable",
  } as Record<string, string>)[answer.answer_state] ?? answer.answer_state;
  const value = effectiveValue(answer);
  if (field.value_type === "single_choice") {
    return field.options?.find((option) => option.key === value)?.label ?? String(value ?? "");
  }
  if (field.value_type === "multi_choice" && Array.isArray(value)) {
    return value.map((key) => field.options?.find((option) => option.key === key)?.label ?? key).join(", ");
  }
  if (field.value_type === "boolean") return value ? "Yes / Áno" : "No / Nie";
  if (field.value_type === "repeater" && Array.isArray(value)) {
    return value.map((row) => Object.values((row as { values?: Record<string, unknown> }).values ?? {})
      .filter((item) => item !== null && item !== "").join(" · ")).filter(Boolean).join("; ");
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function TypedFormView({ loaded, template, reload, back }: {
  loaded: Loaded;
  template: Template;
  reload: () => void;
  back: ReactNode;
}) {
  const { consultation, patientName, form, answers, segments, documents, attestations, signatures, conflicts } = loaded;
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<TypedDraft>({ state: "known", value: "" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const byKey = new Map(answers.map((answer) => [answer.field_key, answer]));
  const approved = form.status === "approved";

  async function act(name: "review_typed_form_answer" | "set_form_attestation" | "approve_form", args: object) {
    setBusy(true);
    setProblem(null);
    const outcome = await call(name, args);
    setBusy(false);
    if (!outcome.ok) return setProblem(explain(outcome.error_category));
    setEditing(null);
    reload();
  }

  function begin(field: Field, answer: Answer) {
    setEditing(field.key);
    setDraft({
      state: answer.review === "rejected" || answer.answer_state === "unanswered" ? "known" : answer.answer_state,
      value: effectiveValue(answer) ?? (field.value_type === "multi_choice" || field.value_type === "repeater" ? [] : ""),
    });
  }

  async function saveSignature(field: Field, name: string, method: string, role: string) {
    setBusy(true);
    setProblem(null);
    const outcome = await call("set_form_signature", {
      p_form_id: form.id, p_field_key: field.key, p_signer_role: role,
      p_method: method, p_signed_name: name,
    });
    setBusy(false);
    if (!outcome.ok) return setProblem(explain(outcome.error_category));
    reload();
  }

  async function resolveConflict(id: string) {
    setBusy(true);
    setProblem(null);
    const outcome = await call("resolve_form_reconciliation", { p_conflict_id: id });
    setBusy(false);
    if (!outcome.ok) return setProblem(explain(outcome.error_category));
    reload();
  }

  async function rejectRevision() {
    setBusy(true);
    setProblem(null);
    const outcome = await call("reject_form_revision", { p_form_id: form.id });
    setBusy(false);
    if (!outcome.ok) return setProblem(explain(outcome.error_category));
    reload();
  }

  function fieldCard(field: Field) {
    const answer = byKey.get(field.key);
    if (!answer) return null;
    const quotes = answer.evidence.map((position) => segments.get(position)).filter(Boolean) as Segment[];
    const attestation = attestations.find((item) => item.field_key === field.key);
    const signature = signatures.find((item) => item.field_key === field.key);
    return (
      <article key={field.key} className={`wa-answer${answer.review !== "unreviewed" ? " wa-answer--settled" : ""}`}
        aria-labelledby={`typed-${field.key}`}>
        <div className="wa-answer__head">
          <h3 className="wa-answer__label" id={`typed-${field.key}`}>
            {field.label}{field.required ? <span className="wa-tag wa-tag--attention">Required</span> : null}
          </h3>
          {field.value_type !== "attestation" && field.value_type !== "signature" ? (
            <span className={`wa-chip ${CHIP[answer.review][0]}`}>{CHIP[answer.review][1]}</span>
          ) : null}
        </div>
        {field.value_type === "attestation" ? (
          <div className="wa-actions">
            <span className="wa-meta">{attestation ? `Recorded: ${attestation.decision}` : "Not confirmed"}</span>
            {!approved && ["confirmed", "declined", "not_applicable"].map((decision) => (
              <button key={decision} type="button" className="wa-button wa-button--secondary wa-button--small"
                disabled={busy || attestation?.decision === decision}
                onClick={() => void act("set_form_attestation", { p_form_id: form.id, p_field_key: field.key, p_decision: decision })}>
                {decision === "confirmed" ? "Confirm" : decision === "declined" ? "Decline" : "Not applicable"}
              </button>
            ))}
          </div>
        ) : field.value_type === "signature" ? (
          <SignatureEditor field={field} existing={signature} disabled={busy || approved}
            signerRole={template.approval_gates?.find((gate) => gate.type === "signature" && gate.field_key === field.key)?.signer_role}
            onSave={saveSignature} />
        ) : editing === field.key ? (
          <form className="wa-form" onSubmit={(event) => {
            event.preventDefault();
            void act("review_typed_form_answer", {
              p_form_id: form.id, p_field_key: field.key, p_decision: "edit",
              p_state: draft.state, p_value: draft.state === "known" ? draft.value : null,
            });
          }}>
            <div className="wa-field">
              <label className="wa-label" htmlFor={`state-${field.key}`}>Answer state</label>
              <div className="wa-select"><select id={`state-${field.key}`} value={draft.state}
                onChange={(event) => setDraft((current) => ({ ...current, state: event.target.value }))}>
                <option value="known">Known value</option><option value="explicit_none">Explicitly none</option>
                <option value="unknown">Unknown</option><option value="not_applicable">Not applicable</option>
              </select></div>
            </div>
            {draft.state === "known" ? <TypedValueInput field={field} value={draft.value}
              documents={documents} onChange={(value) => setDraft((current) => ({ ...current, value }))} /> : null}
            <div className="wa-actions">
              <button type="submit" className="wa-button wa-button--primary wa-button--small" disabled={busy}>Save</button>
              <button type="button" className="wa-button wa-button--quiet wa-button--small" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </form>
        ) : (
          <>
            <p className="wa-answer__text">{valueText(field, answer)}</p>
            {quotes.length > 0 ? <ul className="wa-quotes" aria-label="Where this comes from">{quotes.map((quote) => (
              <li key={quote.position} className={`wa-quote wa-quote--${quote.speaker}`}>
                <div><span className="wa-quote__who">{quote.speaker === "patient" ? "Patient" : "Practitioner"} · {clock(Number(quote.start_seconds))}</span>
                  <p className="wa-quote__text">{quote.reviewed_text ?? quote.machine_text}</p></div>
              </li>
            ))}</ul> : null}
            {!approved ? <div className="wa-actions">
              {answer.machine_state !== "unanswered" && answer.review === "unreviewed" ? <>
                <button type="button" className="wa-button wa-button--secondary wa-button--small" disabled={busy}
                  onClick={() => void act("review_typed_form_answer", { p_form_id: form.id, p_field_key: field.key, p_decision: "accept" })}>Accept</button>
                <button type="button" className="wa-button wa-button--quiet wa-button--small" disabled={busy}
                  onClick={() => void act("review_typed_form_answer", { p_form_id: form.id, p_field_key: field.key, p_decision: "reject" })}>Reject</button>
              </> : null}
              <button type="button" className="wa-button wa-button--secondary wa-button--small" disabled={busy} onClick={() => begin(field, answer)}>Edit</button>
              {answer.review !== "unreviewed" ? <button type="button" className="wa-button wa-button--quiet wa-button--small" disabled={busy}
                onClick={() => void act("review_typed_form_answer", { p_form_id: form.id, p_field_key: field.key, p_decision: "undo" })}>Undo</button> : null}
            </div> : null}
          </>
        )}
      </article>
    );
  }

  return <>
    {back}
    <section className="wa-hero" aria-labelledby="typed-form-title">
      <p className="wa-hero__eyebrow">{template.title}</p>
      <h1 className="wa-hero__title" id="typed-form-title">{patientName ?? consultation.synthetic_patient_ref}</h1>
      <p className="wa-hero__meta">Revision {form.revision_number} · final transcript is authoritative · live values are never copied here</p>
      <div className="wa-actions"><Link href={`/print/?id=${consultation.id}`} className="wa-button wa-button--secondary">
        <Printer aria-hidden className="wa-icon" />Bilingual print / PDF</Link></div>
    </section>
    {approved ? <Notice title="Approved and immutable">This revision is final. A correction must create another revision.</Notice> : null}
    {problem ? <Notice tone="failed" title="That did not work">{problem}</Notice> : null}
    {conflicts.some((conflict) => conflict.status === "pending") ? (
      <Notice tone="attention" title="Final transcript differs from live coverage">
        <ul className="wa-done-list">
          {conflicts.filter((conflict) => conflict.status === "pending").map((conflict) => (
            <li key={conflict.id}>
              <span>Live captions covered <strong>{conflict.field_key.replaceAll("_", " ")}</strong>, but the final transcript produced no answer.</span>
              <button type="button" className="wa-button wa-button--secondary wa-button--small" disabled={busy}
                onClick={() => void resolveConflict(conflict.id)}>Mark reviewed</button>
            </li>
          ))}
        </ul>
      </Notice>
    ) : null}
    <div className="wa-sheet">{template.sections.map((section, index) => (
      <section key={section.title} className="wa-sheet__section" aria-labelledby={`typed-section-${index}`}>
        <h2 className="wa-sheet__title" id={`typed-section-${index}`}>{section.title}</h2>
        {section.fields.map(fieldCard)}
      </section>
    ))}</div>
    {!approved ? <div className="wa-approve">
      <p className="wa-meta">Approval checks required fields, transcript answers, safety attestations and signatures.</p>
      <button type="button" className="wa-button wa-button--primary" disabled={busy}
        onClick={() => void act("approve_form", { p_form_id: form.id })}>Approve immutable revision</button>
      {form.revision_number > 1 ? <button type="button" className="wa-button wa-button--quiet" disabled={busy}
        onClick={() => void rejectRevision()}>Reject this revision</button> : null}
    </div> : null}
  </>;
}

function TypedValueInput({ field, value, onChange, documents }: {
  field: Field; value: unknown; onChange: (value: unknown) => void;
  documents: Loaded["documents"];
}) {
  const id = `value-${field.key}`;
  if (field.value_type === "single_choice") return <div className="wa-field"><label className="wa-label" htmlFor={id}>Value</label>
    <div className="wa-select"><select id={id} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>
      <option value="">Choose…</option>{field.options?.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
    </select></div></div>;
  if (field.value_type === "multi_choice") {
    const selected = Array.isArray(value) ? value as string[] : [];
    return <fieldset className="wa-form"><legend className="wa-label">Values</legend>{field.options?.map((option) => (
      <label key={option.key} className="wa-check"><input type="checkbox" checked={selected.includes(option.key)}
        onChange={(event) => onChange(event.target.checked ? [...selected, option.key] : selected.filter((key) => key !== option.key))} />
        <span className="wa-check__text"><span className="wa-check__label">{option.label}</span></span></label>
    ))}</fieldset>;
  }
  if (field.value_type === "boolean") return <div className="wa-field"><label className="wa-label" htmlFor={id}>Value</label>
    <div className="wa-select"><select id={id} value={String(value)} onChange={(event) => onChange(event.target.value === "true")}>
      <option value="true">Yes / Áno</option><option value="false">No / Nie</option></select></div></div>;
  if (field.value_type === "attachment_reference") return <div className="wa-field"><label className="wa-label" htmlFor={id}>Uploaded body chart</label>
    <div className="wa-select"><select id={id} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>
      <option value="">Choose a document…</option>{[...documents].map(([documentId, document]) => <option key={documentId} value={documentId}>{document.file_name}</option>)}
    </select></div></div>;
  if (field.value_type === "repeater") return <RepeaterInput field={field} value={value} onChange={onChange} />;
  const numeric = field.value_type === "integer" || field.value_type === "decimal";
  return <div className="wa-field"><label className="wa-label" htmlFor={id}>Value</label>
    {field.value_type === "long_text" ? <textarea id={id} className="wa-textarea" value={String(value ?? "")}
      onChange={(event) => onChange(event.target.value)} /> : <input id={id} className="wa-input"
      type={field.value_type === "date" ? "date" : numeric ? "number" : "text"}
      step={field.value_type === "decimal" ? "any" : undefined} value={String(value ?? "")}
      onChange={(event) => onChange(numeric && event.target.value !== "" ? Number(event.target.value) : event.target.value)} />}</div>;
}

function RepeaterInput({ field, value, onChange }: { field: Field; value: unknown; onChange: (value: unknown) => void }) {
  const rows = Array.isArray(value) ? value as { item_id: string; values: Record<string, unknown> }[] : [];
  const update = (index: number, key: string, next: unknown) => onChange(rows.map((row, position) => position === index
    ? { ...row, values: { ...row.values, [key]: next } } : row));
  return <div className="wa-form"><p className="wa-label">Entries</p>{rows.map((row, index) => (
    <fieldset key={row.item_id} className="wa-panel"><legend className="wa-label">Entry {index + 1}</legend>
      {field.item_fields?.map((item) => <TypedValueInput key={item.key} field={{ ...item, key: `${field.key}-${index}-${item.key}` }}
        value={row.values[item.key]} documents={new Map()} onChange={(next) => update(index, item.key, next)} />)}
      <button type="button" className="wa-button wa-button--quiet wa-button--small"
        onClick={() => onChange(rows.filter((_, position) => position !== index))}>Remove entry</button>
    </fieldset>
  ))}<button type="button" className="wa-button wa-button--secondary wa-button--small" onClick={() => onChange([
    ...rows, { item_id: crypto.randomUUID(), values: Object.fromEntries((field.item_fields ?? []).map((item) => [item.key, null])) },
  ])}>Add entry</button></div>;
}

function SignatureEditor({ field, existing, disabled, signerRole, onSave }: {
  field: Field; existing?: Tables<"form_signatures">; disabled: boolean;
  signerRole?: "patient" | "practitioner";
  onSave: (field: Field, name: string, method: string, role: string) => Promise<void>;
}) {
  const [name, setName] = useState(existing?.signed_name ?? "");
  const role = signerRole ?? (field.key.startsWith("patient") ? "patient" : "practitioner");
  return <div className="wa-form">
    {existing ? <p className="wa-meta">Signed by {existing.signed_name} · {existing.method.replaceAll("_", " ")}</p> : null}
    {!disabled ? <><div className="wa-field"><label className="wa-label" htmlFor={`signature-${field.key}`}>Signed name</label>
      <input id={`signature-${field.key}`} className="wa-input" value={name} onChange={(event) => setName(event.target.value)} /></div>
      <p className="wa-hint">Record only after the signer has signed the printed form in wet ink.</p>
      <button type="button" className="wa-button wa-button--secondary wa-button--small" disabled={!name.trim()}
        onClick={() => void onSave(field, name, "wet_ink_on_print", role)}>Record signature</button></> : null}
  </div>;
}
