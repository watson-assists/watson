import { describe, expect, it } from "vitest";
import { PIECE, pieceEnds } from "./piece";

describe("where a live piece ends (17 Nov: at a pause, not every ten seconds)", () => {
  it("ends at the first pause once there are two seconds of it", () => {
    expect(pieceEnds(1500, 800, true)).toBe(false); // too short to send on its own
    expect(pieceEnds(3200, 400, true)).toBe(false); // a breath, not a pause
    expect(pieceEnds(3200, PIECE.pauseMs, true)).toBe(true);
  });

  it("never runs past ten seconds, pause or not", () => {
    expect(pieceEnds(PIECE.longestMs, 0, true)).toBe(true);
    expect(pieceEnds(PIECE.longestMs, PIECE.longestMs, false)).toBe(true);
  });

  it("waits through silence before anyone speaks", () => {
    expect(pieceEnds(5000, 5000, false)).toBe(false);
  });
});
