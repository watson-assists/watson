// Where a live piece of the call ends (17 Nov: about half of the live transcript's delay was the
// wait for a fixed ten-second piece). A piece now ends at the first pause once it is two seconds
// long, and never runs past ten. Calibration knobs: `speech` is the loudness (RMS, 0 to 1) that
// counts as sound; a room whose noise never falls below it simply keeps ten-second pieces.
export const PIECE = { shortestMs: 2000, longestMs: 10_000, pauseMs: 600, speech: 0.004 };

/** Whether to end the piece now: `quietMs` since the last sound, `heard` any sound in it at all. */
export function pieceEnds(elapsedMs: number, quietMs: number, heard: boolean): boolean {
  if (elapsedMs >= PIECE.longestMs) return true;
  return heard && elapsedMs >= PIECE.shortestMs && quietMs >= PIECE.pauseMs;
}

/** How loud a slice of sound is, as its root mean square. */
export function loudness(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / Math.max(1, samples.length));
}
