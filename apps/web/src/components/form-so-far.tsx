"use client";

import { ClipboardList, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { call, explain } from "@/lib/api";
import { asClock } from "@/lib/dates";
import type { FormTemplate } from "@/lib/export";
import { supabase } from "@/lib/supabase";

type Fill = { status: string; finished_at: string | null; preview: { key: string; text: string }[] | null };

/**
 * "Fill in the form now", during the call (owner's test team, 23 Nov: "the form filled alongside the
 * conversation"): what Watson has from the call so far, and what is still to ask. Only a preview; the
 * form itself is filled from the full transcript when the call ends.
 */
export function FormSoFar({ consultationId, templateVersionId }: { consultationId: string; templateVersionId: string | null }) {
  const [template, setTemplate] = useState<FormTemplate | null>(null);
  const [fill, setFill] = useState<Fill | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const read = useCallback(async () => (await supabase.from("form_jobs").select("status, finished_at, preview")
    .eq("consultation_id", consultationId).eq("revision_kind", "during_call")
    .order("queued_at", { ascending: false }).limit(1).maybeSingle()).data as Fill | null, [consultationId]);

  useEffect(() => {
    if (!templateVersionId) return;
    let alive = true;
    supabase.from("form_template_versions").select("definition").eq("id", templateVersionId).maybeSingle()
      .then(({ data }) => alive && setTemplate((data?.definition as unknown as FormTemplate | undefined) ?? null));
    read().then((latest) => alive && setFill(latest));
    return () => { alive = false; };
  }, [templateVersionId, read]);

  const working = fill?.status === "queued" || fill?.status === "processing";
  useEffect(() => {
    if (!working) return;
    const poll = setInterval(() => void read().then(setFill), 3000);
    return () => clearInterval(poll);
  }, [working, read]);

  if (!template) return null;
  async function start() {
    setBusy(true);
    setProblem(null);
    const outcome = await call("fill_form_during_call", { p_consultation_id: consultationId });
    setBusy(false);
    if (!outcome.ok) {
      return setProblem(outcome.error_category === "NOTHING_TO_FILL"
        ? "Nothing to go on yet. Let the patient speak first, or write a note."
        : explain(outcome.error_category));
    }
    setFill(await read());
  }

  const answers = new Map((fill?.status === "completed" ? fill.preview ?? [] : []).map((answer) => [answer.key, answer.text]));
  const sections = template.sections.map((section) => ({
    title: section.title,
    fields: section.fields.filter((field) => field.mode !== "manual" && field.value_type !== "signature" && field.value_type !== "attestation"),
  })).filter((section) => section.fields.length > 0);
  const done = fill?.status === "completed";
  return (
    <section className="wa-livetext" aria-labelledby="so-far-title">
      <h2 className="wa-heading" id="so-far-title" style={{ color: "var(--ink)" }}>The form so far</h2>
      {working ? (
        <p className="wa-hint" role="status"><LoaderCircle aria-hidden className="wa-icon wa-icon--sm wa-spin" /> Watson is filling it in from the call so far. This takes about three minutes; keep talking.</p>
      ) : (
        <>
          <p className="wa-hint">
            {done && fill.finished_at ? `Filled in at ${asClock(new Date(fill.finished_at))} from what was said until then. `
              : fill?.status === "failed" ? "Watson could not fill it in that time. "
              : "See what Watson has so far, and what is still to ask. "}
            The full form follows when you end the call.
          </p>
          <div className="wa-actions">
            <button type="button" className="wa-button wa-button--secondary" disabled={busy} aria-busy={busy || undefined} onClick={() => void start()}>
              <ClipboardList aria-hidden className="wa-icon" />{done ? "Fill in again" : "Fill in the form now"}
            </button>
          </div>
        </>
      )}
      {problem && <p className="wa-error" role="alert">{problem}</p>}
      {done && (
        <>
          <h3 className="wa-label">Still to ask</h3>
          <ul className="wa-sofar">
            {sections.map((section) => {
              const open = section.fields.filter((field) => !answers.has(field.key));
              return open.length > 0 && <li key={section.title}><strong>{section.title}:</strong> {open.map((field) => field.label).join(", ")}</li>;
            })}
          </ul>
          {answers.size > 0 && (
            <details>
              <summary className="wa-label">Answered ({answers.size})</summary>
              <dl className="wa-printed__answers">
                {sections.flatMap((section) => section.fields).filter((field) => answers.has(field.key)).map((field) => (
                  <div key={field.key}><dt>{field.label}</dt><dd>{answers.get(field.key)}</dd></div>
                ))}
              </dl>
            </details>
          )}
        </>
      )}
    </section>
  );
}
