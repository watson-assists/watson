"use client";

import { useEffect, useRef, useState } from "react";
import { call } from "@/lib/api";
import { supabase } from "@/lib/supabase";

/**
 * The doctor's own notes, during the call and after it (owner's test team, 23 Nov: "free-form notes
 * during the call … all considered for the diagnosis"). Saved as they type; Watson reads them when it
 * fills in the form; the patient never sees them. Final once the form is approved.
 */
export function DoctorNotes({ consultationId, editable, look = "panel" }: {
  consultationId: string;
  editable: boolean;
  /** "side": beside the call or the form, without a panel's frame. */
  look?: "panel" | "side";
}) {
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<"saving" | "saved" | "failed" | null>(null);
  const saved = useRef("");
  const latest = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queue = useRef(Promise.resolve()); // one save at a time, so an older one never lands last
  const id = `notes-${consultationId}`;

  useEffect(() => {
    let alive = true;
    supabase.from("doctor_notes").select("text").eq("consultation_id", consultationId).maybeSingle().then(({ data }) => {
      if (!alive) return;
      saved.current = latest.current = data?.text ?? "";
      setText(saved.current);
    });
    return () => { alive = false; };
  }, [consultationId]);

  const save = () => {
    clearTimeout(timer.current);
    queue.current = queue.current.then(async () => {
      const value = latest.current;
      if (value === saved.current) return;
      setState("saving");
      const outcome = await call("save_doctor_notes", { p_consultation_id: consultationId, p_text: value });
      if (outcome.ok) saved.current = value;
      setState(outcome.ok ? "saved" : "failed");
    });
  };
  useEffect(() => () => save(), []); // eslint-disable-line react-hooks/exhaustive-deps -- leaving the page keeps the last words

  if (text === null) return null;
  if (!editable && !text.trim()) return null;
  return (
    <section className={look === "panel" ? "wa-panel" : "wa-livetext"}>
      <h2 className="wa-heading" id={id} style={{ color: "var(--ink)" }}>Your notes</h2>
      {editable ? (
        <>
          <p className="wa-hint" id={`${id}-hint`}>Only you see these. Watson reads them when it fills in the form.</p>
          <textarea className="wa-textarea" rows={look === "side" ? 5 : 6} maxLength={20000} value={text}
            aria-labelledby={id} aria-describedby={`${id}-hint`}
            placeholder="What you notice, and what you think it is"
            onChange={(event) => {
              setText(event.target.value);
              latest.current = event.target.value;
              clearTimeout(timer.current);
              timer.current = setTimeout(save, 800);
            }}
            onBlur={save} />
          <p className="wa-meta" role="status" style={{ minHeight: 20 }}>
            {state === "saving" ? "Saving…" : state === "saved" ? "Saved" : state === "failed" ? "Not saved. Check your connection, then type again." : ""}
          </p>
        </>
      ) : (
        <p className="wa-text" style={{ whiteSpace: "pre-wrap" }}>{text}</p>
      )}
    </section>
  );
}
