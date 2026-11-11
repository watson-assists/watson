// Dates as the owner reads them (24 Oct: "dd/mm/yyyy format everywhere ... not the American way"),
// whatever language the browser speaks: typed and shown as day/month/year, times on a 24-hour clock.
import { describe, expect, it } from "vitest";
import { asDateInput, asDayMonthYear, asClock, fromDateInputAndClock, fromDayAndClock, nextWeekday } from "./dates";

describe("a date typed as day/month/year", () => {
  it("is read with or without leading zeros, and with dots or dashes too", () => {
    expect(fromDayAndClock("27/10/2026", "14:30")).toEqual(new Date(2026, 9, 27, 14, 30));
    expect(fromDayAndClock("1/2/2027", "9:05")).toEqual(new Date(2027, 1, 1, 9, 5));
    expect(fromDayAndClock("03.11.2026", "08.15")).toEqual(new Date(2026, 10, 3, 8, 15));
  });

  it("refuses what is not a real day or time, and the American order", () => {
    expect(fromDayAndClock("31/02/2026", "10:00")).toBeNull(); // no 31 February
    expect(fromDayAndClock("10/27/2026", "10:00")).toBeNull(); // month 27
    expect(fromDayAndClock("2026-10-27", "10:00")).toBeNull();
    expect(fromDayAndClock("27/10/2026", "24:00")).toBeNull();
    expect(fromDayAndClock("27/10/2026", "2:30 PM")).toBeNull();
  });

  it("is shown as day/month/year and 24-hour time", () => {
    const when = new Date(2026, 0, 5, 7, 3);
    expect(asDayMonthYear(when)).toBe("05/01/2026");
    expect(asClock(when)).toBe("07:03");
  });

  it("round-trips a native date picker's local value without changing the day", () => {
    expect(asDateInput(new Date(2026, 0, 5, 7, 3))).toBe("2026-01-05");
    expect(fromDateInputAndClock("2026-10-27", "14:30")).toEqual(new Date(2026, 9, 27, 14, 30));
    expect(fromDateInputAndClock("2026-02-31", "14:30")).toBeNull();
  });

  it("defaults a new consultation to the next weekday", () => {
    expect(asDateInput(nextWeekday(new Date(2026, 10, 11)))).toBe("2026-11-12"); // Wednesday
    expect(asDateInput(nextWeekday(new Date(2026, 10, 13)))).toBe("2026-11-16"); // Friday
    expect(asDateInput(nextWeekday(new Date(2026, 10, 14)))).toBe("2026-11-16"); // Saturday
  });
});
