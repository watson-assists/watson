"use client";

import { useState } from "react";
import { spellingsFrom, type Spelling } from "@/lib/spelling";

/**
 * A line of a transcript the practitioner can correct (owner, 24 Oct: "I am unable to correct it as we
 * speak"). The Correct button is always visible; the record keeps what Watson heard, and a few words
 * changed teach Watson their spelling for this patient.
 */
export function CorrectableLine({ text, heard, editable = true, textClassName, onSave, onRemove }: {
  text: string;
  /** What Watson heard, when it differs from the text. */
  heard: string | null;
  editable?: boolean;
  textClassName: string;
  onSave: (text: string, spellings: Spelling[]) => Promise<boolean>;
  /** Takes the line out of the conversation (owner, 23 Nov); absent where lines cannot be removed. */
  onRemove?: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  async function save() {
    const next = (draft ?? "").trim();
    if (!next || next === text) return setDraft(null);
    setSaving(true);
    setFailed(false);
    const saved = await onSave(next, spellingsFrom(text, next));
    setSaving(false);
    if (saved) setDraft(null);
    else setFailed(true);
  }

  if (draft !== null) {
    return (
      <div className="wa-correct wa-correct--editing">
        <textarea className="wa-textarea" aria-label="Correct this line" value={draft} autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void save();
            }
            if (event.key === "Escape") setDraft(null);
          }} />
        <p className="wa-correct__heard">Watson heard: &ldquo;{heard ?? text}&rdquo;</p>
        {failed && <p className="wa-error" role="alert">Not saved. Check your connection and press Save again.</p>}
        <div className="wa-actions">
          <button type="button" className="wa-button wa-button--primary" disabled={saving} aria-busy={saving || undefined}
            onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
          <button type="button" className="wa-button wa-button--secondary" disabled={saving} onClick={() => setDraft(null)}>Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <div className="wa-correct">
      <p className={textClassName}>
        {text}
        {heard !== null && heard !== text && <span className="wa-corrected">Corrected</span>}
      </p>
      {editable && (
        <div className="wa-actions">
          <button type="button" className="wa-button wa-button--secondary wa-correct__button" onClick={() => setDraft(text)}>Correct</button>
          {onRemove && <button type="button" className="wa-button wa-button--quiet wa-correct__button" onClick={onRemove}>Remove</button>}
        </div>
      )}
    </div>
  );
}
