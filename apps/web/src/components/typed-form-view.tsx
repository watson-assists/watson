"use client";

import { Printer } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { AnswerQuotes } from "@/components/answer-quotes";
import { Notice } from "@/components/status";
import type { Tables } from "@/lib/database.types";
import { CHIP, type Answer, type Field, type Loaded, type Segment, type Template } from "@/lib/form-page";
import { useAction } from "@/lib/use-action";

// A typed form (schema v2: values with states, attestations and signatures), reviewed and approved.

type TypedDraft = { state: string; value: unknown };
type Act = (name: "review_typed_form_answer" | "set_form_attestation" | "approve_form" | "set_form_signature"
  | "resolve_form_reconciliation" | "reject_form_revision", args: object) => Promise<boolean>;

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

export function TypedFormView({ loaded, template, reload, back }: {
  loaded: Loaded;
  template: Template;
  reload: () => void;
  back: ReactNode;
}) {
  const { consultation, patientName, form, answers, conflicts } = loaded;
  const [editing, setEditing] = useState<string | null>(null);
  const { busy, problem, run } = useAction();
  const byKey = new Map(answers.map((answer) => [answer.field_key, answer]));
  const approved = form.status === "approved";
  const act: Act = async (name, args) => {
    if (!(await run(name, args))) return false;
    setEditing(null);
    reload();
    return true;
  };
  const pending = conflicts.filter((conflict) => conflict.status === "pending");

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
    {pending.length > 0 ? (
      <Notice tone="attention" title="Final transcript differs from live coverage">
        <ul className="wa-done-list">
          {pending.map((conflict) => (
            <li key={conflict.id}>
              <span>Live captions covered <strong>{conflict.field_key.replaceAll("_", " ")}</strong>, but the final transcript produced no answer.</span>
              <button type="button" className="wa-button wa-button--secondary wa-button--small" disabled={busy}
                onClick={() => void act("resolve_form_reconciliation", { p_conflict_id: conflict.id })}>Mark reviewed</button>
            </li>
          ))}
        </ul>
      </Notice>
    ) : null}
    <div className="wa-sheet">{template.sections.map((section, index) => (
      <section key={section.title} className="wa-sheet__section" aria-labelledby={`typed-section-${index}`}>
        <h2 className="wa-sheet__title" id={`typed-section-${index}`}>{section.title}</h2>
        {section.fields.map((field) => {
          const answer = byKey.get(field.key);
          return answer ? <TypedFieldCard key={field.key} field={field} answer={answer} loaded={loaded} template={template}
            editing={editing === field.key} busy={busy} onEditing={setEditing} act={act} /> : null;
        })}
      </section>
    ))}</div>
    {!approved ? <div className="wa-approve">
      <p className="wa-meta">Approval checks required fields, transcript answers, safety attestations and signatures.</p>
      <button type="button" className="wa-button wa-button--primary" disabled={busy}
        onClick={() => void act("approve_form", { p_form_id: form.id })}>Approve immutable revision</button>
      {form.revision_number > 1 ? <button type="button" className="wa-button wa-button--quiet" disabled={busy}
        onClick={() => void act("reject_form_revision", { p_form_id: form.id })}>Reject this revision</button> : null}
    </div> : null}
  </>;
}

/** One typed answer: an attestation, a signature, or a value with its state, quotes and review. */
function TypedFieldCard({ field, answer, loaded, template, editing, busy, onEditing, act }: {
  field: Field; answer: Answer; loaded: Loaded; template: Template; editing: boolean; busy: boolean;
  onEditing: (key: string | null) => void; act: Act;
}) {
  const { form, segments, attestations, signatures } = loaded;
  const [draft, setDraft] = useState<TypedDraft>({ state: "known", value: "" });
  const approved = form.status === "approved";
  const lines = answer.evidence.map((position) => segments.get(position)).filter(Boolean) as Segment[];
  const attestation = attestations.find((item) => item.field_key === field.key);
  const signature = signatures.find((item) => item.field_key === field.key);
  const review = (decision: string) => void act("review_typed_form_answer", { p_form_id: form.id, p_field_key: field.key, p_decision: decision });
  const begin = () => {
    onEditing(field.key);
    setDraft({
      state: answer.review === "rejected" || answer.answer_state === "unanswered" ? "known" : answer.answer_state,
      value: effectiveValue(answer) ?? (field.value_type === "multi_choice" || field.value_type === "repeater" ? [] : ""),
    });
  };
  return (
    <article className={`wa-answer${answer.review !== "unreviewed" ? " wa-answer--settled" : ""}`} aria-labelledby={`typed-${field.key}`}>
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
          onSave={(name, method, role) => act("set_form_signature", {
            p_form_id: form.id, p_field_key: field.key, p_signer_role: role, p_method: method, p_signed_name: name,
          })} />
      ) : editing ? (
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
            documents={loaded.documents} onChange={(value) => setDraft((current) => ({ ...current, value }))} /> : null}
          <div className="wa-actions">
            <button type="submit" className="wa-button wa-button--primary wa-button--small" disabled={busy}>Save</button>
            <button type="button" className="wa-button wa-button--quiet wa-button--small" onClick={() => onEditing(null)}>Cancel</button>
          </div>
        </form>
      ) : (
        <>
          <p className="wa-answer__text">{valueText(field, answer)}</p>
          <AnswerQuotes lines={lines} />
          {!approved ? <div className="wa-actions">
            {answer.machine_state !== "unanswered" && answer.review === "unreviewed" ? <>
              <button type="button" className="wa-button wa-button--secondary wa-button--small" disabled={busy} onClick={() => review("accept")}>Accept</button>
              <button type="button" className="wa-button wa-button--quiet wa-button--small" disabled={busy} onClick={() => review("reject")}>Reject</button>
            </> : null}
            <button type="button" className="wa-button wa-button--secondary wa-button--small" disabled={busy} onClick={begin}>Edit</button>
            {answer.review !== "unreviewed" ? <button type="button" className="wa-button wa-button--quiet wa-button--small" disabled={busy}
              onClick={() => review("undo")}>Undo</button> : null}
          </div> : null}
        </>
      )}
    </article>
  );
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
  onSave: (name: string, method: string, role: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(existing?.signed_name ?? "");
  const role = signerRole ?? (field.key.startsWith("patient") ? "patient" : "practitioner");
  return <div className="wa-form">
    {existing ? <p className="wa-meta">Signed by {existing.signed_name} · {existing.method.replaceAll("_", " ")}</p> : null}
    {!disabled ? <><div className="wa-field"><label className="wa-label" htmlFor={`signature-${field.key}`}>Signed name</label>
      <input id={`signature-${field.key}`} className="wa-input" value={name} onChange={(event) => setName(event.target.value)} /></div>
      <p className="wa-hint">Record only after the signer has signed the printed form in wet ink.</p>
      <button type="button" className="wa-button wa-button--secondary wa-button--small" disabled={!name.trim()}
        onClick={() => void onSave(name, "wet_ink_on_print", role)}>Record signature</button></> : null}
  </div>;
}
