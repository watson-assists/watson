"use client";

import { Check, Pencil, X } from "lucide-react";
import { AnswerQuotes } from "@/components/answer-quotes";
import type { Viewable } from "@/lib/documents";
import { CHIP, documentQuotes, type Answer, type Field, type Segment } from "@/lib/form-page";

export type Decision = "accept" | "reject" | "edit" | "undo";
/** How the answer stands: empty (not discussed), the doctor's own field, made from a recording, and so on. */
export type CardState = { empty: boolean; own: boolean; recorded: boolean; approved: boolean; active: boolean; busy: boolean; bmi: string | null };
/** The answer being written: its draft, and how to leave it. */
export type Editing = { draft: string; setDraft: (text: string) => void; cancel: () => void };

/** One answer on the form: what Watson wrote or the doctor wrote, where it comes from, and the doctor's check. */
export function AnswerCard({ answer, field, state, lines, documents, editing, onActivate, onDecide, onEdit, onOpen }: {
  answer: Answer; field?: Field; state: CardState; lines: Segment[]; documents: Map<string, Viewable>; editing: Editing | null;
  onActivate: () => void; onDecide: (decision: Decision, text?: string) => void; onEdit: () => void; onOpen: (document: Viewable) => void;
}) {
  const { empty, own, approved, busy } = state;
  const text = answer.review === "edited" ? answer.practitioner_text : answer.machine_text;
  const settled = answer.review !== "unreviewed";
  const modifier = empty ? " wa-answer--empty" : answer.review === "rejected" ? " wa-answer--rejected wa-answer--settled" : settled ? " wa-answer--settled" : "";
  return (
    <article className={`wa-answer${modifier}${state.active ? " wa-answer--active" : ""}`}
      aria-labelledby={`f-${answer.field_key}`} onClick={onActivate} onFocus={onActivate}>
      <AnswerHead answer={answer} field={field} state={state} />
      {editing ? <AnswerEditor answer={answer} editing={editing} busy={busy} onSave={(text) => onDecide("edit", text)} />
        : <AnswerText answer={answer} text={text} state={state} />}
      {field?.mode === "suggest" && !empty && answer.review === "unreviewed" && (
        <p className="wa-hint">Watson&apos;s reading of the conversation, not a diagnosis. Accept it only if it is your assessment.</p>
      )}
      <AnswerQuotes lines={lines} quotes={documentQuotes(answer)} documents={documents} onOpen={onOpen} />
      {!approved && !editing && <CardActions own={own} settled={settled} written={Boolean(text)} busy={busy} onDecide={onDecide} onEdit={onEdit} />}
    </article>
  );
}

/** What the doctor can do with an answer: write their own field; or accept, edit, reject, and change their mind. */
function CardActions({ own, settled, written, busy, onDecide, onEdit }: {
  own: boolean; settled: boolean; written: boolean; busy: boolean; onDecide: (decision: Decision) => void; onEdit: () => void;
}) {
  if (own) {
    return (
      <div className="wa-actions">
        <button type="button" className="wa-button wa-button--secondary" disabled={busy} onClick={onEdit}>
          <Pencil aria-hidden className="wa-icon wa-icon--sm" />{written ? "Edit" : "Write"}
        </button>
      </div>
    );
  }
  return (
    <div className="wa-actions">
      {settled ? (
        <button type="button" className="wa-button wa-button--quiet wa-button--small" disabled={busy} onClick={() => onDecide("undo")}>Change</button>
      ) : (
        <>
          <button type="button" className="wa-button wa-button--secondary wa-button--small" disabled={busy}
            onClick={() => onDecide("accept")}><Check aria-hidden className="wa-icon wa-icon--sm" />Accept</button>
          <button type="button" className="wa-button wa-button--secondary wa-button--small" disabled={busy}
            onClick={onEdit}><Pencil aria-hidden className="wa-icon wa-icon--sm" />Edit</button>
          <button type="button" className="wa-button wa-button--quiet wa-button--small" disabled={busy}
            onClick={() => onDecide("reject")}>Reject</button>
        </>
      )}
    </div>
  );
}

/** The question, whether it is Watson's suggestion, and how far the check got. */
function AnswerHead({ answer, field, state }: { answer: Answer; field?: Field; state: CardState }) {
  const [chipClass, chipText] = state.own ? ["wa-chip--done", "Only for you"]
    : state.empty ? ["wa-chip--done", state.recorded ? "Not discussed" : "Empty"] : CHIP[answer.review];
  return (
    <div className="wa-answer__head">
      <h3 className="wa-answer__label" id={`f-${answer.field_key}`}>
        {field?.label ?? answer.field_key}{field?.mode === "suggest" && <> <span className="wa-tag wa-tag--attention">Suggestion</span></>}
      </h3>
      <span className={`wa-chip ${chipClass}`}>
        {answer.review === "accepted" && <Check aria-hidden className="wa-icon wa-icon--sm" />}
        {answer.review === "edited" && <Pencil aria-hidden className="wa-icon wa-icon--sm" />}
        {answer.review === "rejected" && <X aria-hidden className="wa-icon wa-icon--sm" />}
        {chipText}
      </span>
    </div>
  );
}

/** The answer as it stands, with the doctor's-own and BMI notes. */
function AnswerText({ answer, text, state }: { answer: Answer; text: string | null; state: CardState }) {
  const { empty, own, recorded, bmi } = state;
  return (
    <>
      {(!own || text) && <p className="wa-answer__text">{empty ? (recorded ? "Not discussed in the conversation." : "Not written yet.") : text}</p>}
      {own && <p className="wa-hint">Only you see this. Watson does not fill it in, and it is never shared.</p>}
      {answer.field_key === "weight" && bmi && <p className="wa-hint">BMI {bmi}, worked out from height and weight</p>}
    </>
  );
}

/** The doctor's own wording of an answer. */
function AnswerEditor({ answer, editing, busy, onSave }: { answer: Answer; editing: Editing; busy: boolean; onSave: (text: string) => void }) {
  return (
    <form className="wa-field" onSubmit={(event) => { event.preventDefault(); onSave(editing.draft); }}>
      <label className="wa-label" htmlFor={`e-${answer.field_key}`}>Your answer</label>
      <textarea id={`e-${answer.field_key}`} className="wa-input wa-textarea" value={editing.draft} maxLength={4000}
        onChange={(event) => editing.setDraft(event.target.value)} autoFocus />
      <div className="wa-actions">
        <button type="submit" className="wa-button wa-button--secondary wa-button--small" disabled={busy || !editing.draft.trim()}>Save</button>
        <button type="button" className="wa-button wa-button--quiet wa-button--small" onClick={editing.cancel}>Cancel</button>
      </div>
    </form>
  );
}
