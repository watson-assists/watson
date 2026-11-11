"use client";

import { LoaderCircle, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { EngineLine } from "@/components/engine-status";
import { Notice } from "@/components/status";
import { engineStatus, type Engine } from "@/lib/engine";
import { call, explain } from "@/lib/api";
import { clock } from "@/lib/audio";
import type { Tables } from "@/lib/database.types";
import { dateTime, type ConsultationStatus } from "@/lib/status";
import { supabase } from "@/lib/supabase";

type Read = {
  job: Tables<"form_jobs"> | null;
  form: Pick<Tables<"forms">, "id" | "status" | "approved_at" | "template" |
    "form_template_version_id" | "revision_number" | "revision_kind"> | null;
  answered: number;
  total: number;
  engine: Engine | null;
};

const FAILURE: Record<string, string> = {
  FORM_MODEL_UNAVAILABLE: "The engine's form model is missing. Try again once it is installed on the engine's computer.",
  FORM_TIMEOUT: "Filling in the form took too long. Try again.",
  ENGINE_STALLED: "The engine stopped three times. The computer running it may have gone to sleep. Try again.",
};

/** The doctor's form: being filled in, failed, ready to check, or approved. */
export function FormPanel({ consultationId, status, onChanged }: {
  consultationId: string;
  status: ConsultationStatus;
  onChanged: () => void;
}) {
  const [seen, setSeen] = useState<Read | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [versions, setVersions] = useState<Pick<Tables<"form_template_versions">,
    "id" | "template_key" | "version_number" | "definition">[]>([]);
  const [revisionTemplate, setRevisionTemplate] = useState("");

  const read = useCallback(async (): Promise<Read> => {
    const [job, form, engine] = await Promise.all([
      supabase.from("form_jobs").select("*").eq("consultation_id", consultationId)
        .order("queued_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("forms").select("id, status, approved_at, template, form_template_version_id, revision_number, revision_kind")
        .eq("consultation_id", consultationId).neq("status", "superseded")
        .order("revision_number", { ascending: false }).limit(1).maybeSingle(),
      engineStatus(),
    ]);
    const answers = form.data
      ? (await supabase.from("form_answers").select("machine_text").eq("form_id", form.data.id)).data ?? []
      : [];
    return {
      job: job.data, form: form.data, engine,
      answered: answers.filter((answer) => answer.machine_text !== null).length, total: answers.length,
    };
  }, [consultationId]);

  useEffect(() => {
    let alive = true;
    supabase.from("form_template_versions")
      .select("id, template_key, version_number, definition")
      .order("template_key").order("version_number", { ascending: false })
      .then(({ data }) => {
        if (!alive) return;
        setVersions(data ?? []);
      });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    const show = (result: Read) => {
      if (!alive) return;
      setSeen(result);
      setNow(Date.now());
      if (status === "extraction_processing" && result.job && !["queued", "processing"].includes(result.job.status)) onChanged();
    };
    read().then(show);
    if (status !== "extraction_processing") return;
    const poll = setInterval(() => read().then(show), 3000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [status, read, onChanged]);

  async function retry() {
    setBusy(true);
    setProblem(null);
    const outcome = await call("start_form", { p_consultation_id: consultationId });
    setBusy(false);
    if (!outcome.ok) setProblem(explain(outcome.error_category));
    onChanged();
  }

  // No form of their own yet (owner, 24 Oct): Watson's, then fill it in. Their own form, if they set one, stays.
  async function fillWatsonForm() {
    setBusy(true);
    setProblem(null);
    const chosen = await call("use_watson_form", {});
    if (!chosen.ok) {
      setBusy(false);
      return setProblem(explain(chosen.error_category));
    }
    await retry();
  }

  async function createRevision() {
    if (!form?.form_template_version_id) return;
    const chosen = revisionTemplate || form.form_template_version_id;
    setBusy(true);
    setProblem(null);
    const outcome = await call("queue_form_revision", {
      p_consultation_id: consultationId,
      p_form_template_version_id: chosen,
      p_revision_kind: chosen === form.form_template_version_id ? "correction" : "historical_conversion",
    });
    setBusy(false);
    if (!outcome.ok) return setProblem(explain(outcome.error_category));
    onChanged();
  }

  if (seen === null) return <p className="wa-meta" role="status">Loading the form…</p>;
  const { job, form, engine } = seen;
  const title = (form?.template as { title?: string } | null)?.title;

  if (status === "transcript_ready" || status === "transcript_reviewed") {
    return (
      <section className="wa-panel" aria-labelledby="form-title">
        <h2 className="wa-heading" id="form-title">Form</h2>
        <p className="wa-text">Your form is not set up yet, so Watson has nothing to fill in. Watson can use its own consultation form: it fills it in from this call now, and from every call after.</p>
        <div className="wa-actions">
          <button type="button" className="wa-button wa-button--primary" disabled={busy} onClick={fillWatsonForm}>Fill in the form</button>
        </div>
        {problem && <p className="wa-error" role="alert">{problem}</p>}
      </section>
    );
  }

  if (status === "extraction_failed") {
    return (
      <>
        <Notice tone="failed" title="The form could not be filled in" actions={
          <button type="button" className="wa-button wa-button--primary" disabled={busy} onClick={retry}>
            <RotateCcw aria-hidden className="wa-icon" />Try again
          </button>
        }>
          {FAILURE[job?.error_category ?? ""] ?? "Try again. The transcript is safe."}
        </Notice>
        {problem && <p className="wa-error" role="alert">{problem}</p>}
      </>
    );
  }

  if (status === "extraction_processing") {
    return (
      <section className="wa-panel" aria-labelledby="form-title">
        <div className="wa-job__head">
          <h2 className="wa-heading" id="form-title">Filling in your form</h2>
          {job && <span className="wa-job__clock">{clock((now - Date.parse(job.queued_at)) / 1000)} so far</span>}
        </div>
        <div className="wa-bar" role="presentation" />
        <p className="wa-text">
          <LoaderCircle aria-hidden className="wa-icon wa-icon--sm wa-spin" />{" "}
          {job?.status === "processing" ? "Watson is reading the conversation and writing each answer with its quote." : "Waiting for the engine."}
        </p>
        <EngineLine engine={engine} now={now} waiting="The form is in line and is filled in as soon as the laptop is back." />
        <p className="wa-hint">This takes a few minutes. You can leave this page.</p>
      </section>
    );
  }

  if (!form) return null;
  const approved = form.status === "approved";
  return (
    <section className="wa-panel" aria-labelledby="form-title">
      <div className="wa-panel__head">
        <div style={{ display: "grid", gap: 4 }}>
          <h2 className="wa-heading" id="form-title">Form</h2>
          <ul className="wa-facts">
            {title && <li>{title}</li>}
            <li>{seen.answered} of {seen.total} answered</li>
            {job?.finished_at && job.claimed_at && <li>Filled in in {clock((Date.parse(job.finished_at) - Date.parse(job.claimed_at)) / 1000)}</li>}
          </ul>
        </div>
        <Link href={`/form/?id=${consultationId}`} className={`wa-button ${approved ? "wa-button--secondary" : "wa-button--primary"}`}>
          {approved ? "View the form" : "Check the form"}
        </Link>
      </div>
      <p className="wa-text">
        {approved ? `Approved ${form.approved_at ? dateTime(form.approved_at) : ""}.`
          : "Watson filled in your form from the conversation. Each answer shows the words it came from."}
      </p>
      {approved && (
        <div className="wa-form" style={{ marginTop: 16 }}>
          <p className="wa-hint">Create an append-only correction, or convert the retained final transcript to another immutable form. This approved revision stays unchanged.</p>
          <div className="wa-fields-row" style={{ alignItems: "end" }}>
            <div className="wa-field">
              <label className="wa-label" htmlFor={`revision-template-${consultationId}`}>Revision form</label>
              <div className="wa-select"><select id={`revision-template-${consultationId}`}
                value={revisionTemplate || form.form_template_version_id || ""}
                onChange={(event) => setRevisionTemplate(event.target.value)}>
                {versions.map((version) => <option key={version.id} value={version.id}>
                  {(version.definition as { title?: string }).title ?? version.template_key} · v{version.version_number}
                </option>)}
              </select></div>
            </div>
            <button type="button" className="wa-button wa-button--secondary"
              disabled={busy || versions.length === 0 || !form.form_template_version_id}
              onClick={() => void createRevision()}>
              {revisionTemplate && revisionTemplate !== form.form_template_version_id ? "Convert transcript" : "Create correction"}
            </button>
          </div>
        </div>
      )}
      {problem && <p className="wa-error" role="alert">{problem}</p>}
    </section>
  );
}
