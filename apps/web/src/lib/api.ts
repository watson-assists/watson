import type { Database } from "./database.types";
import { supabase } from "./supabase";

type Functions = Database["public"]["Functions"];

/** Every database function answers with one of these two shapes, and never throws. */
export type Outcome<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error_category: string; field?: string };

/** Calls a database function. A network or permission failure becomes a refused outcome. */
export async function call<T = object>(name: keyof Functions, args: object = {}): Promise<Outcome<T>> {
  const { data, error } = await supabase.rpc(name, args as never);
  if (error || data === null) return { ok: false, error_category: "STORAGE_UNAVAILABLE" };
  return data as unknown as Outcome<T>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Whether a value from the address bar can be a record's id, before asking the database. */
export const isId = (value: string) => UUID.test(value);

const MESSAGE: Record<string, string> = {
  AUDIO_FILE_MISSING: "No audio arrived. Attach the file again.",
  AUDIO_FORMAT_UNSUPPORTED: "This audio format is not supported. Use wav, mp3, m4a, mp4, flac, ogg or webm.",
  AUDIO_CORRUPT: "The file did not arrive intact. Attach it again.",
  AUDIO_TOO_LARGE: "The file is larger than 50 MB. Use a compressed format such as m4a or mp3.",
  AUDIO_DURATION_INVALID: "The recording is empty or longer than two hours.",
  CONSENT_MISSING: "Record consent before attaching audio.",
  INVALID_STATE_TRANSITION: "That is not possible at this stage of the consultation. Reload the page to see where it stands.",
  NOT_FOUND: "This consultation does not exist, or it is not yours.",
  TIME_TAKEN: "Another patient booked this time after it stopped waiting for this payment. Create a new consultation for this patient.",
  FORM_NOT_REVIEWED: "Check every answer first: accept, edit or reject it.",
  FORM_TYPED_REVIEW_REQUIRED: "This typed form needs the new safety review screen before answers can be changed.",
  FORM_SAFETY_REVIEW_REQUIRED: "Complete the safety, consent and signature checks before approving this form.",
  FORM_REQUIRED_FIELDS_MISSING: "Complete every required field before approving this form.",
  FORM_ATTESTATIONS_MISSING: "Confirm every required safety and consent statement before approving this form.",
  FORM_SIGNATURE_MISSING: "Record the required practitioner signature before approving this form.",
  FORM_RECONCILIATION_REQUIRED: "Review every difference between live coverage and the final transcript before approval.",
  ENGINE_CAPABILITY_MISSING: "This worker is not authorized for that processing capability.",
  FORM_JOB_ACTIVE: "Another form revision is already being prepared.",
  FORM_TEMPLATE_MISSING: "Your form is not set up yet, so there is nothing to fill in.",
  NOT_SIGNED_IN: "You are signed out. Sign in again.",
  VALIDATION: "One of the values was not accepted. Check the form and try again.",
  STORAGE_UNAVAILABLE: "The service could not be reached. Check your connection and try again.",
  PATIENT_MISSING: "Add the patient's name and phone number or email first.",
  PATIENT_EXISTS: "One of your patients already has this phone number or email. Reload the page to choose them.",
  NOT_A_CLAIM: "This patient has already been checked. Reload the page.",
  ASSOCIATION_LOCKED: "This consultation's patient is confirmed. Change their details under Documents.",
  DOCUMENT_FORMAT_UNSUPPORTED: "Send a PDF or a photo (JPEG, PNG or WebP).",
  DOCUMENT_TOO_LARGE: "This file is larger than 10 MB. Send a smaller copy, or a photo of each page.",
  DOCUMENT_LIMIT: "This consultation already has 20 documents, the most it takes.",
  DOCUMENT_FILE_MISSING: "The file did not arrive. Send it again.",
  DOCUMENT_CORRUPT: "The file did not arrive whole. Send it again.",
};

/** For a refused name or phone number: what to type instead. */
export const FIELD_MESSAGE: Record<string, string> = {
  name: "Enter a name.",
  contact: "Enter a phone number with its country code, like +421 900 123 456, or an email address.",
};

/** A sentence a practitioner can act on, for any refusal. Never a stack trace. */
export function explain(errorCategory: string): string {
  return MESSAGE[errorCategory] ?? "That did not work, and nothing was changed. Try again.";
}
