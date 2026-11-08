import { describe, expect, it } from "vitest";
import { consultationTab } from "./consultation-tabs";

describe("consultation tabs", () => {
  it("separates unfinished bookings by payment state", () => {
    expect(consultationTab({ status: "ready_for_audio", fee_cents: null, paid_at: null })).toBe("booked");
    expect(consultationTab({ status: "ready_for_audio", fee_cents: 1200, paid_at: null })).toBe("booked");
    expect(consultationTab({ status: "ready_for_audio", fee_cents: 1200, paid_at: "2026-10-29T12:00:00Z" })).toBe("paid");
  });

  it("puts finished work before payment state", () => {
    expect(consultationTab({ status: "approved", fee_cents: 1200, paid_at: "2026-10-29T12:00:00Z" })).toBe("completed");
    expect(consultationTab({ status: "corrected", fee_cents: null, paid_at: null })).toBe("completed");
    expect(consultationTab({ status: "consent_withdrawn", fee_cents: null, paid_at: null })).toBe("completed");
  });

  it("keeps archived consultations out of every active tab", () => {
    expect(consultationTab({ status: "archived", fee_cents: 1200, paid_at: "2026-10-29T12:00:00Z" })).toBe("archived");
  });
});
