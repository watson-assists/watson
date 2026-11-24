// Runs after `next build`. A static site cannot use per-request nonces, and the
// framework emits inline bootstrap scripts, so each page gets a content security
// policy that lists the hashes of exactly its own inline scripts. Anything injected
// later is refused by the browser.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL must be set to build the security policy.");
const api = new URL(supabaseUrl).origin;
const realtime = api.replace(/^http/, "ws");

function htmlFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return htmlFiles(path);
    return name.endsWith(".html") ? [path] : [];
  });
}

const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;
let pages = 0;
for (const file of htmlFiles("out")) {
  const html = readFileSync(file, "utf8");
  const hashes = new Set();
  for (const [, body] of html.matchAll(INLINE_SCRIPT)) {
    if (body) hashes.add(`'sha256-${createHash("sha256").update(body).digest("base64")}'`);
  }
  const policy = [
    "default-src 'self'",
    `script-src 'self' ${[...hashes].join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    // Product photos from the practice's shop, in the database's public storage (owner, 23 Nov).
    `img-src 'self' data: blob: ${api}/storage/v1/object/public/shop/`,
    "font-src 'self'",
    `media-src 'self' blob: ${api}`,
    `connect-src 'self' ${api} ${realtime}`,
    // A patient's PDF, shown over the page from a local blob (owner, 23 Nov: documents open in the same window).
    "frame-src blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
  if (!html.includes("<head>")) throw new Error(`${file}: no <head> to carry the security policy`);
  writeFileSync(
    file,
    html.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${policy}"/>`),
  );
  pages += 1;
}
console.log(`security policy written into ${pages} pages`);
