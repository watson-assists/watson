"use client";

import { ChevronLeft, Mic, MicOff, PhoneOff, Video, VideoOff } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { CopyButton } from "@/components/copy-button";
import { CorrectableLine } from "@/components/correctable-line";
import { DoctorNotes } from "@/components/doctor-notes";
import { FormSoFar } from "@/components/form-so-far";
import { Notice } from "@/components/status";
import { call as rpc } from "@/lib/api";
import { clock } from "@/lib/audio";
import { connect, patientLink, recordCall, type CallState, type Recording } from "@/lib/call";
import type { Tables } from "@/lib/database.types";
import { liveLines, livePieceSender, type LiveLine } from "@/lib/live";
import { RequireSession } from "@/lib/session";
import type { Spelling } from "@/lib/spelling";
import { supabase } from "@/lib/supabase";
import { attachAudio } from "@/lib/tracks";

type Loaded = { consultation: Tables<"consultations"> & { patients: { name: string } | null }; tracks: number };
const CAN_CALL = ["consent_pending", "ready_for_audio"];

export default function RoomPage() {
  return (
    <RequireSession>
      {(user) => (
        <AppShell user={user}>
          <Suspense fallback={<p className="wa-meta" role="status">Loading the call…</p>}>
            <Room userId={user.id} />
          </Suspense>
        </AppShell>
      )}
    </RequireSession>
  );
}

const NOTE: Partial<Record<CallState, [string, string]>> = {
  joining: ["Opening the call…", ""],
  waiting: ["Waiting for the patient", "Send them the link above. Watson records only if they agree, on their link."],
  connecting: ["Connecting…", ""],
  reconnecting: ["The connection dropped. Reconnecting…", "Recording continues."],
};

function Room({ userId }: { userId: string }) {
  const id = useSearchParams().get("id") ?? "";
  const router = useRouter();
  const [loaded, setLoaded] = useState<Loaded | "missing" | null>(null);
  const [state, setState] = useState<CallState | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [unsaved, setUnsaved] = useState<Recording | null>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [recording, setRecording] = useState(false);
  const [declined, setDeclined] = useState(false); // the patient chose not to be recorded
  const [lines, setLines] = useState<LiveLine[]>([]);
  const transcript = useRef<HTMLOListElement>(null);
  const localVideo = useRef<HTMLVideoElement>(null);
  const remoteVideo = useRef<HTMLVideoElement>(null);
  const session = useRef<{ leave(): Promise<void> } | null>(null);
  const recorder = useRef<ReturnType<typeof recordCall> | null>(null);
  const media = useRef<MediaStream | null>(null);

  useEffect(() => {
    let current = true;
    Promise.all([
      supabase.from("consultations").select("*, patients(name)").eq("id", id).maybeSingle(),
      supabase.from("audio_tracks").select("id", { count: "exact", head: true }).eq("consultation_id", id),
    ]).then(([consultation, tracks]) => {
      if (current) setLoaded(consultation.data ? { consultation: consultation.data, tracks: tracks.count ?? 0 } : "missing");
    });
    return () => {
      current = false;
    };
  }, [id]);

  const live = state !== null && state !== "ended";
  useEffect(() => {
    if (!live) return;
    const tick = setInterval(() => setElapsed(recorder.current?.seconds ?? 0), 1000);
    // Leaving the page mid-call would lose the recording.
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => {
      clearInterval(tick);
      window.removeEventListener("beforeunload", warn);
    };
  }, [live]);
  useEffect(() => () => {
    media.current?.getTracks().forEach((track) => track.stop());
    void session.current?.leave();
  }, []);

  // A line corrected during the call (owner, 24 Oct); a few words changed teach Watson their spelling.
  const [learned, setLearned] = useState<Spelling[]>([]);
  async function correctLine(pieceId: string, text: string, spellings: Spelling[]) {
    const outcome = await rpc("correct_live_line", { p_piece_id: pieceId, p_text: text, p_spellings: spellings });
    if (!outcome.ok) return false;
    if (spellings.length) setLearned(spellings);
    setLines(await liveLines(id));
    return true;
  }

  // The live transcript: what the engine has written so far, every second while the call runs.
  const called = state !== null;
  useEffect(() => {
    if (!called) return;
    const poll = setInterval(() => void liveLines(id).then(setLines), 1000); // 17 Nov: was 3 s
    return () => clearInterval(poll);
  }, [called, id]);
  useEffect(() => {
    const list = transcript.current;
    if (list) list.scrollTop = list.scrollHeight; // the newest words in view
  }, [lines]);

  const back = (
    <Link href={`/consultation/?id=${id}`} className="wa-crumb"><ChevronLeft aria-hidden className="wa-icon wa-icon--sm" />Consultation</Link>
  );
  if (loaded === null) return <p className="wa-meta" role="status">Loading the call…</p>;
  if (loaded === "missing") return <>{back}<p className="wa-text">This consultation does not exist, or it is not yours.</p></>;
  const { consultation } = loaded;
  if (!state && !step && (loaded.tracks > 0 || !CAN_CALL.includes(consultation.status))) {
    return (
      <>{back}
        <h1 className="wa-title">{consultation.patients?.name ?? consultation.patient_claim_name ?? consultation.synthetic_patient_ref}</h1>
        <Notice title="This consultation already has audio">A call can be recorded only before any audio is attached.</Notice>
      </>
    );
  }

  async function start() {
    setProblem(null);
    let local: MediaStream;
    try {
      local = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    } catch {
      return setProblem("The camera or microphone is not available. Allow them in your browser, then try again.");
    }
    media.current = local;
    if (localVideo.current) localVideo.current.srcObject = local;
    const invite = consultation.invite_token; // the link the patient already has
    setToken(invite);
    const recording = recordCall(local, livePieceSender(userId, id));
    recorder.current = recording;
    session.current = connect({
      consultationId: id, token: invite, role: "doctor", local,
      onRemote: (remote) => {
        if (remoteVideo.current) remoteVideo.current.srcObject = remote;
        recording.addPatient(remote);
      },
      onState: (next) => {
        setState(next);
        // Recording starts only once the patient has agreed, on their link (owner, 23 Nov).
        if (next === "connected") void patientAgreed().then((agreed) => {
          setDeclined(!agreed);
          if (!agreed) return;
          recording.start();
          setRecording(true);
        });
      },
    });
  }

  async function patientAgreed() {
    const { data } = await supabase.from("consultations").select("patient_recording").eq("id", id).maybeSingle();
    return data?.patient_recording === "agreed";
  }

  async function save(recording: Recording) {
    setProblem(null);
    for (const speaker of ["practitioner", "patient"] as const) {
      const failure = await attachAudio({
        consultationId: id, userId, speaker, blob: recording[speaker], format: recording.format,
        seconds: recording.seconds, onStep: setStep,
      });
      if (failure) {
        setStep(null);
        setUnsaved(recording);
        return setProblem(failure);
      }
    }
    setStep("Starting transcription…");
    await rpc("declare_recorded_together", { p_consultation_id: id, p_recorded_together: true });
    await rpc("start_transcription", { p_consultation_id: id });
    router.push(`/consultation/?id=${id}`);
  }

  async function end() {
    setStep("Ending the call…");
    await session.current?.leave();
    session.current = null;
    media.current?.getTracks().forEach((track) => track.stop());
    const recording = await recorder.current?.stop();
    if (recording) return save(recording);
    router.push(`/consultation/?id=${id}`);
  }

  function toggle(kind: "audio" | "video") {
    const tracks = kind === "audio" ? media.current?.getAudioTracks() : media.current?.getVideoTracks();
    const off = kind === "audio" ? !muted : !cameraOff;
    tracks?.forEach((track) => (track.enabled = !off));
    if (kind === "audio") setMuted(off);
    else setCameraOff(off);
  }

  const note = state === null ? ["Start the call, then send the patient the link.", ""] : NOTE[state];
  const link = token && consultation ? patientLink(consultation.short_code) : null;
  return (
    <>
      {back}
      <div className="wa-pagehead">
        <div className="wa-pagehead__text">
          <h1 className="wa-title">{consultation.patients?.name ?? consultation.patient_claim_name ?? consultation.synthetic_patient_ref}</h1>
          <p className="wa-meta">Video call. If the patient agrees, both voices are recorded, with a live transcript beside the video; the full transcript and the form follow when you end the call.</p>
        </div>
      </div>
      <div className="wa-room">
      <div className="wa-call">
        {link && live && (
          <div className="wa-field">
            <label className="wa-label" htmlFor="invite">Send this link to the patient</label>
            <div className="wa-invite">
              <input id="invite" className="wa-input" readOnly value={link} onFocus={(event) => event.target.select()} />
              <CopyButton text={link} />
            </div>
          </div>
        )}
        <div className="wa-screen">
          <video ref={remoteVideo} autoPlay playsInline aria-label="The patient" />
          {state !== "connected" && note && (
            <div className="wa-screen__note">
              <p className="wa-heading" style={{ color: "inherit" }}>{note[0]}</p>
              {note[1] && <p className="wa-text">{note[1]}</p>}
            </div>
          )}
          {recording && live && <span className="wa-live" role="status">Recording {clock(elapsed)}</span>}
          {declined && live && <span className="wa-live wa-live--off" role="status">Not recorded</span>}
          <div className="wa-screen__self"><video ref={localVideo} autoPlay playsInline muted aria-label="You" /></div>
        </div>
        <div className="wa-call__bar">
          {state === null && !step ? (
            <button type="button" className="wa-button wa-button--primary" onClick={start}>
              <Video aria-hidden className="wa-icon" />Start video call
            </button>
          ) : live && !step ? (
            <>
              <button type="button" className="wa-button wa-button--secondary" aria-pressed={muted} onClick={() => toggle("audio")}>
                {muted ? <MicOff aria-hidden className="wa-icon" /> : <Mic aria-hidden className="wa-icon" />}{muted ? "Unmute" : "Mute"}
              </button>
              <button type="button" className="wa-button wa-button--secondary" aria-pressed={cameraOff} onClick={() => toggle("video")}>
                {cameraOff ? <VideoOff aria-hidden className="wa-icon" /> : <Video aria-hidden className="wa-icon" />}{cameraOff ? "Turn camera on" : "Turn camera off"}
              </button>
              <button type="button" className="wa-button wa-button--danger" onClick={end}>
                <PhoneOff aria-hidden className="wa-icon" />End call
              </button>
            </>
          ) : null}
        </div>
        {step && <p className="wa-meta" role="status" style={{ textAlign: "center" }}>{step}</p>}
        {problem && (
          <Notice tone="failed" title="That did not work" actions={unsaved && (
            <button type="button" className="wa-button wa-button--primary" onClick={() => save(unsaved)}>Try saving again</button>
          )}>
            {problem}
          </Notice>
        )}
        <DoctorNotes consultationId={id} editable look="side" />
      </div>
      {called && (
        <div className="wa-room__side">
        <aside className="wa-livetext" aria-labelledby="live-title">
          <h2 className="wa-heading" id="live-title" style={{ color: "var(--ink)" }}>Live transcript</h2>
          <p className="wa-hint">
            {declined ? "The patient chose not to be recorded, so this call has no transcript. Write what matters in your notes: Watson fills in the form from them after the call."
              : lines.length ? "A few seconds behind. The full transcript follows when you end the call."
              : recording ? "Starting Watson's engine… the first words appear in about half a minute."
              : "Starts when the patient joins and agrees to recording."}
          </p>
          <ol ref={transcript} className="wa-livetext__lines" aria-live="polite">
            {lines.map((line) => (
              <li key={`${line.speaker}-${line.seq}`} className={`wa-quote wa-quote--${line.speaker}`}>
                <div>
                  <span className="wa-quote__who">{line.speaker === "practitioner" ? "You" : consultation.patients?.name ?? consultation.patient_claim_name ?? "Patient"}</span>
                  <span className="wa-livetext__when">{clock(line.offset_seconds)}</span>
                  <CorrectableLine textClassName="wa-quote__text" text={line.text} heard={line.heard_text}
                    onSave={(text, spellings) => correctLine(line.id, text, spellings)} />
                </div>
              </li>
            ))}
          </ol>
          {learned.length > 0 && (
            <Notice title="Watson will spell it your way">
              {learned.map((spelling) => `\u201c${spelling.written}\u201d`).join(", ")}, for the rest of the call, in the full transcript and in the form.
            </Notice>
          )}
        </aside>
        <FormSoFar consultationId={id} templateVersionId={consultation.form_template_version_id} />
        </div>
      )}
      </div>
    </>
  );
}
