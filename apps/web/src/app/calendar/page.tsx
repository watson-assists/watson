"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { BookingSettings } from "@/components/booking-settings";
import { GoogleConnect, GoogleLine, GooglePanel } from "@/components/google-calendar";
import { GOOGLE_CALENDAR } from "@/lib/features";
import { Notice } from "@/components/status";
import { DayAgenda, WeekGrid, WeekKeys } from "@/components/week-grid";
import { FormTemplateSettings } from "@/components/form-template-settings";
import type { Week } from "@/lib/booking";
import { RequireSession } from "@/lib/session";
import { call } from "@/lib/api";

export default function CalendarPage() {
  return (
    <RequireSession>
      {(user) => <AppShell user={user}><Suspense><Calendar /></Suspense></AppShell>}
    </RequireSession>
  );
}

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" });
const plusDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

/** Back from Google's consent screen, the edge function says how it went. */
const RETURN: Record<string, { tone: "neutral" | "failed"; title: string; text: string }> = {
  connected: { tone: "neutral", title: "Google Calendar connected", text: "Patients now see only the times you are free." },
  refused: { tone: "failed", title: "Google Calendar not connected", text: "Google did not give Watson access. Try again, and allow Watson to see when you are free." },
  failed: { tone: "failed", title: "Google Calendar not connected", text: "Something went wrong on the way back from Google. Try again." },
};

function Calendar() {
  const back = RETURN[useSearchParams().get("google") ?? ""];
  const [start, setStart] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()));
  const [week, setWeek] = useState<Week | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(() => {
    call<Week>("calendar_week", { p_from: start.toISOString(), p_to: plusDays(start, 8).toISOString() }).then((answer) => {
      setNow(new Date());
      if (answer.ok) setWeek(answer);
      else setFailed(true);
    });
  }, [start]);
  useEffect(load, [load]);

  if (failed) return <Notice tone="failed" title="Your calendar could not be loaded">Check your connection and reload the page.</Notice>;
  if (!week) return <p className="wa-meta" role="status">Opening your calendar…</p>;

  const hours = week.page?.hours ?? {};
  const length = week.page?.length_minutes ?? 45;
  const parts = { start, hours, open: week.open, bookings: week.bookings, busy: week.busy, now, length };
  return (
    <>
      <div className="wa-pagehead">
        <div className="wa-pagehead__text">
          <h1 className="wa-title">Practice</h1>
          <p className="wa-meta">
            {DAY.format(start)}–{DAY.format(plusDays(start, 7))} · {week.open.length === 1 ? "one time" : `${week.open.length} times`} open for booking
            · {week.bookings.length} booked
          </p>
        </div>
        <div className="wa-actions">
          <button type="button" className="wa-button wa-button--secondary wa-button--small" aria-label="Previous 8 days"
            onClick={() => setStart(plusDays(start, -8))}><ChevronLeft aria-hidden className="wa-icon wa-icon--sm" /></button>
          <button type="button" className="wa-button wa-button--secondary wa-button--small" onClick={() => setStart(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()))}>Today</button>
          <button type="button" className="wa-button wa-button--secondary wa-button--small" aria-label="Next 8 days"
            onClick={() => setStart(plusDays(start, 8))}><ChevronRight aria-hidden className="wa-icon wa-icon--sm" /></button>
        </div>
      </div>
      {back && <Notice tone={back.tone} title={back.title}>{back.text}</Notice>}
      {week.google ? <GoogleLine link={week.google} onChecked={load} /> : GOOGLE_CALENDAR && <GoogleConnect />}
      {!week.page && (
        <Notice title="Patients cannot book you yet">Choose the hours patients can book and fill in your page below, then save.</Notice>
      )}
      <WeekGrid {...parts} />
      <DayAgenda {...parts} />
      <WeekKeys />
      <FormTemplateSettings />
      <BookingSettings page={week.page} quietSave={GOOGLE_CALENDAR && !week.google} onSaved={load}
        aside={week.google ? <GooglePanel onDisconnected={load} /> : undefined} />
    </>
  );
}
