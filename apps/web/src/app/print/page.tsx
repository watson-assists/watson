"use client";

import { ChevronLeft, Printer } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Notice } from "@/components/status";
import { isId } from "@/lib/api";
import { asClock, asDayMonthYear } from "@/lib/dates";
import { answerText, conversationRows, formState, translated, type ConsultationRecord, type OutputLanguage } from "@/lib/export";
import { loadRecords } from "@/lib/records";
import { RequireSession } from "@/lib/session";

// One consultation, or all of them, laid out to print or save as PDF (owner, 24 Oct: "Pdf to print
// would make sense"). The browser's own print window prints it, or saves it as a PDF.
export default function PrintPage() {
  return (
    <RequireSession>
      {(user) => (
        <AppShell user={user}>
          <Suspense fallback={<p className="wa-meta" role="status">Getting it ready to print…</p>}>
            <PrintView />
          </Suspense>
        </AppShell>
      )}
    </RequireSession>
  );
}

function PrintView() {
  const params = useSearchParams();
  const id = params.get("id") ?? "";
  const all = params.get("all") === "1";
  const requested = params.get("language");
  const language: OutputLanguage = requested === "en" || requested === "sk" ? requested : "both";
  const [records, setRecords] = useState<ConsultationRecord[] | "failed" | null>(null);

  useEffect(() => {
    if (!all && !isId(id)) return;
    let alive = true;
    loadRecords(all ? undefined : id).then((result) => alive && setRecords(result ?? "failed"));
    return () => {
      alive = false;
    };
  }, [id, all]);

  const back = all
    ? <Link href="/consultations/" className="wa-crumb wa-noprint"><ChevronLeft aria-hidden className="wa-icon wa-icon--sm" />Home</Link>
    : <Link href={`/form/?id=${id}`} className="wa-crumb wa-noprint"><ChevronLeft aria-hidden className="wa-icon wa-icon--sm" />The form</Link>;
  if (!all && !isId(id)) return <>{back}<p className="wa-text">This consultation does not exist, or it is not yours.</p></>;
  if (records === "failed") return <>{back}<Notice tone="failed" title="This could not be loaded">Check your connection and reload the page.</Notice></>;
  if (records === null) return <p className="wa-meta" role="status">Getting it ready to print…</p>;

  return (
    <>
      {back}
      <div className="wa-printbar wa-noprint">
        <button type="button" className="wa-button wa-button--primary" onClick={() => window.print()}>
          <Printer aria-hidden className="wa-icon" />Print or save as PDF
        </button>
        <p className="wa-hint">In the window that opens, choose your printer, or choose &ldquo;Save as PDF&rdquo; to keep a copy.</p>
        <div className="wa-actions" aria-label="Output language">
          {(["en", "sk", "both"] as const).map((choice) => (
            <Link key={choice} className={`wa-button wa-button--small ${language === choice ? "wa-button--primary" : "wa-button--secondary"}`}
              href={`/print/?${all ? "all=1&" : `id=${id}&`}language=${choice}`}>
              {choice === "en" ? "English" : choice === "sk" ? "Slovak" : "Bilingual"}
            </Link>
          ))}
        </div>
      </div>
      {records.length === 0 && <p className="wa-text">No consultations yet.</p>}
      {records.map((record, index) => <Printed key={index} record={record} withConversation={!all} language={language} />)}
    </>
  );
}

function Printed({ record, withConversation, language }: {
  record: ConsultationRecord; withConversation: boolean; language: OutputLanguage;
}) {
  const at = new Date(record.scheduledAt);
  const answers = new Map(record.answers.map((answer) => [answer.field_key, answer]));
  const conversation = conversationRows(record).slice(1);
  return (
    <article className="wa-printed">
      <header className="wa-printed__head">
        <p className="wa-hero__eyebrow">{record.template
          ? translated(record.template.title, record.template.title_i18n, language) : "Consultation"}</p>
        <h1 className="wa-title">{record.patient}</h1>
        <p className="wa-printed__meta">
          {asDayMonthYear(at)} {asClock(at)} · {record.practitioner}{record.contact && ` · ${record.contact}`}
        </p>
        <p className="wa-printed__meta">{formState(record)}
          {record.revision !== null && ` · Revision ${record.revision} (${record.revisionKind?.replaceAll("_", " ")})`}
        </p>
        {record.templateHash && <p className="wa-printed__meta">Template SHA-256: {record.templateHash}</p>}
      </header>
      {record.template ? record.template.sections.map((section) => (
        <section key={section.title} className="wa-printed__section">
          <h2 className="wa-heading">{translated(section.title, section.title_i18n, language)}</h2>
          <dl className="wa-printed__answers">
            {section.fields.filter((field) => field.value_type !== "signature").map((field) => (
              <div key={field.key}>
                <dt>{translated(field.label, field.label_i18n, language)}{field.mode === "manual" && <span className="wa-printed__only"> · only for you</span>}</dt>
                <dd>{answerText(answers.get(field.key), field, language) || "—"}</dd>
              </div>
            ))}
          </dl>
        </section>
      )) : <p className="wa-text">Watson has not filled in a form for this consultation yet.</p>}
      {record.signatures.length > 0 ? record.signatures.map((signature) => (
        <footer key={`${signature.field_key}-${signature.signer_role}`} className="wa-printed__sign">
          <span>{signature.signer_role === "patient" ? "Patient / Pacient" : "Practitioner / Poskytovateľ"}</span>
          <span className="wa-printed__line" />
          <span>{signature.signed_name} · {signature.method.replaceAll("_", " ")} · {signature.signed_at.replace("T", " ").replace("Z", " UTC")}</span>
        </footer>
      )) : <footer className="wa-printed__sign">
        <span>Practitioner signature / Podpis poskytovateľa</span><span className="wa-printed__line" /><span>{record.practitioner}</span>
      </footer>}
      {withConversation && conversation.length > 0 && (
        <section className="wa-printed__section wa-printed__conversation">
          <h2 className="wa-heading">The conversation</h2>
          <ol>
            {conversation.map(([time, who, words], index) => (
              <li key={index}><span className="wa-printed__who">{time} · {who}</span> {words}</li>
            ))}
          </ol>
        </section>
      )}
    </article>
  );
}
