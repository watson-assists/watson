"use client";

import { Archive, ChevronLeft, ClipboardList, Pencil, PenLine, Video } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import { AppShell } from "@/components/app-shell";
import { DoctorNotes } from "@/components/doctor-notes";
import { DocumentsPanel } from "@/components/documents-panel";
import { WhatsAppPanel } from "@/components/whatsapp-panel";
import { FormPanel } from "@/components/form-panel";
import { JobPanel } from "@/components/job-panel";
import { PatientCheck, type Candidate } from "@/components/patient-check";
import { PatientPanel } from "@/components/patient-panel";
import { euros } from "@/lib/fee";
import { FieldError, Journey, Notice, StatusChip } from "@/components/status";
import { TranscriptView } from "@/components/transcript-view";
import { call, explain, isId } from "@/lib/api";
import { clock, humanSize } from "@/lib/audio";
import type { Tables } from "@/lib/database.types";
import { RequireSession } from "@/lib/session";
import { dateTime, dayMonth, LANGUAGE_LABEL, summarise, WITHDRAWABLE } from "@/lib/status";
import { shownPatient, type Shown } from "@/lib/patient";
import { earlierPatients } from "@/lib/records";
import { supabase } from "@/lib/supabase";
import { answerText, type FormAnswer, type FormTemplate } from "@/lib/export";

type Consultation = Tables<"consultations">;
type Track = Tables<"audio_tracks">;
type Patient = Pick<Tables<"patients">, "id" | "name" | "phone" | "email">;
type History = Pick<Consultation, "id" | "scheduled_at" | "language" | "status" | "patient_association_state">;
type PreviousContext = { scheduledAt: string; template: FormTemplate; answers: FormAnswer[] };
type Loaded = {
  consultation: Consultation; tracks: Track[]; audioLeft: boolean; hasTranscript: boolean; patient: Patient | null;
  shown: Shown | null; candidate: Candidate | null; history: History[] | "failed" | null;
  previousContext: PreviousContext | null;
};
const SPEAKERS = ["practitioner", "patient"] as const;
const FORM_STATUSES = ["transcript_ready", "transcript_reviewed", "extraction_processing", "extraction_failed",
  "draft_ready", "under_review", "approved"];
const HAS_TRANSCRIPT = ["transcript_ready", "transcript_under_review", "transcript_reviewed", "extraction_processing",
  "extraction_failed", "draft_ready", "under_review", "approved", "corrected", "archived"];

export default function ConsultationPage() {
  return (
    <RequireSession>
      {(user) => (
        <AppShell user={user}>
          <Suspense fallback={<p className="wa-meta" role="status">Loading the consultation…</p>}>
            <ConsultationView userId={user.id} />
          </Suspense>
        </AppShell>
      )}
    </RequireSession>
  );
}

const back = (
  <Link href="/consultations/" className="wa-crumb"><ChevronLeft aria-hidden className="wa-icon wa-icon--sm" />Consultations</Link>
);

/** What each of the four steps says under its bar. */
function stepLines({ consultation, tracks, hasTranscript }: Loaded): string[] {
  const { stages } = summarise(consultation.status);
  // A form made without a recording (owner's test team, 23 Nov): nothing was recorded or transcribed.
  const unrecorded = stages[1] === "done" && tracks.length === 0 && !hasTranscript;
  return [
    consultation.consent_withdrawn_at ? `Withdrawn ${dayMonth(consultation.consent_withdrawn_at)}`
      : consultation.patient_recording === "declined" ? "Patient said no to recording"
      : consultation.patient_recording === "agreed" ? `Patient agreed ${dayMonth(consultation.patient_recording_at!)}`
      : consultation.consent_recorded_at ? `Recorded ${dayMonth(consultation.consent_recorded_at)}` : "Not recorded yet",
    unrecorded ? "Not recorded" : stages[1] === "done" ? "Recorded" : stages[1] === "current" && tracks.length > 0 ? "Saved in part" : "Not yet",
    unrecorded ? "No transcript" : { current: consultation.status === "transcription_processing" ? "Transcribing" : "Ready to start", failed: "Failed", done: "Done" }[
      stages[2] as "current" | "failed" | "done"] ?? "Not yet",
    ({ transcript_ready: "Not set up", transcript_reviewed: "Not set up", extraction_processing: "Filling in",
      extraction_failed: "Failed", draft_ready: "Ready to check", under_review: "Checking", approved: "Approved" } as Record<string, string>)[
      consultation.status] ?? "Not yet",
  ];
}

function ConsultationView({ userId }: { userId: string }) {
  const id = useSearchParams().get("id") ?? "";
  const [loaded, setLoaded] = useState<Loaded | "missing" | "failed" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const router = useRouter();

  const fetchAll = useCallback(async (): Promise<Loaded | "missing" | "failed"> => {
    const [consultation, tracks, transcript] = await Promise.all([
      supabase.from("consultations").select("*").eq("id", id).maybeSingle(),
      supabase.from("audio_tracks").select("*").eq("consultation_id", id),
      supabase.from("transcripts").select("id").eq("consultation_id", id).neq("review_status", "superseded").maybeSingle(),
    ]);
    if (consultation.error || tracks.error || transcript.error) return "failed";
    if (!consultation.data) return "missing";
    // After a withdrawal, files that could not be deleted are offered for deletion again.
    const files = consultation.data.status === "consent_withdrawn"
      ? (await supabase.storage.from("audio").list(`${userId}/${id}`)).data ?? [] : [];
    const row = consultation.data;
    const patient = row.patient_id
      ? (await supabase.from("patients").select("id, name, phone, email").eq("id", row.patient_id).maybeSingle()).data
      : null;
    const earlierConsultations = row.patient_id
      ? await supabase.from("consultations").select("id, scheduled_at, language, status, patient_association_state")
        .eq("patient_id", row.patient_id).neq("id", row.id).lt("scheduled_at", row.scheduled_at)
        .filter("released", "eq", false).order("scheduled_at", { ascending: false })
      : null;
    const history = earlierConsultations?.error ? "failed" : earlierConsultations?.data ?? null;
    let previousContext: PreviousContext | null = null;
    if (row.previous_consultation_id) {
      const [previous, previousForm] = await Promise.all([
        supabase.from("consultations").select("scheduled_at").eq("id", row.previous_consultation_id).maybeSingle(),
        supabase.from("forms").select("template, form_answers(field_key, machine_text, practitioner_text, review, value_type, answer_state, machine_value, practitioner_value)")
          .eq("consultation_id", row.previous_consultation_id).eq("status", "approved")
          .order("revision_number", { ascending: false }).limit(1).maybeSingle(),
      ]);
      if (previous.data && previousForm.data) previousContext = {
        scheduledAt: previous.data.scheduled_at,
        template: previousForm.data.template as unknown as FormTemplate,
        answers: previousForm.data.form_answers as FormAnswer[],
      };
    }
    // Who it is with, and whom to ask about (components/patient-check.tsx).
    const columns = { ...row, patients: patient };
    const earlier = await earlierPatients([columns]);
    const shown = shownPatient(columns, earlier);
    const before = row.legacy_patient_id ? earlier.get(row.legacy_patient_id) : undefined;
    const candidate = shown?.check === "earlier" && before ? { id: row.legacy_patient_id!, ...before }
      : shown?.check === "typed" ? (await supabase.from("patients").select("id, name, phone, email")
        .eq(row.patient_claim_phone ? "phone" : "email", row.patient_claim_phone ?? row.patient_claim_email!).maybeSingle()).data
      : null;
    return { consultation: row, tracks: tracks.data, audioLeft: files.length > 0,
      hasTranscript: transcript.data !== null, patient, shown, candidate, history, previousContext };
  }, [id, userId]);
  const load = useCallback(() => {
    fetchAll().then(setLoaded);
  }, [fetchAll]);

  useEffect(() => {
    if (!isId(id)) return;
    let current = true;
    fetchAll().then((result) => current && setLoaded(result));
    return () => {
      current = false;
    };
  }, [id, fetchAll]);

  if (!isId(id) || loaded === "missing") {
    return <>{back}<p className="wa-text">This consultation does not exist, or it is not yours.</p></>;
  }
  if (loaded === "failed") {
    return <>{back}<Notice tone="failed" title="The consultation could not be loaded">Check your connection and reload the page.</Notice></>;
  }
  if (loaded === null) return <p className="wa-meta" role="status">Loading the consultation…</p>;

  const { consultation, tracks, audioLeft, hasTranscript, patient, shown, candidate, history, previousContext } = loaded;
  const status = consultation.status;
  const language = LANGUAGE_LABEL[consultation.language];

  async function run(step: () => Promise<void>) {
    setBusy(true);
    setProblem(null);
    await step();
    setBusy(false);
    load();
  }
  const perform = (name: "record_consent" | "start_transcription") => run(async () => {
    const outcome = await call(name, { p_consultation_id: consultation.id });
    if (!outcome.ok) setProblem(explain(outcome.error_category));
  });
  // A call whose upload stopped half way: drop what arrived, so the call can be made again.
  const discard = () => run(async () => {
    for (const track of tracks) {
      const outcome = await call("remove_audio_track", { p_consultation_id: consultation.id, p_speaker: track.speaker });
      if (!outcome.ok) return setProblem(explain(outcome.error_category));
    }
  });
  async function deleteAudio() {
    await supabase.storage.from("audio").remove(SPEAKERS.map((speaker) => `${userId}/${consultation.id}/${speaker}`));
    await call("confirm_audio_deleted", { p_consultation_id: consultation.id });
  }
  const withdraw = () => run(async () => {
    const outcome = await call("withdraw_consent", { p_consultation_id: consultation.id });
    if (!outcome.ok) return setProblem(explain(outcome.error_category));
    setConfirming(false);
    await deleteAudio();
  });
  const archive = () => run(async () => {
    const outcome = await call("archive_consultation", { p_consultation_id: consultation.id });
    if (!outcome.ok) return setProblem(explain(outcome.error_category));
    setConfirmArchive(false);
  });

  // No recording: Watson fills in the form from the notes and documents, or the doctor writes it.
  const withoutRecording = (byWatson: boolean) => run(async () => {
    const outcome = await call<{ id: string }>("start_form_without_recording", { p_consultation_id: consultation.id, p_by_watson: byWatson });
    if (!outcome.ok) {
      return setProblem(outcome.error_category === "NOTHING_TO_FILL"
        ? "Write your notes first, or add the patient\u2019s documents: Watson fills in the form from them." : explain(outcome.error_category));
    }
    if (!byWatson) router.push(`/form/?id=${consultation.id}`);
  });
  const unrecorded = ["consent_pending", "ready_for_audio"].includes(status) && tracks.length === 0;
  const declined = consultation.patient_recording === "declined";
  const notes = <DoctorNotes key={status} consultationId={consultation.id} editable={!["approved", "corrected"].includes(status)} />;

  const canWithdraw = consultation.consent_recorded_at !== null && WITHDRAWABLE.includes(status);

  return (
    <>
      {back}
      <div className="wa-pagehead">
        <div className="wa-pagehead__text">
          <PatientName consultationId={consultation.id} shown={shown} fallback={consultation.synthetic_patient_ref} onChanged={load} />
          <p className="wa-meta">
            {dateTime(consultation.scheduled_at)} · {language}
            {shown && ` · ${shown.phone ?? shown.email}`}
            {consultation.fee_cents !== null && ` · Fee ${euros(consultation.fee_cents)}`}
            {consultation.scenario_notes && ` · ${consultation.scenario_notes}`}
          </p>
          {(status === "approved" || status === "corrected") && (
            <p className="wa-hint">The form is approved, so consent can no longer be withdrawn here.</p>
          )}
        </div>
        {!confirming && !confirmArchive && status !== "archived" && (
          <div className="wa-actions">
            {canWithdraw && (
              <button type="button" className="wa-button wa-button--danger wa-button--small" onClick={() => setConfirming(true)}>
                Withdraw consent
              </button>
            )}
            <button type="button" className="wa-button wa-button--quiet wa-button--small" onClick={() => setConfirmArchive(true)}>
              <Archive aria-hidden className="wa-icon wa-icon--sm" />Archive
            </button>
          </div>
        )}
      </div>
      {confirming && (
        <Notice tone="attention" title="Withdraw consent?" actions={<>
          <button type="button" className="wa-button wa-button--danger" disabled={busy} onClick={withdraw}>Withdraw consent</button>
          <button type="button" className="wa-button wa-button--secondary" disabled={busy} onClick={() => setConfirming(false)}>Keep consent</button>
        </>}>
          Any transcription stops, and both audio tracks and the transcript are deleted. This cannot be undone.
        </Notice>
      )}
      {confirmArchive && (
        <Notice tone="attention" title="Archive this consultation?" actions={<>
          <button type="button" className="wa-button wa-button--danger" disabled={busy} onClick={archive}>Archive consultation</button>
          <button type="button" className="wa-button wa-button--secondary" disabled={busy} onClick={() => setConfirmArchive(false)}>Keep consultation</button>
        </>}>
          It moves to Archived instead of being permanently deleted. Any transcription or form work still running will stop.
        </Notice>
      )}

      {status === "archived" ? (
        <Notice title="Archived">This consultation is kept for review, but no further work or patient messages can be started from it.</Notice>
      ) : <Journey status={status} lines={stepLines(loaded)} />}
      {problem && <Notice tone="failed" title="That did not work">{problem}</Notice>}

      {status === "ready_for_audio" && tracks.length > 0 && (
        <Notice tone="attention" title="The last call was saved only in part" actions={
          <button type="button" className="wa-button wa-button--secondary" disabled={busy} onClick={discard}>Discard and call again</button>
        }>
          One voice was saved, the other was not, so there is nothing to transcribe yet. Discard what was saved and call the patient again.
        </Notice>
      )}

      {status === "audio_imported" && (
        <section className="wa-panel" aria-labelledby="recorded-title">
          <h2 className="wa-heading" id="recorded-title">The call is recorded</h2>
          <p className="wa-text">Both voices are saved. Watson writes the transcript, then fills in your form.</p>
          <div className="wa-actions">
            <button type="button" className="wa-button wa-button--primary" disabled={busy} aria-busy={busy || undefined}
              onClick={() => perform("start_transcription")}>Start transcription</button>
          </div>
        </section>
      )}

      {["consent_pending", "ready_for_audio"].includes(status) && tracks.length === 0 && (
        <section className="wa-panel" aria-labelledby="call-title">
          <h2 className="wa-heading" id="call-title">Consultation call</h2>
          <p className="wa-text">Talk to the patient by video. Both voices are recorded and transcribed when you end the call.</p>
          <div className="wa-actions">
            <Link href={`/room/?id=${consultation.id}`} className="wa-button wa-button--primary">
              <Video aria-hidden className="wa-icon" />Start video call
            </Link>
          </div>
        </section>
      )}

      {unrecorded && (
        <section className="wa-panel" aria-labelledby="unrecorded-title">
          <h2 className="wa-heading" id="unrecorded-title">{declined ? "Not recorded" : "Without a recording"}</h2>
          <p className="wa-text">
            {declined ? "The patient chose not to be recorded. Write your notes below, then have Watson fill in the form from them and the patient\u2019s documents, or write the form yourself."
              : "Met the patient in person, or the call was not recorded? Watson fills in the form from your notes and the patient\u2019s documents, or you write it yourself."}
          </p>
          <div className="wa-actions">
            <button type="button" className={`wa-button ${declined ? "wa-button--primary" : "wa-button--secondary"}`} disabled={busy}
              onClick={() => withoutRecording(true)}><ClipboardList aria-hidden className="wa-icon" />Fill in from my notes</button>
            <button type="button" className="wa-button wa-button--secondary" disabled={busy}
              onClick={() => withoutRecording(false)}><PenLine aria-hidden className="wa-icon" />Write it myself</button>
          </div>
        </section>
      )}

      {unrecorded && notes}

      {status === "consent_pending" && (
        <section className="wa-panel" aria-labelledby="consent-title">
          <h2 className="wa-heading" id="consent-title">Consent</h2>
          <p className="wa-text">Consent to recording and transcription is not recorded yet. Starting the call records it.</p>
          <div className="wa-actions">
            <button type="button" className="wa-button wa-button--primary" disabled={busy} onClick={() => perform("record_consent")}>Record consent</button>
          </div>
        </section>
      )}

      {status === "consent_withdrawn" && (
        audioLeft ? (
          <Notice tone="attention" title="Audio not yet deleted" actions={
            <button type="button" className="wa-button wa-button--primary" disabled={busy} onClick={() => run(deleteAudio)}>Delete audio now</button>
          }>
            Consent was withdrawn, but the audio files are still stored. Delete them now.
          </Notice>
        ) : (
          <Notice title="Consent was withdrawn">The audio tracks and any transcript of this consultation are deleted.</Notice>
        )
      )}

      {(status === "transcription_processing" || status === "transcription_failed") && (
        <JobPanel consultationId={consultation.id} status={status} onChanged={load} />
      )}

      {FORM_STATUSES.includes(status) && <FormPanel consultationId={consultation.id} status={status} onChanged={load} />}
      {!unrecorded && !["consent_withdrawn", "archived"].includes(status) && notes}

      {shown?.check && <PatientCheck consultationId={consultation.id} shown={shown} candidate={candidate} onChanged={load} />}
      {!["consent_withdrawn", "archived"].includes(status) && <PatientPanel consultation={consultation} patient={shown} onChanged={load} />}

      <PreviousAppointmentSelector key={consultation.previous_consultation_id ?? "unlinked"}
        consultation={consultation} history={history} onChanged={load} onProblem={setProblem} />

      {previousContext && <PreviousValues context={previousContext} />}

      <PatientHistory history={history} />

      {!["consent_withdrawn", "archived"].includes(status) && <DocumentsPanel consultationId={consultation.id} patient={patient} person={shown} onChanged={load} />}

      {status !== "archived" && <WhatsAppPanel consultationId={consultation.id} />}

      {HAS_TRANSCRIPT.includes(status) && hasTranscript && (
        <TranscriptView consultationId={consultation.id} language={language}
          editable={!["approved", "corrected", "archived"].includes(status)} />
      )}


      {(status === "transcription_processing" || HAS_TRANSCRIPT.includes(status)) && tracks.length > 0 && (
        <aside className="wa-aside" aria-labelledby="audio-summary">
          <h2 className="wa-heading" id="audio-summary">Audio</h2>
          <ul className="wa-facts" style={{ display: "grid", gap: 4 }}>
            {SPEAKERS.map((speaker) => {
              const track = tracks.find((candidate) => candidate.speaker === speaker);
              return track && (
                <li key={speaker}>
                  <strong className={speaker === "patient" ? "wa-voice--patient" : "wa-voice--practitioner"}>
                    {speaker === "patient" ? "Patient" : "Practitioner"}
                  </strong>
                  {track.duration_seconds !== null && ` · ${clock(track.duration_seconds)}`} · {track.format.toUpperCase()} · {humanSize(track.size_bytes)}
                </li>
              );
            })}
            <li>{consultation.recorded_together ? "Recorded together" : "Recorded separately"}</li>
          </ul>
        </aside>
      )}
    </>
  );
}

function PreviousValues({ context }: { context: PreviousContext }) {
  const answers = new Map(context.answers.map((answer) => [answer.field_key, answer]));
  return <section className="wa-panel" aria-labelledby="previous-values-title">
    <h2 className="wa-heading" id="previous-values-title">Dated values from {dateTime(context.scheduledAt)}</h2>
    <p className="wa-hint">Read-only historical context. These values are never copied into the current form.</p>
    {context.template.sections.map((section) => <div key={section.title}>
      <h3 className="wa-label">{section.title}</h3>
      <dl className="wa-printed__answers">{section.fields.map((field) => {
        const value = answerText(answers.get(field.key), field);
        return value ? <div key={field.key}><dt>{field.label}</dt><dd>{value}</dd></div> : null;
      })}</dl>
    </div>)}
  </section>;
}

function PreviousAppointmentSelector({ consultation, history, onChanged, onProblem }: {
  consultation: Consultation;
  history: History[] | "failed" | null;
  onChanged: () => void;
  onProblem: (message: string | null) => void;
}) {
  const [selected, setSelected] = useState(consultation.previous_consultation_id ?? "");
  const [busy, setBusy] = useState(false);
  const eligible = Array.isArray(history)
    ? history.filter((item) => ["verified", "practitioner_confirmed"].includes(item.patient_association_state))
    : [];

  if (!["consent_pending", "ready_for_audio"].includes(consultation.status)
      || consultation.patient_id === null
      || !["verified", "practitioner_confirmed"].includes(consultation.patient_association_state)
      || history === null
      || history === "failed") return null;

  async function save() {
    setBusy(true);
    onProblem(null);
    const outcome = await call("link_previous_consultation", {
      p_consultation_id: consultation.id,
      p_previous_consultation_id: selected || null,
    });
    setBusy(false);
    if (!outcome.ok) return onProblem(explain(outcome.error_category));
    onChanged();
  }

  return (
    <section className="wa-panel" aria-labelledby="previous-appointment-title">
      <h2 className="wa-heading" id="previous-appointment-title">Previous appointment</h2>
      <p className="wa-hint" id="previous-appointment-hint">
        Optional. Link one earlier appointment for this confirmed patient. Its approved values remain dated history, not current answers.
      </p>
      {eligible.length === 0 ? (
        <p className="wa-text">No eligible earlier appointment is available to link.</p>
      ) : (
        <div className="wa-fields-row" style={{ alignItems: "end" }}>
          <div className="wa-field">
            <label className="wa-label" htmlFor="previous-appointment">Earlier appointment</label>
            <div className="wa-select">
              <select id="previous-appointment" value={selected} aria-describedby="previous-appointment-hint"
                onChange={(event) => setSelected(event.target.value)}>
                <option value="">Not linked</option>
                {eligible.map((item) => (
                  <option key={item.id} value={item.id}>
                    {dateTime(item.scheduled_at)} · {LANGUAGE_LABEL[item.language]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button type="button" className="wa-button wa-button--secondary" disabled={busy || selected === (consultation.previous_consultation_id ?? "")}
            aria-busy={busy || undefined} onClick={save}>
            {busy ? "Saving…" : "Save link"}
          </button>
        </div>
      )}
    </section>
  );
}

function PatientHistory({ history }: { history: History[] | "failed" | null }) {
  return (
    <section className="wa-panel" aria-labelledby="history-title">
      <div className="wa-panel__head">
        <h2 className="wa-heading" id="history-title">Past consultations</h2>
      </div>
      {history === null ? (
        <p className="wa-text">Confirm who this patient is to see their earlier consultations safely.</p>
      ) : history === "failed" ? (
        <Notice tone="failed" title="Past consultations could not be loaded">Check your connection and reload the page.</Notice>
      ) : history.length === 0 ? (
        <p className="wa-text">No earlier consultations for this patient.</p>
      ) : (
        <ul className="wa-done-list">
          {history.map((consultation) => (
            <li key={consultation.id}>
              <Link href={`/consultation/?id=${consultation.id}`} className="wa-row__ref" style={{ color: "inherit" }}>
                {dateTime(consultation.scheduled_at)}
              </Link>
              <span className="wa-meta">{LANGUAGE_LABEL[consultation.language]}</span>
              <span style={{ marginLeft: "auto" }}><StatusChip status={consultation.status} /></span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The patient's name, and changing it where the doctor sees it (owner, 23 Nov). The phone or email stay as they are. */
function PatientName({ consultationId, shown, fallback, onChanged }: {
  consultationId: string; shown: Shown | null; fallback: string; onChanged: () => void;
}) {
  const [name, setName] = useState<string | null>(null); // null: not changing it
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!shown || name === null) return;
    setBusy(true);
    setProblem(null);
    const outcome = await call("set_patient", { p_consultation_id: consultationId, p_name: name, p_contact: shown.phone ?? shown.email ?? "" });
    setBusy(false);
    if (!outcome.ok) return setProblem(outcome.field === "name" ? "Write the patient\u2019s name, up to 120 characters." : explain(outcome.error_category));
    setName(null);
    onChanged();
  }

  if (name === null) {
    return (
      <div className="wa-actions" style={{ alignItems: "center" }}>
        <h1 className="wa-title">{shown?.name ?? fallback}</h1>
        {shown && (
          <button type="button" className="wa-button wa-button--quiet wa-button--small" onClick={() => { setProblem(null); setName(shown.name); }}>
            <Pencil aria-hidden className="wa-icon wa-icon--sm" />Change name
          </button>
        )}
      </div>
    );
  }
  return (
    <form className="wa-form" style={{ gap: 12 }} onSubmit={(event) => void save(event)}>
      <div className="wa-field">
        <label className="wa-label" htmlFor="patient-rename">Patient&apos;s name</label>
        <input id="patient-rename" className="wa-input" value={name} maxLength={120} autoFocus autoComplete="off"
          aria-invalid={Boolean(problem)} aria-describedby="patient-rename-error" onChange={(event) => setName(event.target.value)} />
        <FieldError id="patient-rename-error" message={problem ?? undefined} />
      </div>
      <div className="wa-actions">
        <button type="submit" className="wa-button wa-button--primary" disabled={busy}>Save name</button>
        <button type="button" className="wa-button wa-button--quiet" disabled={busy} onClick={() => setName(null)}>Cancel</button>
      </div>
    </form>
  );
}
