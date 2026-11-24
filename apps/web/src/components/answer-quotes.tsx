"use client";

import { FileText } from "lucide-react";
import { clock } from "@/lib/audio";
import type { Viewable } from "@/lib/documents";
import type { DocumentQuote, Segment } from "@/lib/form-page";

/** Where an answer comes from: the lines of the conversation, and the pages of the documents it quotes. */
export function AnswerQuotes({ lines, quotes = [], documents, onOpen }: {
  lines: Segment[];
  quotes?: DocumentQuote[];
  documents?: Map<string, Viewable>;
  onOpen?: (document: Viewable) => void;
}) {
  if (lines.length === 0 && quotes.length === 0) return null;
  return (
    <ul className="wa-quotes" aria-label="Where this comes from">
      {lines.map((segment) => (
        <li key={segment.position} className={`wa-quote wa-quote--${segment.speaker}`}>
          <div>
            <span className="wa-quote__who">{segment.speaker === "patient" ? "Patient" : "Practitioner"} · {clock(Number(segment.start_seconds))}</span>
            <p className="wa-quote__text">{segment.reviewed_text ?? segment.machine_text}</p>
          </div>
        </li>
      ))}
      {quotes.map((quote, index) => {
        const document = documents?.get(quote.document_id);
        return (
          <li key={`d${index}`} className="wa-quote wa-quote--document">
            <div>
              <span className="wa-quote__who" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                <FileText aria-hidden className="wa-icon wa-icon--sm" />
                {document ? (
                  <button type="button" className="wa-link" onClick={() => onOpen?.(document)}>{document.file_name}</button>
                ) : "A removed document"} · page {quote.page}
              </span>
              <p className="wa-quote__text">{quote.text}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
