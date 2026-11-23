"use client";

import { useCallback, useEffect, useState } from "react";
import { CorrectableLine } from "@/components/correctable-line";
import { Notice } from "@/components/status";
import { call } from "@/lib/api";
import type { Tables } from "@/lib/database.types";
import type { Spelling } from "@/lib/spelling";
import { supabase } from "@/lib/supabase";

type Loaded = { transcript: Tables<"transcripts">; segments: Tables<"transcript_segments">[] };

/** 13.4 -> "0:13.4". */
function stamp(seconds: number): string {
  const tenths = Math.round(seconds * 10);
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths % 600) / 10;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

async function fetchTranscript(consultationId: string): Promise<Loaded | "failed"> {
  const { data: transcript, error } = await supabase.from("transcripts").select("*").eq("consultation_id", consultationId)
    .neq("review_status", "superseded").maybeSingle();
  if (error || !transcript) return "failed";
  const { data: segments, error: failed } = await supabase.from("transcript_segments").select("*")
    .eq("transcript_id", transcript.id).order("position");
  return failed ? "failed" : { transcript, segments };
}

/**
 * The conversation as one column of turns, with the two tracks as rails down its edge. Until the form
 * is approved, every line can be corrected (owner, 24 Oct) or removed and put back (owner, 23 Nov).
 */
export function TranscriptView({ consultationId, language, editable }: { consultationId: string; language: string; editable: boolean }) {
  const [loaded, setLoaded] = useState<Loaded | "failed" | null>(null);
  const [learned, setLearned] = useState<Spelling[]>([]);

  useEffect(() => {
    let current = true;
    fetchTranscript(consultationId).then((result) => current && setLoaded(result));
    return () => {
      current = false;
    };
  }, [consultationId]);

  const correct = useCallback(async (segmentId: string, text: string, spellings: Spelling[]) => {
    const outcome = await call("correct_transcript_line", { p_segment_id: segmentId, p_text: text, p_spellings: spellings });
    if (!outcome.ok) return false;
    if (spellings.length) setLearned(spellings);
    setLoaded(await fetchTranscript(consultationId)); // the spelling may have changed other lines too
    return true;
  }, [consultationId]);

  const [failed, setFailed] = useState(false);
  const remove = useCallback(async (segmentId: string, removed: boolean) => {
    const outcome = await call("remove_transcript_line", { p_segment_id: segmentId, p_remove: removed });
    setFailed(!outcome.ok);
    if (outcome.ok) setLoaded(await fetchTranscript(consultationId));
  }, [consultationId]);

  if (loaded === null) return <p className="wa-meta" role="status">Loading the transcript…</p>;
  if (loaded === "failed") {
    return <Notice tone="failed" title="The transcript could not be loaded">Check your connection and reload the page.</Notice>;
  }

  const { transcript } = loaded;
  const segments = loaded.segments.filter((segment) => segment.removed_at === null);
  const removed = loaded.segments.length - segments.length;
  const threshold = transcript.low_confidence_threshold;
  const unsure = (segment: Tables<"transcript_segments">) =>
    !segment.possibly_not_speech && segment.confidence !== null && segment.confidence < threshold;
  const toCheck = segments.filter((segment) => unsure(segment) || segment.possibly_not_speech).length;
  const overlaps = segments.filter((segment) => segment.overlap).length;
  const approximate = transcript.ordering === "approximate";

  return (
    <section className="wa-panel wa-transcript" aria-labelledby="transcript-title">
      <div className="wa-panel__head">
        <h2 className="wa-heading" id="transcript-title">Transcript</h2>
        <ul className="wa-facts">
          <li>{segments.length} {segments.length === 1 ? "turn" : "turns"}</li>
          {toCheck > 0 && <li>{toCheck} to check</li>}
          {removed > 0 && <li>{removed} removed</li>}
          {overlaps > 0 && <li>{overlaps} {overlaps === 1 ? "overlap" : "overlaps"}</li>}
          <li>{language}</li>
        </ul>
      </div>
      {segments.length === 0 ? (
        <Notice title="No speech was found in either track">
          The tracks were transcribed, and the engine heard nothing it could write down.
        </Notice>
      ) : (
        <>
          <ul className="wa-legend">
            <li><span className="wa-swatch wa-swatch--patient" aria-hidden />Patient</li>
            <li><span className="wa-swatch wa-swatch--practitioner" aria-hidden />Practitioner</li>
            <li><span className="wa-tag wa-tag--attention">Unsure</span>Check it against the audio</li>
          </ul>
          {learned.length > 0 && (
            <Notice title="Watson will spell it your way">
              {learned.map((spelling) => `\u201c${spelling.written}\u201d`).join(", ")}, throughout this transcript and in this patient&rsquo;s next consultations.
            </Notice>
          )}
          {removed > 0 && (
            <Notice title="Removed lines stay out of the form">
              Watson leaves them out when it fills in the form, and erases them when you approve it. If the form was filled in before you removed them, press Fill in again on the form.
            </Notice>
          )}
          {failed && <Notice tone="failed" title="That did not work">Check your connection and try again.</Notice>}
          {approximate && (
            <Notice title="The order of turns is a best guess">
              The two tracks were not recorded together, so overlaps cannot be shown.
            </Notice>
          )}
          <ol className={approximate ? "wa-turns wa-turns--approximate" : "wa-turns"}>
            {loaded.segments.map((segment) => segment.removed_at !== null ? (
              <li key={segment.id} className={`wa-turn wa-turn--${segment.speaker} wa-turn--removed`}>
                <div className="wa-turn__body">
                  <p className="wa-turn__removed">
                    Removed from the conversation{" "}
                    {editable && <button type="button" className="wa-button wa-button--quiet wa-button--small"
                      onClick={() => void remove(segment.id, false)}>Undo</button>}
                  </p>
                </div>
              </li>
            ) : (
              <li key={segment.id} className={[
                "wa-turn", `wa-turn--${segment.speaker}`,
                segment.overlap ? "wa-turn--overlap" : "", segment.possibly_not_speech ? "wa-turn--unsure" : "",
              ].join(" ").trim()}>
                <div className="wa-turn__body">
                  <p className="wa-turn__head">
                    <span className="wa-turn__who">{segment.speaker === "patient" ? "Patient" : "Practitioner"}</span>
                    <span className="wa-turn__time">{stamp(segment.start_seconds)}</span>
                    {segment.overlap && <span className="wa-tag">Overlaps</span>}
                    {segment.possibly_not_speech && <span className="wa-tag wa-tag--attention">May not be speech</span>}
                    {unsure(segment) && <span className="wa-tag wa-tag--attention">Unsure</span>}
                  </p>
                  <CorrectableLine textClassName="wa-turn__text" text={segment.reviewed_text ?? segment.machine_text}
                    heard={segment.reviewed_text === null ? null : segment.machine_text} editable={editable}
                    onSave={(text, spellings) => correct(segment.id, text, spellings)}
                    onRemove={() => void remove(segment.id, true)} />
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
