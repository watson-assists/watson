"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { call as rpc } from "./api";
import { connect, recordCall, type CallState, type Recording } from "./call";
import { livePieceSender } from "./live";
import { supabase } from "./supabase";
import { attachAudio } from "./tracks";
import { useCallMedia } from "./use-call-media";
import { useLeaveGuard } from "./use-leave-guard";

/**
 * The doctor's side of a video call: start it, record both voices once the patient agrees on their
 * link (owner, 23 Nov), and at the end save the recording and start the transcript.
 */
export function useDoctorCall(consultationId: string, userId: string) {
  const router = useRouter();
  const media = useCallMedia();
  const [state, setState] = useState<CallState | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [unsaved, setUnsaved] = useState<Recording | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [recording, setRecording] = useState(false);
  const [declined, setDeclined] = useState(false); // the patient chose not to be recorded
  const session = useRef<{ leave(): Promise<void> } | null>(null);
  const recorder = useRef<ReturnType<typeof recordCall> | null>(null);
  const live = state !== null && state !== "ended";

  useEffect(() => {
    if (!live) return;
    const tick = setInterval(() => setElapsed(recorder.current?.seconds ?? 0), 1000);
    return () => clearInterval(tick);
  }, [live]);
  // Leaving the page mid-call would lose the recording.
  useLeaveGuard(live, "Leave the call? It ends, and what was recorded so far is not saved. To keep it, stay and press End call.");
  useEffect(() => () => void session.current?.leave(), []);

  const patientAgreed = async () => {
    const { data } = await supabase.from("consultations").select("patient_recording").eq("id", consultationId).maybeSingle();
    return data?.patient_recording === "agreed";
  };
  const toConsultation = () => router.push(`/consultation/?id=${consultationId}`);

  /** Starts the call on the link the patient already has. */
  async function start(inviteToken: string) {
    setProblem(null);
    const local = await media.open();
    if (!local) return setProblem("The camera or microphone is not available. Allow them in your browser, then try again.");
    const recorded = recordCall(local, livePieceSender(userId, consultationId));
    recorder.current = recorded;
    session.current = connect({
      consultationId, token: inviteToken, role: "doctor", local,
      onRemote: (remote) => {
        media.showRemote(remote);
        recorded.addPatient(remote);
      },
      onState: (next) => {
        setState(next);
        // Recording starts only once the patient has agreed, on their link (owner, 23 Nov).
        if (next === "connected") void patientAgreed().then((agreed) => {
          setDeclined(!agreed);
          if (!agreed) return;
          recorded.start();
          setRecording(true);
        });
      },
    });
  }

  async function save(saved: Recording) {
    setProblem(null);
    for (const speaker of ["practitioner", "patient"] as const) {
      const failure = await attachAudio({
        consultationId, userId, speaker, blob: saved[speaker], format: saved.format, seconds: saved.seconds, onStep: setStep,
      });
      if (failure) {
        setStep(null);
        setUnsaved(saved);
        return setProblem(failure);
      }
    }
    setStep("Starting transcription…");
    await rpc("declare_recorded_together", { p_consultation_id: consultationId, p_recorded_together: true });
    await rpc("start_transcription", { p_consultation_id: consultationId });
    toConsultation();
  }

  async function end() {
    setStep("Ending the call…");
    await session.current?.leave();
    session.current = null;
    media.stop();
    const saved = await recorder.current?.stop();
    if (saved) return save(saved);
    toConsultation();
  }

  return { media, state, live, step, problem, unsaved, elapsed, recording, declined, start, end, save };
}
