"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { PatientCall, PayStep, type Details } from "@/components/join-parts";
import { PatientDocuments } from "@/components/patient-documents";
import { PatientReport } from "@/components/patient-report";
import { Notice } from "@/components/status";
import { call } from "@/lib/api";
import { payment } from "@/lib/payment";
import { dateTime } from "@/lib/status";

/** Where a patient joins a call from the doctor's link. No account, no sign-in. */
export default function JoinPage() {
  return (
    <>
      <header className="wa-header">
        <div className="wa-header__inner"><Link href="/" className="wa-wordmark" aria-label="Watson, find a practitioner">Watson</Link></div>
      </header>
      <main className="wa-page">
        <Suspense fallback={<p className="wa-meta" role="status">Opening the call…</p>}>
          <Join />
        </Suspense>
      </main>
    </>
  );
}

const TOKEN = /^[0-9a-f]{64}$/;

/** What the patient's link may know (invite_details), their answer to recording, and their report once approved. */
async function fetchDetails(token: string): Promise<Details | "missing"> {
  const [result, question, copy] = await Promise.all([
    call<Omit<Details, "practitioner" | "recording" | "report">>("invite_details", { p_token: token }),
    call<Pick<Details, "practitioner" | "recording">>("recording_question", { p_token: token }),
    call<Pick<Details, "report">>("patient_report", { p_token: token }),
  ]);
  return result.ok && question.ok
    ? { ...result, practitioner: question.practitioner, recording: question.recording, report: copy.ok ? copy.report : null } : "missing";
}

function Join() {
  const params = useSearchParams();
  const token = params.get("t") ?? "";
  const returning = params.get("session_id");
  const cancelled = params.get("cancelled") === "1";
  const [details, setDetails] = useState<Details | "missing" | null>(null);
  const refresh = useCallback(() => void fetchDetails(token).then(setDetails), [token]);

  useEffect(() => {
    if (!TOKEN.test(token)) return;
    let alive = true;
    // Back from Stripe: confirm the payment before reading the state.
    const confirmed = returning ? payment({ token, session_id: returning }) : Promise.resolve(null);
    confirmed.then(() => fetchDetails(token)).then((result) => alive && setDetails(result));
    return () => { alive = false; };
  }, [token, returning]);

  if (!TOKEN.test(token) || details === "missing") {
    return <Notice title="This link is not complete">Ask your practitioner to send it again.</Notice>;
  }
  if (details === null) return <p className="wa-meta" role="status">{returning ? "Checking your payment…" : "Opening your consultation…"}</p>;
  const mustPay = details.fee_cents !== null && !details.paid;
  const answered = (agree: boolean) => setDetails({ ...details, recording: agree ? "agreed" : "declined" });

  return (
    <>
      <div className="wa-pagehead__text">
        <h1 className="wa-title">Your consultation</h1>
        <p className="wa-meta">{dateTime(details.scheduled_at)} · a video call with your practitioner.</p>
      </div>
      {details.report ? <PatientReport token={token} report={details.report} cancelled={cancelled} />
        : mustPay ? <PayStep token={token} details={details} cancelled={cancelled} returning={Boolean(returning)} />
        : <PatientCall token={token} details={details} onAnswered={answered} />}
      <PatientDocuments token={token} whatsappCode={details.whatsapp_code} patient={details.patient} documents={details.documents}
        onChanged={refresh} />
    </>
  );
}
