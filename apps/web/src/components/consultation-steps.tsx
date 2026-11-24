"use client";

import { ClipboardList, PenLine, Video } from "lucide-react";
import Link from "next/link";
import { Notice } from "@/components/status";
import { SPEAKERS, type Loaded } from "@/lib/consultation-page";
import { clock, humanSize } from "@/lib/audio";

export type StepActions = {
  busy: boolean;
  discardPartial: () => void;
  startTranscription: () => void;
  recordConsent: () => void;
  withoutRecording: (byWatson: boolean) => void;
  deleteAudio: () => void;
};

/** The step the consultation waits for, as one panel: the call, consent, a recording to transcribe, or none. */
export function NextStep({ loaded, actions, notes }: { loaded: Loaded; actions: StepActions; notes: React.ReactNode }) {
  const { consultation, tracks, audioLeft } = loaded;
  const status = consultation.status;
  const beforeCall = ["consent_pending", "ready_for_audio"].includes(status);
  return (
    <>
      {status === "ready_for_audio" && tracks.length > 0 && <PartialSave actions={actions} />}
      {status === "audio_imported" && <Recorded actions={actions} />}
      {beforeCall && tracks.length === 0 && (
        <>
          <CallPanel consultationId={consultation.id} />
          <Unrecorded declined={consultation.patient_recording === "declined"} actions={actions} />
          {notes}
        </>
      )}
      {status === "consent_pending" && <ConsentPanel actions={actions} />}
      {status === "consent_withdrawn" && <Withdrawn audioLeft={audioLeft} actions={actions} />}
    </>
  );
}

function PartialSave({ actions }: { actions: StepActions }) {
  return (
    <Notice tone="attention" title="The last call was saved only in part" actions={
      <button type="button" className="wa-button wa-button--secondary" disabled={actions.busy} onClick={actions.discardPartial}>Discard and call again</button>
    }>
      One voice was saved, the other was not, so there is nothing to transcribe yet. Discard what was saved and call the patient again.
    </Notice>
  );
}

function Recorded({ actions }: { actions: StepActions }) {
  return (
    <section className="wa-panel" aria-labelledby="recorded-title">
      <h2 className="wa-heading" id="recorded-title">The call is recorded</h2>
      <p className="wa-text">Both voices are saved. Watson writes the transcript, then fills in your form.</p>
      <div className="wa-actions">
        <button type="button" className="wa-button wa-button--primary" disabled={actions.busy} aria-busy={actions.busy || undefined}
          onClick={actions.startTranscription}>Start transcription</button>
      </div>
    </section>
  );
}

function CallPanel({ consultationId }: { consultationId: string }) {
  return (
    <section className="wa-panel" aria-labelledby="call-title">
      <h2 className="wa-heading" id="call-title">Consultation call</h2>
      <p className="wa-text">Talk to the patient by video. Both voices are recorded and transcribed when you end the call.</p>
      <div className="wa-actions">
        <Link href={`/room/?id=${consultationId}`} className="wa-button wa-button--primary">
          <Video aria-hidden className="wa-icon" />Start video call
        </Link>
      </div>
    </section>
  );
}

/** No recording (owner's test team, 23 Nov): Watson fills in the form from the notes and documents, or the doctor writes it. */
function Unrecorded({ declined, actions }: { declined: boolean; actions: StepActions }) {
  return (
    <section className="wa-panel" aria-labelledby="unrecorded-title">
      <h2 className="wa-heading" id="unrecorded-title">{declined ? "Not recorded" : "Without a recording"}</h2>
      <p className="wa-text">
        {declined ? "The patient chose not to be recorded. Write your notes below, then have Watson fill in the form from them and the patient’s documents, or write the form yourself."
          : "Met the patient in person, or the call was not recorded? Watson fills in the form from your notes and the patient’s documents, or you write it yourself."}
      </p>
      <div className="wa-actions">
        <button type="button" className={`wa-button ${declined ? "wa-button--primary" : "wa-button--secondary"}`} disabled={actions.busy}
          onClick={() => actions.withoutRecording(true)}><ClipboardList aria-hidden className="wa-icon" />Fill in from my notes</button>
        <button type="button" className="wa-button wa-button--secondary" disabled={actions.busy}
          onClick={() => actions.withoutRecording(false)}><PenLine aria-hidden className="wa-icon" />Write it myself</button>
      </div>
    </section>
  );
}

function ConsentPanel({ actions }: { actions: StepActions }) {
  return (
    <section className="wa-panel" aria-labelledby="consent-title">
      <h2 className="wa-heading" id="consent-title">Consent</h2>
      <p className="wa-text">Consent to recording and transcription is not recorded yet. Starting the call records it.</p>
      <div className="wa-actions">
        <button type="button" className="wa-button wa-button--primary" disabled={actions.busy} onClick={actions.recordConsent}>Record consent</button>
      </div>
    </section>
  );
}

function Withdrawn({ audioLeft, actions }: { audioLeft: boolean; actions: StepActions }) {
  return audioLeft ? (
    <Notice tone="attention" title="Audio not yet deleted" actions={
      <button type="button" className="wa-button wa-button--primary" disabled={actions.busy} onClick={actions.deleteAudio}>Delete audio now</button>
    }>
      Consent was withdrawn, but the audio files are still stored. Delete them now.
    </Notice>
  ) : (
    <Notice title="Consent was withdrawn">The audio tracks and any transcript of this consultation are deleted.</Notice>
  );
}

/** The two voices of the call: who, how long, what kind of file, how big. */
export function AudioSummary({ loaded }: { loaded: Loaded }) {
  const { consultation, tracks } = loaded;
  return (
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
  );
}
