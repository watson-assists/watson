"use client";

import { Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { call } from "@/lib/api";
import { clock, formatOfRecording, labelled } from "@/lib/audio";
import { supabase } from "@/lib/supabase";

const LONGEST_NOTE_SECONDS = 5 * 60;

/** Records the microphone until stopped, or for five minutes at most; then hands over the recording. */
function recordVoice(stream: MediaStream, onSeconds: (seconds: number) => void, onDone: (blob: Blob) => void) {
  const chunks: Blob[] = [];
  const started = performance.now();
  const media = new MediaRecorder(stream, { audioBitsPerSecond: 32_000 });
  const tick = setInterval(() => {
    const seconds = (performance.now() - started) / 1000;
    if (seconds >= LONGEST_NOTE_SECONDS) media.stop();
    else onSeconds(seconds);
  }, 500);
  media.addEventListener("dataavailable", (event) => chunks.push(event.data));
  media.addEventListener("stop", () => {
    clearInterval(tick);
    stream.getTracks().forEach((track) => track.stop());
    onDone(new Blob(chunks, { type: media.mimeType }));
  }, { once: true });
  media.start(1000);
  return media;
}

/**
 * The doctor's own notes, during the call and after it (owner's test team, 23 Nov: "free-form notes
 * during the call … all considered for the diagnosis", and "the doctor's voice notes"). Saved as they
 * type; a spoken note is written down by Watson and added at the end; Watson reads them when it fills
 * in the form; the patient never sees them. Final once the form is approved.
 */
export function DoctorNotes({ consultationId, editable, look = "panel" }: {
  consultationId: string;
  editable: boolean;
  /** "side": beside the call or the form, without a panel's frame. */
  look?: "panel" | "side";
}) {
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<"saving" | "saved" | "failed" | null>(null);
  // A voice note: being spoken (with its seconds so far), being written down, or not written down.
  const [voice, setVoice] = useState<{ speaking: number } | "writing" | "failed" | "no-microphone" | null>(null);
  const saved = useRef("");
  const latest = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queue = useRef(Promise.resolve()); // one save at a time, so an older one never lands last
  const recorder = useRef<MediaRecorder | null>(null);
  const mounted = useRef(true);
  const id = `notes-${consultationId}`;

  const fetchText = async () =>
    (await supabase.from("doctor_notes").select("text").eq("consultation_id", consultationId).maybeSingle()).data?.text ?? "";
  const show = (value: string) => {
    saved.current = latest.current = value;
    setText(value);
  };
  useEffect(() => {
    let alive = true;
    fetchText().then((value) => alive && show(value));
    return () => { alive = false; };
  }, [consultationId]); // eslint-disable-line react-hooks/exhaustive-deps -- fetchText reads only consultationId

  const save = () => {
    clearTimeout(timer.current);
    queue.current = queue.current.then(async () => {
      const value = latest.current;
      if (value === saved.current) return;
      setState("saving");
      const outcome = await call("save_doctor_notes", { p_consultation_id: consultationId, p_text: value });
      if (outcome.ok) saved.current = value;
      setState(outcome.ok ? "saved" : "failed");
    });
  };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; save(); recorder.current?.stop(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- leaving the page keeps the last words

  async function speak() {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return setVoice("no-microphone");
    }
    recorder.current = recordVoice(stream, (speaking) => setVoice({ speaking }), (blob) => {
      recorder.current = null;
      void writeDown(blob);
    });
    setVoice({ speaking: 0 });
  }

  // The words are added to the notes in the database, so the box waits for them rather than save over them.
  async function writeDown(blob: Blob) {
    setVoice("writing");
    save();
    await queue.current;
    const { file } = await labelled(blob, formatOfRecording(blob.type));
    const note = crypto.randomUUID();
    const user = (await supabase.auth.getSession()).data.session?.user.id;
    const { error } = await supabase.storage.from("audio").upload(`${user}/${consultationId}/notes/${note}`, file, { contentType: file.type });
    if (error || !(await call("add_voice_note", { p_consultation_id: consultationId, p_id: note })).ok) return setVoice("failed");
    while (mounted.current) { // a note sent as the page closes is still added to the notes
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const { data } = await supabase.from("voice_notes").select("status").eq("id", note).maybeSingle();
      if (data?.status === "done" || data?.status === "failed") {
        show(await fetchText());
        return setVoice(data.status === "done" ? null : "failed");
      }
    }
  }

  if (text === null) return null;
  if (!editable && !text.trim()) return null;
  const seconds = voice !== null && typeof voice === "object" ? voice.speaking : null;
  return (
    <section className={look === "panel" ? "wa-panel" : "wa-livetext"}>
      <h2 className="wa-heading" id={id} style={{ color: "var(--ink)" }}>Your notes</h2>
      {editable ? (
        <>
          <p className="wa-hint" id={`${id}-hint`}>Only you see these. Watson reads them when it fills in the form.</p>
          <textarea className="wa-textarea" rows={look === "side" ? 5 : 6} maxLength={20000} value={text}
            readOnly={voice === "writing"} aria-labelledby={id} aria-describedby={`${id}-hint`}
            placeholder="What you notice, and what you think it is"
            onChange={(event) => {
              setText(event.target.value);
              latest.current = event.target.value;
              clearTimeout(timer.current);
              timer.current = setTimeout(save, 800);
            }}
            onBlur={save} />
          <div className="wa-actions" style={{ alignItems: "center" }}>
            {seconds !== null ? (
              <button type="button" className="wa-button wa-button--danger" onClick={() => recorder.current?.stop()}>
                <Square aria-hidden className="wa-icon" />Stop · {clock(seconds)}
              </button>
            ) : (
              <button type="button" className="wa-button wa-button--secondary" disabled={voice === "writing"} onClick={() => void speak()}>
                <Mic aria-hidden className="wa-icon" />Speak a note
              </button>
            )}
            <p className="wa-meta" role="status" style={{ margin: 0 }}>
              {seconds !== null ? "Listening. Watson writes it down when you stop."
                : voice === "writing" ? "Writing down your note…"
                : voice === "failed" ? "Watson could not write that note down. Speak it again, or type it."
                : voice === "no-microphone" ? "The microphone is not available. Allow it in your browser, or type the note."
                : state === "saving" ? "Saving…" : state === "saved" ? "Saved"
                : state === "failed" ? "Not saved. Check your connection, then type again." : ""}
            </p>
          </div>
        </>
      ) : (
        <p className="wa-text" style={{ whiteSpace: "pre-wrap" }}>{text}</p>
      )}
    </section>
  );
}
