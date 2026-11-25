"use client";

import { LoaderCircle, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { EngineLine } from "@/components/engine-status";
import { Notice } from "@/components/status";
import { engineStatus, type Engine } from "@/lib/engine";
import { clock } from "@/lib/audio";
import type { Tables } from "@/lib/database.types";
import { dateTime, type ConsultationStatus } from "@/lib/status";
import { supabase } from "@/lib/supabase";
import { useAction } from "@/lib/use-action";

type Form = Pick<Tables<"forms">, "id" | "status" | "approved_at" | "template" | "form_template_version_id" | "revision_number" | "revision_kind">;
type Read = { job: Tables<"form_jobs"> | null; form: Form | null; answered: number; total: number; engine: Engine | null };
type Action = ReturnType<typeof useAction>;

const FAILURE: Record<string, string> = {
  FORM_MODEL_UNAVAILABLE: "The engine's form model is missing. Try again once it is installed on the engine's computer.",
  FORM_TIMEOUT: "Filling in the form took too long. Try again.",
  ENGINE_STALLED: "The engine stopped three times. The computer running it may have gone to sleep. Try again.",
};

async function readForm(consultationId: string): Promise<Read> {
  const [job, form, engine] = await Promise.all([
    supabase.from("form_jobs").select("*").eq("consultation_id", consultationId).neq("revision_kind", "during_call")
      .order("queued_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("forms").select("id, status, approved_at, template, form_template_version_id, revision_number, revision_kind")
      .eq("consultation_id", consultationId).neq("status", "superseded")
      .order("revision_number", { ascending: false }).limit(1).maybeSingle(),
    engineStatus(),
  ]);
  const answers = form.data ? (await supabase.from("form_answers").select("machine_text").eq("form_id", form.data.id)).data ?? [] : [];
  return { job: job.data, form: form.data, engine, answered: answers.filter((answer) => answer.machine_text !== null).length, total: answers.length };
}

/** The doctor's form: being filled in, failed, ready to check, or approved. */
export function FormPanel({ consultationId, status, onChanged }: {
  consultationId: string;
  status: ConsultationStatus;
  onChanged: () => void;
}) {
  const [seen, setSeen] = useState<Read | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const action = useAction();
  const read = useCallback(() => readForm(consultationId), [consultationId]);

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

  // A form filled from the notes, without a recording (owner's test team, 23 Nov), is tried again the same way.
  const retry = async () => {
    await (seen?.job && seen.job.transcript_id === null
      ? action.run("start_form_without_recording", { p_consultation_id: consultationId, p_by_watson: true })
      : action.run("start_form", { p_consultation_id: consultationId }));
    onChanged();
  };
  // No form of their own yet (owner, 24 Oct): Watson's, then fill it in. Their own form, if they set one, stays.
  const fillWatsonForm = async () => { if (await action.run("use_watson_form")) await retry(); };

  if (seen === null) return <p className="wa-meta" role="status">Loading the form…</p>;
  if (status === "transcript_ready" || status === "transcript_reviewed") return <NoFormYet action={action} onFill={() => void fillWatsonForm()} />;
  if (status === "extraction_failed") return <FormFailed job={seen.job} action={action} onRetry={() => void retry()} />;
  if (status === "extraction_processing") return <FormFilling seen={seen} now={now} />;
  return seen.form ? <FormReady consultationId={consultationId} seen={seen} form={seen.form} action={action} onChanged={onChanged} /> : null;
}

function NoFormYet({ action, onFill }: { action: Action; onFill: () => void }) {
  return (
    <section className="wa-panel" aria-labelledby="form-title">
      <h2 className="wa-heading" id="form-title">Form</h2>
      <p className="wa-text">Your form is not set up yet, so Watson has nothing to fill in. Watson can use its own consultation form: it fills it in from this call now, and from every call after.</p>
      <div className="wa-actions">
        <button type="button" className="wa-button wa-button--primary" disabled={action.busy} onClick={onFill}>Fill in the form</button>
      </div>
      {action.problem && <p className="wa-error" role="alert">{action.problem}</p>}
    </section>
  );
}

function FormFailed({ job, action, onRetry }: { job: Read["job"]; action: Action; onRetry: () => void }) {
  return (
    <>
      <Notice tone="failed" title="The form could not be filled in" actions={
        <button type="button" className="wa-button wa-button--primary" disabled={action.busy} onClick={onRetry}>
          <RotateCcw aria-hidden className="wa-icon" />Try again
        </button>
      }>
        {FAILURE[job?.error_category ?? ""] ?? "Try again. The transcript is safe."}
      </Notice>
      {action.problem && <p className="wa-error" role="alert">{action.problem}</p>}
    </>
  );
}

function FormFilling({ seen: { job, engine }, now }: { seen: Read; now: number }) {
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

function FormReady({ consultationId, seen: { job, answered, total }, form, action, onChanged }: {
  consultationId: string; seen: Read; form: Form; action: Action; onChanged: () => void;
}) {
  const approved = form.status === "approved";
  const title = (form.template as { title?: string } | null)?.title;
  return (
    <section className="wa-panel" aria-labelledby="form-title">
      <div className="wa-panel__head">
        <div style={{ display: "grid", gap: 4 }}>
          <h2 className="wa-heading" id="form-title">Form</h2>
          <ul className="wa-facts">
            {title && <li>{title}</li>}
            <li>{answered} of {total} answered</li>
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
      {approved && <FillAgain consultationId={consultationId} form={form} action={action} onChanged={onChanged} />}
      {action.problem && <p className="wa-error" role="alert">{action.problem}</p>}
    </section>
  );
}

/** Watson fills in the approved form again from the conversation, or another of the doctor's forms: a new version. */
function FillAgain({ consultationId, form, action, onChanged }: { consultationId: string; form: Form; action: Action; onChanged: () => void }) {
  const [versions, setVersions] = useState<Pick<Tables<"form_template_versions">, "id" | "template_key" | "version_number" | "definition">[]>([]);
  const [chosen, setChosen] = useState("");
  useEffect(() => {
    let alive = true;
    supabase.from("form_template_versions").select("id, template_key, version_number, definition")
      .order("template_key").order("version_number", { ascending: false })
      .then(({ data }) => alive && setVersions(data ?? []));
    return () => { alive = false; };
  }, []);
  const same = !chosen || chosen === form.form_template_version_id;
  async function fill() {
    if (!form.form_template_version_id) return;
    const outcome = await action.run("queue_form_revision", { p_consultation_id: consultationId,
      p_form_template_version_id: chosen || form.form_template_version_id, p_revision_kind: same ? "correction" : "historical_conversion" });
    if (outcome) onChanged();
  }
  return (
    <div className="wa-form" style={{ marginTop: 16 }}>
      <p className="wa-hint">Watson can fill in this form again from the conversation, or fill in another of your forms from it. The approved form stays as it is; Watson&rsquo;s new one is a new version for you to check.</p>
      <div className="wa-fields-row" style={{ alignItems: "end" }}>
        <div className="wa-field">
          <label className="wa-label" htmlFor={`revision-template-${consultationId}`}>Form to fill in</label>
          <div className="wa-select"><select id={`revision-template-${consultationId}`} value={chosen || form.form_template_version_id || ""}
            onChange={(event) => setChosen(event.target.value)}>
            {versions.map((version) => <option key={version.id} value={version.id}>
              {(version.definition as { title?: string }).title ?? version.template_key} · v{version.version_number}
            </option>)}
          </select></div>
        </div>
        <button type="button" className="wa-button wa-button--secondary" disabled={action.busy || versions.length === 0 || !form.form_template_version_id}
          onClick={() => void fill()}>
          {same ? "Fill in again" : "Fill in this form"}
        </button>
      </div>
    </div>
  );
}
