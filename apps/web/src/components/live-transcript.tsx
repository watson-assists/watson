"use client";

import { useEffect, useRef, useState } from "react";
import { CorrectableLine } from "@/components/correctable-line";
import { Notice } from "@/components/status";
import { call as rpc } from "@/lib/api";
import { clock } from "@/lib/audio";
import { liveLines, type LiveLine } from "@/lib/live";
import type { Spelling } from "@/lib/spelling";

/**
 * The live transcript beside the video (owner, 24 Oct: "like it happens in Teams"): what the engine has
 * written so far, every second, each line correctable; a few words changed teach Watson their spelling.
 */
export function LiveTranscript({ consultationId, patientName, recording, declined }: {
  consultationId: string; patientName: string; recording: boolean; declined: boolean;
}) {
  const [lines, setLines] = useState<LiveLine[]>([]);
  const [learned, setLearned] = useState<Spelling[]>([]);
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const poll = setInterval(() => void liveLines(consultationId).then(setLines), 1000); // 17 Nov: was 3 s
    return () => clearInterval(poll);
  }, [consultationId]);
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight; // the newest words in view
  }, [lines]);

  async function correct(pieceId: string, text: string, spellings: Spelling[]) {
    const outcome = await rpc("correct_live_line", { p_piece_id: pieceId, p_text: text, p_spellings: spellings });
    if (!outcome.ok) return false;
    if (spellings.length) setLearned(spellings);
    setLines(await liveLines(consultationId));
    return true;
  }

  return (
    <aside className="wa-livetext" aria-labelledby="live-title">
      <h2 className="wa-heading" id="live-title" style={{ color: "var(--ink)" }}>Live transcript</h2>
      <p className="wa-hint">
        {declined ? "The patient chose not to be recorded, so this call has no transcript. Write what matters in your notes: Watson fills in the form from them after the call."
          : lines.length ? "A few seconds behind. The full transcript follows when you end the call."
          : recording ? "Starting Watson's engine… the first words appear in about half a minute."
          : "Starts when the patient joins and agrees to recording."}
      </p>
      <ol ref={list} className="wa-livetext__lines" aria-live="polite">
        {lines.map((line) => (
          <li key={`${line.speaker}-${line.seq}`} className={`wa-quote wa-quote--${line.speaker}`}>
            <div>
              <span className="wa-quote__who">{line.speaker === "practitioner" ? "You" : patientName}</span>
              <span className="wa-livetext__when">{clock(line.offset_seconds)}</span>
              <CorrectableLine textClassName="wa-quote__text" text={line.text} heard={line.heard_text}
                onSave={(text, spellings) => correct(line.id, text, spellings)} />
            </div>
          </li>
        ))}
      </ol>
      {learned.length > 0 && (
        <Notice title="Watson will spell it your way">
          {learned.map((spelling) => `“${spelling.written}”`).join(", ")}, for the rest of the call, in the full transcript and in the form.
        </Notice>
      )}
    </aside>
  );
}
