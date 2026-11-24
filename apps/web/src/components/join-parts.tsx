"use client";

import { Lock, Video } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { CallControls, CallScreen } from "@/components/call-screen";
import type { SentDocument } from "@/components/patient-documents";
import type { Report } from "@/components/patient-report";
import { Notice } from "@/components/status";
import { call, explain } from "@/lib/api";
import type { CallState } from "@/lib/call";
import { euros } from "@/lib/fee";
import { payment } from "@/lib/payment";
import { dateTime } from "@/lib/status";
import { usePatientCall } from "@/lib/use-patient-call";

export type Details = {
  scheduled_at: string; fee_cents: number | null; paid: boolean; paid_at: string | null;
  patient: { name: string; contact: string } | null; documents: SentDocument[]; whatsapp_code: string;
  booked_from: string | null;
  /** Who records the call, and what the patient answered: "agreed", "declined", or not yet. */
  practitioner: string | null; recording: "agreed" | "declined" | null;
  /** Once the practitioner approved the form: the report and the prescriptions (owner, 23 Nov). */
  report: Report | null;
};

/** The consultation's fee, paid on Stripe's page before the call. */
export function PayStep({ token, details, cancelled, returning }: { token: string; details: Details; cancelled: boolean; returning: boolean }) {
  const [paying, setPaying] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [taken, setTaken] = useState(false);
  async function pay() {
    setPaying(true);
    setProblem(null);
    const answer = await payment({ token });
    if (answer?.url) return window.location.assign(answer.url);
    setPaying(false);
    if (answer?.error === "TIME_TAKEN") setTaken(true);
    else setProblem("Payment is not available right now. Try again in a moment.");
  }
  return (
    <>
      {cancelled && !taken && <Notice title="The payment was not completed">Nothing was charged. You can try again.</Notice>}
      {taken && (
        <Notice tone="failed" title="This time was given to another patient"
          actions={details.booked_from ? <Link className="wa-button wa-button--primary" href={`/book/?p=${details.booked_from}`}>Choose another time</Link> : undefined}>
          It was not paid within 35 minutes of booking, so it was free again. Nothing was charged.
        </Notice>
      )}
      {returning && <Notice tone="attention" title="Your payment is not confirmed yet">If you paid, reload this page in a moment.</Notice>}
      <div className="wa-fee">
        <p className="wa-meta" style={{ margin: 0 }}>Consultation fee</p>
        <p className="wa-fee__amount">{euros(details.fee_cents ?? 0)}</p>
      </div>
      <div className="wa-actions">
        <button type="button" className="wa-button wa-button--primary" disabled={paying} aria-busy={paying || undefined} onClick={pay}>
          <Lock aria-hidden className="wa-icon" />{paying ? "Opening Stripe…" : `Pay ${euros(details.fee_cents ?? 0)}`}
        </button>
      </div>
      <p className="wa-hint">You pay on Stripe&apos;s secure page and come straight back here. Watson never sees your card.</p>
      {problem && <Notice tone="failed" title="Could not start the payment">{problem}</Notice>}
    </>
  );
}

const NOTE: Partial<Record<CallState, string>> = {
  joining: "Opening the call…",
  waiting: "Waiting for your practitioner…",
  connecting: "Connecting…",
  reconnecting: "The connection dropped. Reconnecting…",
};

/** The call on the patient's side: their answer to recording first (owner, 23 Nov), then the call. */
export function PatientCall({ token, details, onAnswered }: { token: string; details: Details; onAnswered: (agree: boolean) => void }) {
  const { media, state, problem, setProblem, join, leave } = usePatientCall(token);
  const [asking, setAsking] = useState(false); // changing their answer to recording
  const live = state !== null && state !== "ended";

  // The patient's own answer, before they join. Either way, they join.
  async function answer(agree: boolean) {
    setProblem(null);
    const outcome = await call("patient_recording_choice", { p_token: token, p_agree: agree });
    if (!outcome.ok) return setProblem(explain(outcome.error_category));
    onAnswered(agree);
    setAsking(false);
    await join();
  }

  return (
    <>
      {details.paid && state === null && (
        <Notice title="Paid. Thank you.">
          {euros(details.fee_cents ?? 0)}{details.paid_at ? ` on ${dateTime(details.paid_at)}` : ""}. Stripe emails you a receipt.
        </Notice>
      )}
      {state === null && (details.recording === null || asking) && <RecordingQuestion practitioner={details.practitioner} onAnswer={(agree) => void answer(agree)} />}
      {state === null && details.recording !== null && !asking && (
        <p className="wa-meta" style={{ margin: 0 }}>
          {details.recording === "agreed" ? "You agreed to this call being recorded." : "This call will not be recorded."}{" "}
          <button type="button" className="wa-button wa-button--quiet wa-button--small" onClick={() => setAsking(true)}>Change your answer</button>
        </p>
      )}
      <div className="wa-call">
        <CallScreen remoteVideo={media.remoteVideo} localVideo={media.localVideo} remoteLabel="Your practitioner" selfHidden={state === null}
          note={state === "connected" ? null : [state === null ? "Turn on your camera and microphone to join."
            : state === "ended" ? "The consultation has ended. You can close this page." : NOTE[state] ?? ""]}
          badge={state === "connected" && (details.recording === "agreed"
            ? <span className="wa-live" role="status">Recorded</span>
            : <span className="wa-live wa-live--off" role="status">Not recorded</span>)} />
        <div className="wa-call__bar">
          {state === null ? details.recording !== null && !asking && (
            <button type="button" className="wa-button wa-button--primary" onClick={() => void join()}>
              <Video aria-hidden className="wa-icon" />Join the call
            </button>
          ) : live ? (
            <CallControls muted={media.muted} cameraOff={media.cameraOff} onToggle={media.toggle} onEnd={() => void leave()} endLabel="Leave" />
          ) : null}
        </div>
        {problem && <Notice tone="failed" title="Could not join">{problem}</Notice>}
      </div>
    </>
  );
}

function RecordingQuestion({ practitioner, onAnswer }: { practitioner: string | null; onAnswer: (agree: boolean) => void }) {
  return (
    <section className="wa-panel" aria-labelledby="recording-title">
      <h2 className="wa-heading" id="recording-title">Before you join</h2>
      <p className="wa-text">{practitioner ?? "Your practitioner"} records this call, so Watson can write the notes of your consultation.</p>
      <ul className="wa-text" style={{ margin: 0, paddingLeft: "1.2em", listStyle: "disc" }}>
        <li>Your voice is recorded and written down.</li>
        <li>Only {practitioner ?? "your practitioner"} sees it.</li>
        <li>Until the notes are approved, you can ask for the recording to be deleted.</li>
      </ul>
      <div className="wa-actions">
        <button type="button" className="wa-button wa-button--primary" onClick={() => onAnswer(true)}>
          <Video aria-hidden className="wa-icon" />I agree, join the call
        </button>
        <button type="button" className="wa-button wa-button--secondary" onClick={() => onAnswer(false)}>Join without recording</button>
      </div>
      <p className="wa-hint"><Link href="/privacy/">How Watson keeps your information</Link></p>
    </section>
  );
}
