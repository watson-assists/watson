"use client";

import { useEffect, useRef } from "react";
import { clock } from "@/lib/audio";
import type { Segment } from "@/lib/form-page";

/** The conversation beside the form, with the lines the selected answer comes from lit and in view. */
export function ConversationAside({ segments, lit }: { segments: Map<number, Segment>; lit: Set<number> }) {
  const aside = useRef<HTMLElement>(null);
  const key = [...lit].join(",");
  // Bring the first lit line into view, inside its own panel only.
  useEffect(() => {
    const panel = aside.current;
    const first = panel?.querySelector<HTMLElement>(".wa-turn--lit");
    if (panel && first) panel.scrollTo({ top: first.offsetTop - 80, behavior: "smooth" });
  }, [key]);
  return (
    <aside className="wa-review__aside" aria-label="The conversation" ref={aside}>
      <h2 className="wa-heading">The conversation</h2>
      <p className="wa-hint">Lines the selected answer comes from are lit.</p>
      <ol className="wa-turns">
        {[...segments.values()].map((segment) => (
          <li key={segment.position} className={`wa-turn wa-turn--${segment.speaker}${lit.has(segment.position) ? " wa-turn--lit" : ""}`}>
            <div className="wa-turn__body">
              <p className="wa-turn__head" style={{ margin: 0 }}>
                <span className="wa-turn__who">{segment.speaker === "patient" ? "Patient" : "Practitioner"}</span>
                <span className="wa-turn__time">{clock(Number(segment.start_seconds))}</span>
              </p>
              <p className="wa-turn__text">{segment.reviewed_text ?? segment.machine_text}</p>
            </div>
          </li>
        ))}
      </ol>
    </aside>
  );
}
