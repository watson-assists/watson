"use client";

import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { ConsultationHead } from "@/components/consultation-head";
import { PatientHistory, PreviousAppointmentSelector, PreviousValues } from "@/components/consultation-history";
import { AudioSummary, NextStep } from "@/components/consultation-steps";
import { DoctorNotes } from "@/components/doctor-notes";
import { DocumentsPanel } from "@/components/documents-panel";
import { FormPanel } from "@/components/form-panel";
import { JobPanel } from "@/components/job-panel";
import { PatientCheck } from "@/components/patient-check";
import { PatientPanel } from "@/components/patient-panel";
import { Journey, Notice } from "@/components/status";
import { TranscriptView } from "@/components/transcript-view";
import { WhatsAppPanel } from "@/components/whatsapp-panel";
import { call, isId } from "@/lib/api";
import { fetchConsultation, FORM_STATUSES, HAS_TRANSCRIPT, SPEAKERS, stepLines, type Loaded } from "@/lib/consultation-page";
import { RequireSession } from "@/lib/session";
import { LANGUAGE_LABEL } from "@/lib/status";
import { supabase } from "@/lib/supabase";
import { useAction } from "@/lib/use-action";

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

function ConsultationView({ userId }: { userId: string }) {
  const id = useSearchParams().get("id") ?? "";
  const [loaded, setLoaded] = useState<Loaded | "missing" | "failed" | null>(null);
  const load = useCallback(() => void fetchConsultation(id, userId).then(setLoaded), [id, userId]);
  useEffect(() => {
    if (!isId(id)) return;
    let current = true;
    fetchConsultation(id, userId).then((result) => current && setLoaded(result));
    return () => { current = false; };
  }, [id, userId]);

  if (!isId(id) || loaded === "missing") {
    return <>{back}<p className="wa-text">This consultation does not exist, or it is not yours.</p></>;
  }
  if (loaded === "failed") {
    return <>{back}<Notice tone="failed" title="The consultation could not be loaded">Check your connection and reload the page.</Notice></>;
  }
  if (loaded === null) return <p className="wa-meta" role="status">Loading the consultation…</p>;
  return <ConsultationScreen loaded={loaded} userId={userId} reload={load} />;
}

function ConsultationScreen({ loaded, userId, reload }: { loaded: Loaded; userId: string; reload: () => void }) {
  const { consultation, tracks, hasTranscript, patient, shown, candidate, history, previousContext } = loaded;
  const status = consultation.status;
  const { busy, setBusy, problem, setProblem, run } = useAction();
  const router = useRouter();
  const unrecorded = ["consent_pending", "ready_for_audio"].includes(status) && tracks.length === 0;
  const open = !["consent_withdrawn", "archived"].includes(status);
  const ids = { p_consultation_id: consultation.id };

  // The steps that run more than one call: busy throughout, reloaded after.
  const steps = async (work: () => Promise<boolean>) => {
    setBusy(true);
    const ok = await work();
    setBusy(false);
    reload();
    return ok;
  };
  const deleteAudio = async () => {
    await supabase.storage.from("audio").remove(SPEAKERS.map((speaker) => `${userId}/${consultation.id}/${speaker}`));
    await call("confirm_audio_deleted", ids);
    return true;
  };
  const reloaded = async (name: Parameters<typeof run>[0], args: object, messages?: Record<string, string>) => {
    const outcome = await run(name, args, messages);
    reload();
    return outcome;
  };
  const actions = {
    busy,
    // A call whose upload stopped half way: drop what arrived, so the call can be made again.
    discardPartial: () => void steps(async () => {
      for (const track of tracks) if (!(await run("remove_audio_track", { ...ids, p_speaker: track.speaker }))) return false;
      return true;
    }),
    startTranscription: () => void reloaded("start_transcription", ids),
    recordConsent: () => void reloaded("record_consent", ids),
    withoutRecording: (byWatson: boolean) => void reloaded("start_form_without_recording", { ...ids, p_by_watson: byWatson },
      { NOTHING_TO_FILL: "Write your notes first, or add the patient’s documents: Watson fills in the form from them." })
      .then((outcome) => outcome && !byWatson && router.push(`/form/?id=${consultation.id}`)),
    deleteAudio: () => void steps(deleteAudio),
  };
  const notes = <DoctorNotes key={status} consultationId={consultation.id} editable={!["approved", "corrected"].includes(status)} />;

  return (
    <>
      {back}
      <ConsultationHead loaded={loaded} busy={busy} onChanged={reload}
        onWithdraw={() => steps(async () => Boolean(await run("withdraw_consent", ids)) && deleteAudio())}
        onArchive={() => steps(async () => Boolean(await run("archive_consultation", ids)))} />
      {status === "archived" ? (
        <Notice title="Archived">This consultation is kept for review, but no further work or patient messages can be started from it.</Notice>
      ) : <Journey status={status} lines={stepLines(loaded)} />}
      {problem && <Notice tone="failed" title="That did not work">{problem}</Notice>}
      <NextStep loaded={loaded} actions={actions} notes={notes} />
      {(status === "transcription_processing" || status === "transcription_failed") && (
        <JobPanel consultationId={consultation.id} status={status} onChanged={reload} />
      )}
      {FORM_STATUSES.includes(status) && <FormPanel consultationId={consultation.id} status={status} onChanged={reload} />}
      {!unrecorded && open && notes}
      {shown?.check && <PatientCheck consultationId={consultation.id} shown={shown} candidate={candidate} onChanged={reload} />}
      {open && <PatientPanel consultation={consultation} patient={shown} onChanged={reload} />}
      <PreviousAppointmentSelector key={consultation.previous_consultation_id ?? "unlinked"}
        consultation={consultation} history={history} onChanged={reload} onProblem={setProblem} />
      {previousContext && <PreviousValues context={previousContext} />}
      <PatientHistory history={history} />
      {open && <DocumentsPanel consultationId={consultation.id} patient={patient} person={shown} onChanged={reload} />}
      {status !== "archived" && <WhatsAppPanel consultationId={consultation.id} />}
      {HAS_TRANSCRIPT.includes(status) && hasTranscript && (
        <TranscriptView consultationId={consultation.id} language={LANGUAGE_LABEL[consultation.language]}
          editable={!["approved", "corrected", "archived"].includes(status)} />
      )}
      {(status === "transcription_processing" || HAS_TRANSCRIPT.includes(status)) && tracks.length > 0 && <AudioSummary loaded={loaded} />}
    </>
  );
}
