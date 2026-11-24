"use client";

import { useCallback, useState } from "react";
import { call, explain, type Outcome } from "./api";
import type { Database } from "./database.types";

type Name = keyof Database["public"]["Functions"];

/**
 * The one way a screen runs a database function: busy while it runs, and a refusal turned into a
 * sentence the user can act on. `run` answers the outcome when it worked, else null (the problem is
 * set). `messages` words a refusal more precisely, by field or error category.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = useCallback(async <T = object>(name: Name, args: object = {}, messages: Record<string, string> = {}) => {
    setBusy(true);
    setProblem(null);
    const outcome: Outcome<T> = await call<T>(name, args);
    setBusy(false);
    if (outcome.ok) return outcome;
    setProblem(messages[outcome.field ?? ""] ?? messages[outcome.error_category] ?? explain(outcome.error_category));
    return null;
  }, []);
  return { busy, setBusy, problem, setProblem, run };
}
