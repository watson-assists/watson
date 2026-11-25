"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { KeyboardEvent } from "react";
import { StatusChip } from "@/components/status";
import type { ConsultationTab } from "@/lib/consultation-tabs";
import { NEXT, TABS, type Row } from "@/lib/dashboard";
import { euros } from "@/lib/fee";
import { dateTime, LANGUAGE_LABEL, summarise } from "@/lib/status";

export function ConsultationTabs({ active, counts, onChange }: {
  active: ConsultationTab; counts: Record<ConsultationTab, number>; onChange: (tab: ConsultationTab) => void;
}) {
  function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const key = event.key;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
    event.preventDefault();
    const next = key === "Home" ? 0 : key === "End" ? TABS.length - 1
      : (index + (key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
    const tab = TABS[next][0];
    document.getElementById(`consultations-tab-${tab}`)?.focus();
    onChange(tab);
  }
  return (
    <div className="wa-tabs" role="tablist" aria-label="Consultation status">
      {TABS.map(([key, label], index) => (
        <button key={key} id={`consultations-tab-${key}`} type="button" role="tab"
          aria-selected={active === key} aria-controls="consultations-tabpanel" tabIndex={active === key ? 0 : -1}
          className="wa-tab" onClick={() => onChange(key)} onKeyDown={(event) => move(event, index)}>
          {label}<span className="wa-tab__count">{counts[key]}</span>
        </button>
      ))}
    </div>
  );
}

/** One consultation that needs the doctor, or that Watson is working on: who, when, and what is next. */
export function Case({ row }: { row: Row }) {
  const { tone, stages } = summarise(row.status);
  const answers = row.forms[0]?.form_answers ?? [];
  const answered = answers.filter((answer) => answer.machine_text !== null).length;
  const formReady = row.status === "draft_ready" || row.status === "under_review";
  const next = formReady ? `${answered} of ${answers.length} answered by Watson` : NEXT[row.status] ?? "";
  const fee = row.fee_cents === null ? null : row.paid_at ? `Paid ${euros(row.fee_cents)}` : "Not paid yet";
  const edge = tone === "failed" ? "wa-case--failed" : tone === "working" ? "wa-case--working" : "wa-case--attention";
  return (
    <Link href={formReady ? `/form/?id=${row.id}` : `/consultation/?id=${row.id}`} className={`wa-case ${edge}`}>
      <div className="wa-case__top">
        <span className="wa-case__name" style={row.person ? undefined : { color: "var(--ink-muted)" }}>{row.person?.name ?? "Patient not named yet"}</span>
        <StatusChip status={row.status} />
      </div>
      {row.person?.check && <span className="wa-chip wa-chip--attention" style={{ justifySelf: "start" }}>Check who this is</span>}
      <p className="wa-case__meta">{[dateTime(row.scheduled_at), LANGUAGE_LABEL[row.language], fee,
        row.person ? row.person.phone ?? row.person.email : row.synthetic_patient_ref].filter(Boolean).join(" · ")}</p>
      <div className="wa-dots" aria-hidden>
        {stages.map((state, index) => <span key={index} className={state === "pending" ? undefined : `is-${state}`} />)}
      </div>
      <p className="wa-case__next">{next}</p>
      <span className="wa-button wa-button--secondary wa-button--small" style={{ justifySelf: "start" }}>
        {formReady ? "Check the form" : "Open"}<ArrowRight aria-hidden className="wa-icon wa-icon--sm" />
      </span>
    </Link>
  );
}
