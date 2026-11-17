import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

// Both values are public by design: the key only identifies the project, and
// row-level security decides what a signed-in practitioner may read or change.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!url || !publishableKey) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set when the app is built.",
  );
}

export const supabase = createClient<Database>(url, publishableKey);

let callClient: typeof supabase | null = null;
/**
 * The patient's browser in a call (SEC-03, 17 Nov): an anonymous session of its own, kept apart from
 * any practitioner signed in to the same browser, so one browser can still play both sides in a test.
 */
export function patientCallClient(): typeof supabase {
  callClient ??= createClient<Database>(url!, publishableKey!, { auth: { storageKey: "watson-patient-call" } });
  return callClient;
}
