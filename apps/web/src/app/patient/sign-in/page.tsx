"use client";

import { CircleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Notice } from "@/components/status";
import { useSession } from "@/lib/session";
import { supabase } from "@/lib/supabase";

const RESEND_WAIT_SECONDS = 60;
// The patient picks how the code comes: by email, or by WhatsApp (owner, 24 and 28 Oct: both, never forced).
type Channel = "email" | "whatsapp";
const PHONE = /^\+[1-9][0-9]{6,14}$/;
const normalPhone = (typed: string) => typed.trim().replace(/^00/, "+").replace(/[^0-9+]/g, "");

export default function PatientSignIn() {
  const session = useSession();
  const router = useRouter();
  const [channel, setChannel] = useState<Channel>("email");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (session.status === "signed-in" && session.roles?.includes("patient")) router.replace("/patient/");
  }, [session, router]);

  useEffect(() => {
    if (sentAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [sentAt]);

  const resendIn = sentAt === null
    ? 0
    : Math.max(0, RESEND_WAIT_SECONDS - Math.floor((now - sentAt) / 1000));

  /** Where the code goes, as the patient-otp function takes it. */
  const contact = () => (channel === "email" ? { email } : { phone });

  async function requestCode() {
    setFailure(null);
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPhone = normalPhone(phone);
    if (channel === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      setFailure("Enter a valid email address.");
      return;
    }
    if (channel === "whatsapp" && !PHONE.test(normalizedPhone)) {
      setFailure("Enter your WhatsApp number with its country code, like +421 900 123 456.");
      return;
    }
    if (resendIn > 0) return;

    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke<{ ok: boolean }>("patient-otp", {
        body: { action: "send", ...(channel === "email" ? { email: normalizedEmail } : { phone: normalizedPhone }) },
      });
      if (error || !data?.ok) throw error ?? new Error("OTP send failed");
      setEmail(normalizedEmail);
      setPhone(normalizedPhone);
      setSent(true);
      setSentAt(Date.now());
    } catch {
      setFailure(channel === "email"
        ? "We couldn’t send a code right now. Check the address and try again shortly."
        : "We couldn’t send a code right now. Check the number and try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    if (!/^\d{8}$/.test(code)) {
      setFailure(`Enter the eight-digit code from your ${channel === "email" ? "email" : "WhatsApp"}.`);
      return;
    }

    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke<{
        ok: boolean;
        session?: { access_token: string; refresh_token: string };
      }>("patient-otp", { body: { action: "verify", ...contact(), code } });
      if (error || !data?.ok || !data.session) throw error ?? new Error("OTP verification failed");
      const { error: sessionError } = await supabase.auth.setSession(data.session);
      if (sessionError) throw sessionError;
      router.replace("/patient/");
    } catch {
      setFailure("That code is invalid or has expired. Request a new code and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="wa-night">
      <div className="wa-door">
        <header className="wa-door__head">
          <Link href="/" className="wa-wordmark" aria-label="Watson home">Watson</Link>
          <h1 className="wa-door__title">Your care, kept together.</h1>
          <p className="wa-door__lead">Sign in with a code sent to your email or your WhatsApp. No password needed.</p>
        </header>

        <section className="wa-panel wa-door__card" aria-labelledby="patient-sign-in-title">
          <h2 id="patient-sign-in-title" className="wa-heading">Patient sign-in</h2>
          {!sent ? (
            <AskForCode channel={channel} email={email} phone={phone} failure={failure} busy={busy}
              onChannel={(option) => { setChannel(option); setFailure(null); }} onEmail={setEmail} onPhone={setPhone} onSubmit={() => void requestCode()} />
          ) : (
            <EnterCode channel={channel} sentTo={channel === "email" ? email : phone} code={code} failure={failure} busy={busy} resendIn={resendIn}
              onCode={setCode} onSubmit={verifyCode} onResend={() => void requestCode()}
              onStartAgain={() => { setSent(false); setCode(""); setSentAt(null); setFailure(null); }} />
          )}
          <p className="wa-hint">Are you a practitioner? <Link href="/sign-in/">Sign in here</Link>.</p>
        </section>
      </div>
    </main>
  );
}

/** The first step: how the code comes, and where to. */
function AskForCode({ channel, email, phone, failure, busy, onChannel, onEmail, onPhone, onSubmit }: {
  channel: Channel; email: string; phone: string; failure: string | null; busy: boolean;
  onChannel: (channel: Channel) => void; onEmail: (email: string) => void; onPhone: (phone: string) => void; onSubmit: () => void;
}) {
  return (
    <form onSubmit={(event) => { event.preventDefault(); onSubmit(); }} noValidate className="wa-form" style={{ gap: 16 }}>
      <fieldset className="wa-field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="wa-label">Send my code by</legend>
        <div className="wa-actions" role="radiogroup">
          {(["email", "whatsapp"] as const).map((option) => (
            <button key={option} type="button" role="radio" aria-checked={channel === option}
              className={`wa-button ${channel === option ? "wa-button--primary" : "wa-button--secondary"}`}
              onClick={() => onChannel(option)}>
              {option === "email" ? "Email" : "WhatsApp"}
            </button>
          ))}
        </div>
      </fieldset>
      {channel === "email" ? (
        <div className="wa-field">
          <label className="wa-label" htmlFor="patient-email">Email address</label>
          <input id="patient-email" type="email" autoComplete="email" inputMode="email"
            autoCapitalize="none" spellCheck={false} className="wa-input" required
            value={email} onChange={(event) => onEmail(event.target.value)} />
        </div>
      ) : (
        <div className="wa-field">
          <label className="wa-label" htmlFor="patient-phone">WhatsApp number</label>
          <input id="patient-phone" type="tel" autoComplete="tel" inputMode="tel" className="wa-input" required
            aria-describedby="patient-phone-hint" value={phone} onChange={(event) => onPhone(event.target.value)} />
          <p id="patient-phone-hint" className="wa-hint">With the country code, like +421 900 123 456.</p>
        </div>
      )}
      {failure && <Notice tone="failed" title="Code not sent"><CircleAlert aria-hidden className="wa-icon" />{failure}</Notice>}
      <button type="submit" className="wa-button wa-button--primary" disabled={busy} aria-busy={busy || undefined}>
        {busy ? "Sending code…" : channel === "email" ? "Email me a code" : "Send me a code on WhatsApp"}
      </button>
    </form>
  );
}

/** The second step: the eight-digit code, another one, or another address. */
function EnterCode({ channel, sentTo, code, failure, busy, resendIn, onCode, onSubmit, onResend, onStartAgain }: {
  channel: Channel; sentTo: string; code: string; failure: string | null; busy: boolean; resendIn: number;
  onCode: (code: string) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onResend: () => void; onStartAgain: () => void;
}) {
  return (
    <form onSubmit={onSubmit} noValidate className="wa-form" style={{ gap: 16 }}>
      <p className="wa-hint">A code is on its way to <strong>{sentTo}</strong>{channel === "whatsapp" && " on WhatsApp"}. It expires in 10 minutes.</p>
      <div className="wa-field">
        <label className="wa-label" htmlFor="patient-code">Eight-digit code</label>
        <input id="patient-code" type="text" inputMode="numeric" autoComplete="one-time-code"
          pattern="[0-9]{8}" maxLength={8} className="wa-input wa-mono" required
          aria-describedby="patient-code-hint" value={code}
          onChange={(event) => onCode(event.target.value.replace(/\D/g, "").slice(0, 8))} />
        <p id="patient-code-hint" className="wa-hint">
          {channel === "email" ? "Check your inbox and spam folder." : "It comes from Watson\u2019s WhatsApp number."}
        </p>
      </div>
      {failure && <Notice tone="failed" title="Couldn’t sign in"><CircleAlert aria-hidden className="wa-icon" />{failure}</Notice>}
      <button type="submit" className="wa-button wa-button--primary" disabled={busy} aria-busy={busy || undefined}>
        {busy ? "Checking code…" : "Verify and sign in"}
      </button>
      <button type="button" className="wa-button wa-button--secondary" disabled={busy || resendIn > 0}
        onClick={onResend}>
        {resendIn > 0 ? `Send another code in ${resendIn}s` : "Send another code"}
      </button>
      <button type="button" className="wa-button wa-button--secondary" disabled={busy}
        onClick={onStartAgain}>
        {channel === "email" ? "Use a different email" : "Use a different number"}
      </button>
    </form>
  );
}
