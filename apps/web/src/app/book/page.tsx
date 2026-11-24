"use client";

import { ArrowRight, ChevronLeft, Lock } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { PatientShell } from "@/components/patient-shell";
import { FieldError, Notice } from "@/components/status";
import { call, FIELD_MESSAGE } from "@/lib/api";
import { byDay, clockTime, initials, localDay, viewerZone, WEEKDAY_SHORT, zoneName, type PublicPage } from "@/lib/booking";
import { euros } from "@/lib/fee";
import { payment } from "@/lib/payment";
import { useSession } from "@/lib/session";
import { dateTime, LANGUAGE_LABEL, type ConsultationLanguage } from "@/lib/status";

// A patient books a time with one practitioner (design system: ScreenBook, ScreenPhoneBook,
// ScreenPhoneBookDetails). /book/?p=<page> to choose a time; &at=<time> for their details.

type Offer = { practitioner: PublicPage; times: string[] };
const WEEKS_AHEAD = 4;
const DAYS_SHOWN = 14;

export default function BookPage() {
  return (
    <PatientShell>
      <Suspense fallback={<p className="wa-meta" role="status">Opening the times…</p>}><Book /></Suspense>
    </PatientShell>
  );
}

/** "Thu 22 Oct 2026, 11:00–11:45" on the patient's clock. */
const span = (iso: string, minutes: number) => `${dateTime(iso)}–${clockTime(new Date(Date.parse(iso) + minutes * 60_000).toISOString(), viewerZone())}`;

function Book() {
  const params = useSearchParams();
  const slug = params.get("p") ?? "";
  const at = params.get("at");
  const [offer, setOffer] = useState<Offer | "missing" | null>(null);

  useEffect(() => {
    const now = new Date();
    const until = new Date(now.getTime() + WEEKS_AHEAD * 7 * 86_400_000);
    call<Offer>("booking_times", { p_slug: slug, p_from: now.toISOString(), p_to: until.toISOString() })
      .then((answer) => setOffer(answer.ok ? answer : "missing"));
  }, [slug]);
  // One page serves every practitioner, so the tab (and a search result) takes their name once known.
  const name = offer && offer !== "missing" ? offer.practitioner.display_name : null;
  useEffect(() => {
    if (name) document.title = `${name} · Watson`;
  }, [name]);

  if (offer === "missing") {
    return <Notice title="This page does not exist" actions={<Link className="wa-button wa-button--secondary" href="/">Find a practitioner</Link>}>
      Check the link you were given, or find your practitioner in the list.</Notice>;
  }
  if (offer === null) return <p className="wa-meta" role="status">Opening the times…</p>;
  const chosen = at ? offer.times.find((time) => Date.parse(time) === Date.parse(at)) : undefined;
  if (at && !chosen) {
    return <Notice tone="failed" title="This time is no longer free"
      actions={<Link className="wa-button wa-button--primary" href={`/book/?p=${slug}`}>Choose another time</Link>}>
      Someone booked it a moment ago, or it is too soon to book.</Notice>;
  }
  return chosen ? <Details practitioner={offer.practitioner} time={chosen} /> : <Choose offer={offer} />;
}

function Profile({ page }: { page: PublicPage }) {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="wa-person__top" style={{ gridTemplateColumns: "80px minmax(0, 1fr)" }}>
        <span className="wa-monogram wa-monogram--large" aria-hidden>{initials(page.display_name)}</span>
        <div style={{ display: "grid", gap: 4 }}>
          <h1 className="wa-title">{page.display_name}</h1>
          <p className="wa-person__what">{page.offer}</p>
        </div>
      </div>
      <ul className="wa-facts">
        <li>Speaks {page.languages.map((l) => LANGUAGE_LABEL[l]).join(", ")}</li>
        <li>{page.length_minutes} min by video</li>
        <li>{page.fee_cents === null ? "Free" : euros(page.fee_cents)}</li>
      </ul>
      {page.about && <p className="wa-text">{page.about}</p>}
    </div>
  );
}

function Choose({ offer }: { offer: Offer }) {
  const { practitioner: page, times } = offer;
  const zone = viewerZone();
  const days = byDay(times, zone);
  const today = new Date();
  const strip = Array.from({ length: DAYS_SHOWN }, (_, i) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + i));
  const [day, setDay] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const shown = days.get(day) ?? [];

  const how = (
    <section className="wa-aside" aria-labelledby="how">
      <h2 className="wa-heading" id="how" style={{ color: "var(--ink)" }}>How it works</h2>
      <ol>
        <li>Choose a time and give your name and phone number.</li>
        {page.fee_cents !== null && <li>Pay {euros(page.fee_cents)} on Stripe&apos;s secure page.</li>}
        <li>Before the call, send lab results or a list of your medicines if you like.</li>
        <li>At your time, open your link and join the video call.</li>
      </ol>
    </section>
  );
  return (
    <>
      <Link className="wa-crumb" href="/"><ChevronLeft aria-hidden className="wa-icon wa-icon--sm" />All practitioners</Link>
      <div className="wa-split" style={{ gridTemplateColumns: undefined }}>
        <div style={{ display: "grid", gap: 24, alignContent: "start" }}><Profile page={page} /><span className="wa-only-wide">{how}</span></div>
        <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
          <section className="wa-panel" aria-labelledby="choose">
            <div className="wa-panel__head">
              <h2 className="wa-heading" id="choose">Choose a time</h2>
              <span className="wa-meta">Times in your time zone ({zoneName(zone)})</span>
            </div>
            {times.length === 0 ? (
              <p className="wa-text">{page.display_name} is not taking appointments at the moment.</p>
            ) : (
              <>
                <ul className="wa-days" aria-label="Days">
                  {strip.map((date) => {
                    const key = localDay(date.toISOString(), zone);
                    const count = days.get(key)?.length ?? 0;
                    return (
                      <li key={key}>
                        <button type="button" className="wa-day" aria-pressed={key === day} disabled={count === 0}
                          onClick={() => { setDay(key); setChosen(null); }}>
                          {WEEKDAY_SHORT.format(date)}<b>{date.getDate()}</b><small>{count ? `${count} free` : "None"}</small>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {day ? (
                  <div className="wa-times" role="group" aria-label={`Times on ${dateTime(shown[0]).split(",")[0]}`}>
                    {shown.map((time) => (
                      <button key={time} type="button" className="wa-time" aria-pressed={time === chosen} onClick={() => setChosen(time)}>
                        {clockTime(time, zone)}
                      </button>
                    ))}
                  </div>
                ) : <p className="wa-text">Choose an available day to see its times.</p>}
              </>
            )}
          </section>
          {chosen && (
            <div className="wa-approve">
              <div>
                <p className="wa-label" style={{ margin: 0 }}>{span(chosen, page.length_minutes)}</p>
                <p className="wa-meta">{page.fee_cents === null ? "Free" : euros(page.fee_cents)} · video call</p>
              </div>
              <Link className="wa-button wa-button--primary" href={`/book/?p=${page.slug}&at=${encodeURIComponent(chosen)}`}>
                Continue<ArrowRight aria-hidden className="wa-icon wa-icon--sm" />
              </Link>
            </div>
          )}
          <span className="wa-only-narrow">{how}</span>
        </div>
      </div>
    </>
  );
}

function Details({ practitioner: page, time }: { practitioner: PublicPage; time: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [language, setLanguage] = useState<ConsultationLanguage>(page.languages[0]);
  const [remind, setRemind] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ field?: string; message: string } | null>(null);
  // A signed-in patient books with the number or email they verified (owner, 24 Nov: "you have my
  // phone number, and yet you ask for it again"); another one only if they choose to.
  const session = useSession();
  const verified = session.status === "signed-in" && session.roles?.includes("patient")
    ? (session.user.phone ? `+${session.user.phone.replace(/^\+/, "")}` : session.user.email ?? null) : null;
  const [another, setAnother] = useState(false);
  const given = verified && !another ? verified : contact;
  const byPhone = given.trim() !== "" && !given.includes("@");

  async function book() {
    setProblem(null);
    if (!name.trim()) return setProblem({ field: "name", message: FIELD_MESSAGE.name });
    if (!given.trim()) return setProblem({ field: "contact", message: FIELD_MESSAGE.contact });
    setBusy(true);
    const outcome = await call<{ token: string }>("book_time", {
      p_slug: page.slug, p_starts_at: time, p_name: name, p_contact: given, p_language: language, p_remind_whatsapp: byPhone && remind,
    });
    if (!outcome.ok) {
      setBusy(false);
      if (outcome.error_category === "TIME_TAKEN") return setProblem({ message: "Someone booked this time a moment ago. Choose another one." });
      if (outcome.error_category === "BOOKING_LIMIT") {
        return setProblem({ message: "Online booking is full for today. Contact the practice to book a time." });
      }
      if (outcome.error_category === "TOO_MANY_BOOKINGS") {
        return setProblem({ message: "You already have three upcoming times with this practitioner. Ask them directly if you need another." });
      }
      return setProblem({ field: outcome.field, message: (outcome.field && FIELD_MESSAGE[outcome.field]) || "Booking did not work, and nothing was booked. Try again." });
    }
    // With a fee, straight on to Stripe; if that fails, the patient's link offers to pay again.
    const pay = page.fee_cents === null ? null : await payment({ token: outcome.token });
    if (pay?.url) return window.location.assign(pay.url);
    router.push(`/join/?t=${outcome.token}`);
  }

  const error = (field: string) => (problem?.field === field ? problem.message : null);
  return (
    <>
      <Link className="wa-crumb" href={`/book/?p=${page.slug}`}><ChevronLeft aria-hidden className="wa-icon wa-icon--sm" />Change the time</Link>
      <h1 className="wa-title">Your details</h1>
      <div className="wa-ticket">
        <p className="wa-ticket__meta">{page.display_name} · video call</p>
        <p className="wa-ticket__when">{span(time, page.length_minutes)}</p>
        <p className="wa-ticket__meta">{page.fee_cents === null ? "Free" : `${euros(page.fee_cents)}, paid now`}</p>
      </div>
      <form className="wa-form" noValidate style={{ maxWidth: 560 }} onSubmit={(event) => { event.preventDefault(); void book(); }}>
        <div className="wa-field">
          <label className="wa-label" htmlFor="name">Your name</label>
          <input id="name" className="wa-input" autoComplete="name" value={name} aria-invalid={Boolean(error("name"))} aria-describedby="name-error"
            onChange={(e) => setName(e.target.value)} />
          <FieldError id="name-error" message={error("name")} />
        </div>
        {verified && !another ? (
          <div className="wa-field">
            <p className="wa-label" style={{ margin: 0 }}>Phone or email</p>
            <p className="wa-text" style={{ margin: 0 }}><strong>{verified}</strong>, from your account.</p>
            <div className="wa-actions">
              <button type="button" className="wa-button wa-button--quiet wa-button--small" onClick={() => setAnother(true)}>Use another</button>
            </div>
          </div>
        ) : (
          <div className="wa-field">
            <label className="wa-label" htmlFor="contact">Phone or email</label>
            <p className="wa-hint" id="contact-hint">Your practitioner keeps your documents under this. With a phone number, Watson can remind you on WhatsApp.</p>
            <input id="contact" className="wa-input" autoComplete="tel" value={contact} aria-invalid={Boolean(error("contact"))}
              aria-describedby="contact-hint contact-error" onChange={(e) => setContact(e.target.value)} />
            <FieldError id="contact-error" message={error("contact")} />
          </div>
        )}
        <div className="wa-field">
          <label className="wa-label" htmlFor="language">Language for the consultation</label>
          <div className="wa-select">
            <select id="language" value={language} onChange={(e) => setLanguage(e.target.value as ConsultationLanguage)}>
              {page.languages.map((l) => <option key={l} value={l}>{LANGUAGE_LABEL[l]}</option>)}
            </select>
          </div>
        </div>
        {byPhone && (
          <label className="wa-check">
            <input type="checkbox" checked={remind} onChange={(e) => setRemind(e.target.checked)} />
            <span className="wa-check__text">
              <span className="wa-check__label">Remind me on WhatsApp an hour before</span>
              <span className="wa-hint">One message from Watson, with the link to join.</span>
            </span>
          </label>
        )}
        <p className="wa-hint">The call is recorded, with your consent, so Watson can write notes for your practitioner.</p>
        {problem && !problem.field && <Notice tone="failed" title="Not booked"
          actions={<Link className="wa-button wa-button--secondary" href={`/book/?p=${page.slug}`}>Choose another time</Link>}>{problem.message}</Notice>}
        <div className="wa-actions">
          <button type="submit" className="wa-button wa-button--primary" disabled={busy} aria-busy={busy || undefined}>
            {page.fee_cents === null ? "Book this time" : <><Lock aria-hidden className="wa-icon" />Book and pay {euros(page.fee_cents)}</>}
          </button>
        </div>
        {page.fee_cents !== null && (
          <p className="wa-hint">You pay on Stripe&apos;s secure page and come straight back. We keep this time for you for 35 minutes while you pay.</p>
        )}
      </form>
    </>
  );
}
