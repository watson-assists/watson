// Booking: what the booking pages and the calendar share. Open times come from the database
// (private.open_times); this file only shows them on the practitioner's clock.
import type { ConsultationLanguage } from "./status";

/** Bookable hours per ISO weekday, "1" Monday to "7" Sunday: {"1": ["09:00", "17:00"]}. */
export type Hours = Partial<Record<string, [string, string]>>;

/** What a patient sees of a practitioner's page (private.public_page). */
export type PublicPage = {
  slug: string; display_name: string; offer: string; about: string; languages: ConsultationLanguage[];
  length_minutes: number; fee_cents: number | null; time_zone: string;
};
/** The practitioner's own view of their page (calendar_week). */
export type OwnPage = PublicPage & { hours: Hours; gap_minutes: number };
export type Busy = { starts_at: string; ends_at: string };
export type GoogleLink = { email: string; connected_at: string; checked_at: string | null; problem: string | null };
/** A consultation that takes its time; paid is null for a free one, held while an unpaid booking waits. */
export type Booking = { consultation_id: string; starts_at: string; minutes: number; who: string; paid: boolean | null; held: boolean };
export type Week = { page: OwnPage | null; open: string[]; bookings: Booking[]; busy: Busy[]; google: GoogleLink | null };

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
/** "Mon", on the viewer's clock. */
export const WEEKDAY_SHORT = new Intl.DateTimeFormat("en-GB", { weekday: "short" });

/** Opening and closing times a practitioner can pick: every half hour, and midnight to close a day. */
export const HOUR_CHOICES = [
  ...Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`),
  "24:00",
];

const formatter = (zone: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("sv-SE", { timeZone: zone, ...options });
/** "09:00" on the given zone's clock. */
export const clockTime = (iso: string, zone: string) => formatter(zone, { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
/** The viewer's own time zone, as the browser knows it. */
export const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
/** "2026-10-26": the day in the given zone. */
export const localDay = (iso: string, zone: string) => formatter(zone, { dateStyle: "short" }).format(new Date(iso));

/** Times grouped by their day in the zone, days in order. */
export function byDay(times: string[], zone: string): Map<string, string[]> {
  const days = new Map<string, string[]>();
  for (const time of [...times].sort()) {
    const day = localDay(time, zone);
    days.set(day, [...(days.get(day) ?? []), time]);
  }
  return days;
}

/** Monday 00:00 of the week the date falls in, on the viewer's clock. */
export function mondayOf(date: Date): Date {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday;
}

/** ISO weekday key used by the saved opening-hours map: Monday is "1". */
export const weekdayKey = (date: Date) => String((date.getDay() + 6) % 7 + 1);

/** A rolling window on local calendar days, starting at midnight. */
export function rollingDays(start: Date, count = 8): Date[] {
  const first = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  return Array.from({ length: count }, (_, index) =>
    new Date(first.getFullYear(), first.getMonth(), first.getDate() + index));
}

/** The hours the week grid shows: from the earliest opening to the latest closing, at least 08 to 18. */
export function gridBounds(hours: Hours): [number, number] {
  const spans = Object.values(hours).filter((span): span is [string, string] => Boolean(span));
  const hour = (time: string) => Number(time.slice(0, 2)) + Number(time.slice(3)) / 60;
  const first = Math.min(8, ...spans.map(([start]) => Math.floor(hour(start))));
  const last = Math.max(18, ...spans.map(([, end]) => Math.ceil(hour(end))));
  return [first, last];
}

/** "AN" for "Dr. Anna Novák": first and last name, titles ("Dr.", "Prof.") left out. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word && !word.endsWith("."));
  const picked = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return picked.map((word) => word[0].toUpperCase()).join("");
}

/** "Central European Summer Time": a zone's name in words, as it is on that date. */
export function zoneName(zone: string, at = new Date()): string {
  const part = new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: "long" }).formatToParts(at).find((p) => p.type === "timeZoneName");
  return part?.value ?? zone;
}
