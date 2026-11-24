"use client";

import { useEffect, useRef, useState } from "react";
import { explain } from "./api";
import { admitToCall, connect, type CallState } from "./call";
import { useCallMedia } from "./use-call-media";

/** The patient's side of a video call: admitted on their link, then the camera, then the call. */
export function usePatientCall(token: string) {
  const media = useCallMedia();
  const [state, setState] = useState<CallState | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const session = useRef<{ leave(): Promise<void> } | null>(null);
  useEffect(() => () => void session.current?.leave(), []);

  async function join() {
    setProblem(null);
    const admitted = await admitToCall(token);
    if (!admitted.ok) return setProblem(explain(admitted.error_category));
    const local = await media.open();
    if (!local) return setProblem("Your camera or microphone is not available. Allow them in your browser, then try again.");
    session.current = connect({
      consultationId: admitted.consultation_id, token, role: "patient", local,
      onRemote: media.showRemote,
      onState: (next) => {
        setState(next);
        if (next === "ended") media.stop();
      },
    });
  }

  async function leave() {
    await session.current?.leave();
    session.current = null;
  }

  return { media, state, problem, setProblem, join, leave };
}
