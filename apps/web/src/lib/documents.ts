import { explain, type Outcome } from "./api";
import { supabase } from "./supabase";

/** What the engine can read: PDFs, and photos or scans as images. */
const DOCUMENT_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
export const DOCUMENT_ACCEPT = DOCUMENT_TYPES.join(",");
const MAX_BYTES = 10 * 1024 * 1024;

type Started = Outcome<{ document_id: string; path: string }>;

/**
 * Sends one file: makes its record, puts the file at the path made for it, then confirms it.
 * Returns a sentence to show when it did not work, or null.
 */
export async function sendDocument(
  file: File,
  start: (mediaType: string) => Promise<Started>,
  confirm: (documentId: string) => Promise<Outcome>,
): Promise<string | null> {
  if (!DOCUMENT_TYPES.includes(file.type)) return explain("DOCUMENT_FORMAT_UNSUPPORTED");
  if (file.size > MAX_BYTES) return explain("DOCUMENT_TOO_LARGE");
  const started = await start(file.type);
  if (!started.ok) return explain(started.error_category);
  const { error } = await supabase.storage.from("documents").upload(started.path, file, { contentType: file.type });
  if (error) return explain("DOCUMENT_FILE_MISSING");
  const confirmed = await confirm(started.document_id);
  return confirmed.ok ? null : explain(confirmed.error_category);
}

/** A document to show: what it is called, where it is kept, and what kind of file it is. */
export type Viewable = { file_name: string; storage_path: string; media_type: string };

/** Whether this browser can show the document inside the page; Chrome on Android cannot show a PDF there. */
export const showsInPage = (mediaType: string) => mediaType !== "application/pdf" || navigator.pdfViewerEnabled;

/**
 * The document as a local blob URL, or null. The blob is always one of the accepted kinds, whatever the
 * stored file says it is, so a file can only ever be shown as a picture or a PDF, never run as a page.
 */
export async function documentUrl(document: Viewable): Promise<string | null> {
  if (!DOCUMENT_TYPES.includes(document.media_type)) return null;
  try {
    const { data, error } = await supabase.storage.from("documents").download(document.storage_path);
    return error ? null : URL.createObjectURL(new Blob([data], { type: document.media_type }));
  } catch {
    return null;
  }
}

/** Downloads through the caller's current Storage authorization, then opens a local blob URL. */
export async function openDocument(path: string): Promise<boolean> {
  const opened = window.open("", "_blank");
  let data: Blob | null;
  try {
    const result = await supabase.storage.from("documents").download(path);
    data = result.error ? null : result.data;
  } catch {
    data = null;
  }
  if (!data) {
    opened?.close();
    return false;
  }
  const objectUrl = URL.createObjectURL(data);
  if (opened) opened.location.href = objectUrl;
  else window.location.assign(objectUrl);
  return true;
}

/** "340 KB", "1.8 MB". */
export function fileSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
