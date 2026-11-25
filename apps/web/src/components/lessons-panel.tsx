"use client";

import { RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Notice } from "@/components/status";
import type { Tables } from "@/lib/database.types";
import { supabase } from "@/lib/supabase";
import { useAction } from "@/lib/use-action";

type Lesson = Pick<Tables<"practitioner_lessons">, "key" | "said" | "forgotten_at">;

/**
 * What Watson has learned from the doctor's corrections (plan step 4, 25 Nov): how they write, never
 * facts about a patient. Each can be forgotten, and brought back.
 */
export function LessonsPanel() {
  const [lessons, setLessons] = useState<Lesson[] | null>(null);
  const { busy, problem, run } = useAction();
  const read = useCallback(async () => (await supabase.from("practitioner_lessons").select("key, said, forgotten_at").order("seen", { ascending: false })).data ?? [], []);
  useEffect(() => {
    let alive = true;
    read().then((found) => alive && setLessons(found));
    return () => { alive = false; };
  }, [read]);

  async function forget(lesson: Lesson, forget: boolean) {
    if (await run("forget_lesson", { p_key: lesson.key, p_forget: forget })) setLessons(await read());
  }

  if (lessons === null) return null;
  const kept = lessons.filter((lesson) => !lesson.forgotten_at);
  const forgotten = lessons.filter((lesson) => lesson.forgotten_at);
  return (
    <section className="wa-panel" aria-labelledby="lessons-title">
      <h2 className="wa-heading" id="lessons-title">What Watson has learned from you</h2>
      <p className="wa-hint">From the answers you correct: the words you prefer, the questions you leave empty, how much you write. Never anything about a patient.</p>
      {kept.length === 0 && <p className="wa-text">Nothing yet. Watson learns once you have corrected the same thing in two or more consultations.</p>}
      {kept.length > 0 && (
        <ul className="wa-shop">
          {kept.map((lesson) => (
            <li key={lesson.key} className="wa-shop__item">
              <p className="wa-text" style={{ margin: 0 }}>{lesson.said}</p>
              <button type="button" className="wa-button wa-button--quiet wa-button--small" disabled={busy} onClick={() => void forget(lesson, true)}>
                <X aria-hidden className="wa-icon wa-icon--sm" />Forget
              </button>
            </li>
          ))}
        </ul>
      )}
      {forgotten.length > 0 && (
        <details>
          <summary className="wa-label">Forgotten ({forgotten.length})</summary>
          <ul className="wa-shop">
            {forgotten.map((lesson) => (
              <li key={lesson.key} className="wa-shop__item wa-shop__item--hidden">
                <p className="wa-text" style={{ margin: 0 }}>{lesson.said}</p>
                <button type="button" className="wa-button wa-button--quiet wa-button--small" disabled={busy} onClick={() => void forget(lesson, false)}>
                  <RotateCcw aria-hidden className="wa-icon wa-icon--sm" />Bring back
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {problem && <Notice tone="failed" title="That did not work">{problem}</Notice>}
    </section>
  );
}
