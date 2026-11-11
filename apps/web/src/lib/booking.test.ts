import { describe, expect, it } from "vitest";
import { byDay, clockTime, gridBounds, HOUR_CHOICES, initials, localDay, mondayOf, rollingDays, weekdayKey, zoneName } from "./booking";

const ZONE = "Europe/Bratislava";

describe("times on the practitioner's clock", () => {
  it("read the same wall clock on both sides of the change from summer time", () => {
    expect(clockTime("2026-10-23T07:00:00Z", ZONE)).toBe("09:00"); // CEST, +2
    expect(clockTime("2026-10-26T08:00:00Z", ZONE)).toBe("09:00"); // CET, +1
    expect(localDay("2026-10-25T23:30:00Z", ZONE)).toBe("2026-10-26");
  });

  it("group by day in order", () => {
    const grouped = byDay(["2026-10-26T08:00:00Z", "2026-10-26T09:00:00Z", "2026-10-27T08:00:00Z"], ZONE);
    expect([...grouped.entries()]).toEqual([
      ["2026-10-26", ["2026-10-26T08:00:00Z", "2026-10-26T09:00:00Z"]],
      ["2026-10-27", ["2026-10-27T08:00:00Z"]],
    ]);
  });
});

describe("the week", () => {
  it("starts on the Monday of the given day, at midnight", () => {
    const monday = mondayOf(new Date(2026, 9, 22, 15, 30)); // a Thursday afternoon
    expect([monday.getFullYear(), monday.getMonth(), monday.getDate(), monday.getHours()]).toEqual([2026, 9, 19, 0]);
    expect(mondayOf(new Date(2026, 9, 25, 10)).getDate()).toBe(19); // Sunday belongs to the week before
  });

  it("uses a rolling today-plus-seven-days window with each day's saved hours", () => {
    const days = rollingDays(new Date(2026, 10, 11)); // Wednesday
    expect(days).toHaveLength(8);
    expect(days.map((day) => day.getDate())).toEqual([11, 12, 13, 14, 15, 16, 17, 18]);
    expect(days.map(weekdayKey)).toEqual(["3", "4", "5", "6", "7", "1", "2", "3"]);
  });

  it("is drawn from the earliest opening to the latest closing, at least 08:00 to 18:00", () => {
    expect(gridBounds({})).toEqual([8, 18]);
    expect(gridBounds({ "1": ["09:00", "17:00"] })).toEqual([8, 18]);
    expect(gridBounds({ "1": ["06:30", "12:00"], "3": ["12:00", "20:15"] })).toEqual([6, 21]);
    expect(gridBounds({ "2": ["00:00", "24:00"] })).toEqual([0, 24]);
  });

  it("offers opening hours every half hour, ending with midnight", () => {
    expect(HOUR_CHOICES[0]).toBe("00:00");
    expect(HOUR_CHOICES).toContain("09:30");
    expect(HOUR_CHOICES.at(-1)).toBe("24:00");
    expect(HOUR_CHOICES).toHaveLength(49);
  });
});

describe("a practitioner on the patients' pages", () => {
  it("is shown by initials, without a title", () => {
    expect(initials("Dr. Anna Novák")).toBe("AN");
    expect(initials("Martin Weber")).toBe("MW");
    expect(initials("robin")).toBe("R");
    expect(initials("Prof. Dr. Lucia de la Horváthová")).toBe("LH");
  });

  it("gives times in the patient's own zone, named in words", () => {
    expect(zoneName("Europe/Bratislava", new Date("2026-01-15T12:00:00Z"))).toBe("Central European Standard Time");
    expect(zoneName("Europe/Bratislava", new Date("2026-07-15T12:00:00Z"))).toBe("Central European Summer Time");
  });
});
