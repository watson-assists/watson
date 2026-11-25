import Link from "next/link";
import { PatientShell } from "@/components/patient-shell";

/** An address that does not exist: a plain way back, for patients and doctors alike. */
export default function NotFound() {
  return (
    <PatientShell>
      <h1 className="wa-title">This page does not exist</h1>
      <p className="wa-text">The address may be mistyped, or the link may be old. If a practitioner sent it, ask them to send it again.</p>
      <div className="wa-actions">
        <Link href="/" className="wa-button wa-button--primary">Find a practitioner</Link>
        <Link href="/consultations/" className="wa-button wa-button--secondary">Your consultations</Link>
      </div>
    </PatientShell>
  );
}
