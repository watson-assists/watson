import { describe, expect, it } from "vitest";
import { currentFormRevision } from "./form-revisions";

describe("current form revision", () => {
  it("keeps an approved revision authoritative while a newer candidate is reviewed", () => {
    const approved = { id: "approved", revision_number: 1, approved_at: "2026-11-09T10:00:00Z" };
    const candidate = { id: "candidate", revision_number: 2, approved_at: null };
    expect(currentFormRevision([approved, candidate])).toBe(approved);
  });

  it("uses the newest approved revision after a correction is approved", () => {
    const first = { id: "first", revision_number: 1, approved_at: "2026-11-09T10:00:00Z" };
    const correction = { id: "correction", revision_number: 2, approved_at: "2026-11-09T11:00:00Z" };
    expect(currentFormRevision([correction, first])).toBe(correction);
  });
});
