"use client";

import Link from "next/link";
import { useState } from "react";
import { clockTime, gridBounds, rollingDays, viewerZone, weekdayKey, WEEKDAY_SHORT, WEEKDAYS, type Booking, type Busy, type Hours } from "@/lib/booking";

// The practitioner's week as an appointment book (design system: ScreenCalendar, ScreenPhoneCalendar):
// bookings in ink, open times pencilled in, Google busy time hatched, hours nobody can book sunk.
// Drawn on the viewer's clock. ponytail: hours are drawn as typed, so a practitioner abroad sees
// their bookable band at home times; convert per zone if that ever matters.

type Props = { start: Date; hours: Hours; open: string[]; bookings: Booking[]; busy: Busy[]; now: Date };
/** Times as milliseconds: the database writes "+00:00" and the browser "Z", so strings do not compare. */
type Item = { at: number; ends: number; kind: "booked" | "held" | "busy" | "open"; booking?: Booking };

const plus = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
const hourOf = (ms: number) => { const d = new Date(ms); return d.getHours() + d.getMinutes() / 60; };
const sameDay = (iso: string, day: Date) => new Date(iso).toDateString() === day.toDateString();
const clock = (ms: number, zone: string) => clockTime(new Date(ms).toISOString(), zone);

/** Everything on one day, in time order. Busy time that crosses midnight is cut to the day. */
function itemsOn(day: Date, { open, bookings, busy }: Pick<Props, "open" | "bookings" | "busy">): Item[] {
  const dayStart = day.getTime();
  const dayEnd = plus(day, 1).getTime();
  const items: Item[] = [
    ...bookings.filter((b) => sameDay(b.starts_at, day)).map((b) => {
      const at = Date.parse(b.starts_at);
      return { at, ends: at + b.minutes * 60_000, kind: b.held ? "held" as const : "booked" as const, booking: b };
    }),
    ...busy.map((b) => ({ at: Math.max(dayStart, Date.parse(b.starts_at)), ends: Math.min(dayEnd, Date.parse(b.ends_at)), kind: "busy" as const }))
      .filter((b) => b.at < b.ends),
    ...open.filter((t) => sameDay(t, day)).map((t) => ({ at: Date.parse(t), ends: Date.parse(t), kind: "open" as const })),
  ];
  return items.sort((a, b) => a.at - b.at);
}

function label(item: Item, zone: string, length: number) {
  const from = clock(item.at, zone);
  if (item.booking) {
    const paid = item.booking.paid === null ? "free" : item.booking.paid ? "paid" : "not paid yet";
    return <>{item.booking.who}<span>{from} · {paid}</span></>;
  }
  if (item.kind === "busy") return <>Busy<span>{from}–{clock(item.ends, zone)}</span></>;
  return <>{from}<span className="wa-hidden"> open, {length} minutes</span></>;
}

function Block({ item, top, height, zone, length }: { item: Item; top: number; height: number; zone: string; length: number }) {
  const style = { top: `calc(${top} * var(--hour))`, height: `calc(${height} * var(--hour) - 2px)` };
  const className = `wa-block wa-block--${item.kind}`;
  return item.booking
    ? <Link href={`/consultation/?id=${item.booking.consultation_id}`} className={className} style={style}>{label(item, zone, length)}</Link>
    : <div className={className} style={style}>{label(item, zone, length)}</div>;
}

export function WeekGrid({ start, hours, open, bookings, busy, now, length }: Props & { length: number }) {
  const zone = viewerZone();
  const [first, last] = gridBounds(hours);
  const days = rollingDays(start);
  return (
    <section className="wa-week wa-only-wide" aria-label="Your week">
      <div className="wa-week__corner" aria-hidden />
      {days.map((day, i) => {
        const count = open.filter((t) => sameDay(t, day)).length;
        const past = plus(day, 1) <= now;
        return (
          <div key={i} className="wa-week__head" aria-current={day.toDateString() === now.toDateString() ? "date" : undefined}>
            {WEEKDAY_SHORT.format(day)}<b>{day.getDate()}</b>
            <span>{past ? "Past" : count ? `${count} open` : hours[weekdayKey(day)] ? "Full" : "Not bookable"}</span>
          </div>
        );
      })}
      <div className="wa-week__times" aria-hidden>
        {Array.from({ length: last - first }, (_, h) => <span key={h}>{String(first + h).padStart(2, "0")}:00</span>)}
      </div>
      {days.map((day, i) => {
        const span = hours[weekdayKey(day)];
        const opens = span ? Number(span[0].slice(0, 2)) + Number(span[0].slice(3)) / 60 : 0;
        const closes = span ? Number(span[1].slice(0, 2)) + Number(span[1].slice(3)) / 60 : 0;
        return (
          <div key={i} className="wa-week__day" style={{ height: `calc(${last - first} * var(--hour))` }}>
            {span && <div className="wa-week__open" style={{ top: `calc(${opens - first} * var(--hour))`, height: `calc(${closes - opens} * var(--hour))` }} />}
            {itemsOn(day, { open, bookings, busy }).map((item) => {
              const start = Math.max(first, hourOf(item.at));
              const end = item.kind === "open" ? start + length / 60 : Math.min(last, item.ends === plus(day, 1).getTime() ? 24 : hourOf(item.ends));
              return <Block key={`${item.kind}-${item.at}`} item={item} top={start - first} height={end - start} zone={zone} length={length} />;
            })}
            {day.toDateString() === now.toDateString() && hourOf(now.getTime()) > first && hourOf(now.getTime()) < last && (
              <div className="wa-week__now" style={{ top: `calc(${hourOf(now.getTime()) - first} * var(--hour))` }} aria-hidden />
            )}
          </div>
        );
      })}
    </section>
  );
}

/** On phones: one day at a time, as a list. */
export function DayAgenda({ start, hours, open, bookings, busy, now, length }: Props & { length: number }) {
  const zone = viewerZone();
  const days = rollingDays(start);
  const todayIndex = days.findIndex((day) => day.toDateString() === now.toDateString());
  const [chosen, setChosen] = useState(Math.max(0, todayIndex));
  const items = itemsOn(days[chosen], { open, bookings, busy });
  return (
    <section className="wa-only-narrow" aria-label="Your day" style={{ display: "grid", gap: 16 }}>
      <ul className="wa-days" aria-label="Days">
        {days.map((day, i) => {
          const count = open.filter((t) => sameDay(t, day)).length;
          return (
            <li key={i}>
              <button type="button" className="wa-day" aria-pressed={i === chosen} onClick={() => setChosen(i)}>
                {WEEKDAY_SHORT.format(day)}<b>{day.getDate()}</b><small>{plus(day, 1) <= now ? "Past" : count ? `${count} open` : hours[weekdayKey(day)] ? "Full" : "—"}</small>
              </button>
            </li>
          );
        })}
      </ul>
      {items.length === 0 ? (
        <p className="wa-meta">Nothing on this day.</p>
      ) : (
        <ol className="wa-agenda" aria-label={`${WEEKDAYS[chosen]} ${days[chosen].getDate()}`}>
          {items.map((item) => (
            <li key={`${item.kind}-${item.at}`}>
              <time dateTime={new Date(item.at).toISOString()}>{clock(item.at, zone)}</time>
              {item.booking ? (
                <Link href={`/consultation/?id=${item.booking.consultation_id}`} className={`wa-block wa-block--${item.kind}`}>
                  {item.booking.who}<span>{item.booking.paid === null ? "Free" : item.booking.paid ? "Paid" : "Not paid yet"} · {item.booking.minutes} min</span>
                </Link>
              ) : item.kind === "busy" ? (
                <div className="wa-block wa-block--busy">Busy<span>{clock(item.at, zone)}–{clock(item.ends, zone)} · Google Calendar</span></div>
              ) : (
                <div className="wa-block wa-block--open">Open<span>patients can book · {length} min</span></div>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function WeekKeys() {
  return (
    <ul className="wa-keys" aria-label="What the colours mean">
      <li><span className="wa-block wa-block--booked" />Booked through Watson</li>
      <li><span className="wa-block wa-block--held" />Booked, not paid yet</li>
      <li><span className="wa-block wa-block--open" />Open: patients can book this</li>
      <li><span className="wa-block wa-block--busy" />Busy in your Google Calendar</li>
      <li><span className="wa-key-off" />Outside your hours</li>
    </ul>
  );
}
