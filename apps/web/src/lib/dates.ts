// Dates are shown day/month/year. Native date inputs use their required YYYY-MM-DD value internally;
// conversion stays on the browser's local calendar so a timezone cannot move the chosen day.

const pad = (n: number) => String(n).padStart(2, "0");

/** "05/01/2026". */
export const asDayMonthYear = (at: Date) => `${pad(at.getDate())}/${pad(at.getMonth() + 1)}/${at.getFullYear()}`;
/** "2026-01-05", the value required by an input[type=date]. */
export const asDateInput = (at: Date) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
/** "07:03". */
export const asClock = (at: Date) => `${pad(at.getHours())}:${pad(at.getMinutes())}`;

/** Tomorrow, unless that is Saturday or Sunday; the default may still be edited. */
export function nextWeekday(from: Date): Date {
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
  if (day.getDay() === 6) day.setDate(day.getDate() + 2);
  if (day.getDay() === 0) day.setDate(day.getDate() + 1);
  return day;
}

/** The moment a day ("27/10/2026", also with dots or dashes) and a time ("14:30") name, in this browser's time zone; null if either is not real. */
export function fromDayAndClock(day: string, clock: string): Date | null {
  const date = /^\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\s*$/.exec(day);
  const time = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(clock);
  if (!date || !time) return null;
  const [d, m, y, hours, minutes] = [date[1], date[2], date[3], time[1], time[2]].map(Number);
  if (hours > 23 || minutes > 59) return null;
  const at = new Date(y, m - 1, d, hours, minutes);
  // new Date rolls 31 February into March; a real day comes back as typed.
  return at.getFullYear() === y && at.getMonth() === m - 1 && at.getDate() === d ? at : null;
}

/** A native date input's value and a 24-hour time as a moment in this browser's time zone. */
export function fromDateInputAndClock(day: string, clock: string): Date | null {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const time = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(clock);
  if (!date || !time) return null;
  const [y, m, d, hours, minutes] = [date[1], date[2], date[3], time[1], time[2]].map(Number);
  if (hours > 23 || minutes > 59) return null;
  const at = new Date(y, m - 1, d, hours, minutes);
  return at.getFullYear() === y && at.getMonth() === m - 1 && at.getDate() === d ? at : null;
}
