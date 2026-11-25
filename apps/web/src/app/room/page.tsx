"use client";

import { ChevronLeft, Video } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { CallControls, CallScreen } from "@/components/call-screen";
import { CopyButton } from "@/components/copy-button";
import { DoctorNotes } from "@/components/doctor-notes";
import { FormSoFar } from "@/components/form-so-far";
import { LiveTranscript } from "@/components/live-transcript";
import { Notice } from "@/components/status";
import { clock } from "@/lib/audio";
import { patientLink, type CallState } from "@/lib/call";
import type { Tables } from "@/lib/database.types";
import { RequireSession } from "@/lib/session";
import { supabase } from "@/lib/supabase";
import { useDoctorCall } from "@/lib/use-doctor-call";

type Consultation = Tables<"consultations"> & { patients: { name: string } | null };
type Loaded = { consultation: Consultation; tracks: number };
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
const nameOf = (consultation: Consultation) => consultation.patients?.name ?? consultation.patient_claim_name ?? consultation.synthetic_patient_ref;

function Room({ userId }: { userId: string }) {
  const id = useSearchParams().get("id") ?? "";
  const [loaded, setLoaded] = useState<Loaded | "missing" | null>(null);
  useEffect(() => {
    let current = true;
    Promise.all([
      supabase.from("consultations").select("*, patients(name)").eq("id", id).maybeSingle(),
      supabase.from("audio_tracks").select("id", { count: "exact", head: true }).eq("consultation_id", id),
    ]).then(([consultation, tracks]) => {
      if (current) setLoaded(consultation.data ? { consultation: consultation.data, tracks: tracks.count ?? 0 } : "missing");
    });
    return () => { current = false; };
  }, [id]);

  const back = (
    <Link href={`/consultation/?id=${id}`} className="wa-crumb"><ChevronLeft aria-hidden className="wa-icon wa-icon--sm" />Consultation</Link>
  );
  if (loaded === null) return <p className="wa-meta" role="status">Loading the call…</p>;
  if (loaded === "missing") return <>{back}<p className="wa-text">This consultation does not exist, or it is not yours.</p></>;
  return <CallRoom loaded={loaded} userId={userId} back={back} />;
}

function CallRoom({ loaded, userId, back }: { loaded: Loaded; userId: string; back: React.ReactNode }) {
  const { consultation } = loaded;
  const call = useDoctorCall(consultation.id, userId);
  const { media, state, live, step, problem, unsaved } = call;
  if (!state && !step && (loaded.tracks > 0 || !CAN_CALL.includes(consultation.status))) {
    return (
      <>{back}
        <h1 className="wa-title">{nameOf(consultation)}</h1>
        <Notice title="This consultation already has audio">A call can be recorded only before any audio is attached.</Notice>
      </>
    );
  }
  const note = state === null ? ["Start the call, then send the patient the link.", ""] as [string, string] : NOTE[state];
  const link = live ? patientLink(consultation.short_code) : null;
  return (
    <>
      {back}
      <div className="wa-pagehead">
        <div className="wa-pagehead__text">
          <h1 className="wa-title">{nameOf(consultation)}</h1>
          <p className="wa-meta">Video call. If the patient agrees, both voices are recorded, with a live transcript beside the video; the full transcript and the form follow when you end the call.</p>
        </div>
      </div>
      <div className="wa-room">
      <div className="wa-call">
        {link && <InviteLink link={link} />}
        <CallScreen remoteVideo={media.remoteVideo} localVideo={media.localVideo} remoteLabel="The patient" selfHidden={state === null}
          note={state !== "connected" ? note ?? null : null}
          badge={live && (call.recording ? <span className="wa-live" role="status">Recording {clock(call.elapsed)}</span>
            : call.declined ? <span className="wa-live wa-live--off" role="status">Not recorded</span> : null)} />
        <CallBar call={call} onStart={() => void call.start(consultation.invite_token)} />
        {step && <p className="wa-meta" role="status" style={{ textAlign: "center" }}>{step}</p>}
        {problem && (
          <Notice tone="failed" title="That did not work" actions={unsaved && (
            <button type="button" className="wa-button wa-button--primary" onClick={() => void call.save(unsaved)}>Try saving again</button>
          )}>
            {problem}
          </Notice>
        )}
        <DoctorNotes consultationId={consultation.id} editable look="side" />
      </div>
      {state !== null && (
        <div className="wa-room__side">
          <LiveTranscript consultationId={consultation.id} recording={call.recording} declined={call.declined}
            patientName={consultation.patients?.name ?? consultation.patient_claim_name ?? "Patient"} />
          <FormSoFar consultationId={consultation.id} templateVersionId={consultation.form_template_version_id} />
        </div>
      )}
      </div>
    </>
  );
}

function InviteLink({ link }: { link: string }) {
  return (
    <div className="wa-field">
      <label className="wa-label" htmlFor="invite">Send this link to the patient</label>
      <div className="wa-invite">
        <input id="invite" className="wa-input" readOnly value={link} onFocus={(event) => event.target.select()} />
        <CopyButton text={link} />
      </div>
    </div>
  );
}

/** Start the call; during it, mute, the camera and ending it; nothing while it ends or saves. */
function CallBar({ call, onStart }: { call: ReturnType<typeof useDoctorCall>; onStart: () => void }) {
  const { media, state, live, step } = call;
  return (
    <div className="wa-call__bar">
      {state === null && !step ? (
        <button type="button" className="wa-button wa-button--primary" onClick={onStart}>
          <Video aria-hidden className="wa-icon" />Start video call
        </button>
      ) : live && !step ? (
        <CallControls muted={media.muted} cameraOff={media.cameraOff} onToggle={media.toggle} onEnd={() => void call.end()} endLabel="End call" />
      ) : null}
    </div>
  );
}
