"use client";

import { Archive, Download, Plus, Printer } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Case } from "@/components/dashboard-cards";
import { EngineStatus } from "@/components/engine-status";
import { Notice, StatusChip } from "@/components/status";
import type { ConsultationTab } from "@/lib/consultation-tabs";
import { DAY, greeting, nextWhen, TAB_EMPTY, TILES, who, type Filter, type Row, type Sort } from "@/lib/dashboard";
import { downloadAll } from "@/lib/download";
import type { Engine } from "@/lib/engine";
import { loadRecords } from "@/lib/records";
import { dateTime, LANGUAGE_LABEL } from "@/lib/status";

/** The greeting, what needs the doctor, the next consultation, and the four numbers that filter the list. */
export function DashboardHero({ rows, summary, next, openToday, engine, filter, count, onFilter }: {
  rows: Row[] | null; summary: string; next: Row | undefined; openToday: number | null; engine: Engine | null;
  filter: Filter | null; count: (key: Filter) => number; onFilter: (filter: Filter | null) => void;
}) {
  const now = new Date();
  return (
    <section className="wa-hero" aria-labelledby="greeting">
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 16 }}>
        <div style={{ display: "grid", gap: 6 }}>
          <p className="wa-hero__eyebrow">{DAY.format(now)}</p>
          <h1 className="wa-hero__title" id="greeting">{greeting(now.getHours())}</h1>
          <p className="wa-hero__meta">{summary}</p>
          {(next || openToday !== null) && (
            <p className="wa-hero__next">
              {next && <>Next: <Link href={`/consultation/?id=${next.id}`}>{who(next)} {nextWhen(next.scheduled_at, now)}</Link>{next.fee_cents !== null && (next.paid_at ? ", paid" : ", not paid yet")}</>}
              {next && openToday !== null && " · "}
              {openToday !== null && <>{openToday === 1 ? "One open time" : `${openToday} open times`} left today · <Link href="/calendar/">Practice</Link></>}
            </p>
          )}
          {engine && <EngineStatus engine={engine} />}
        </div>
        <Link href="/consultations/new/" className="wa-button wa-button--primary">
          <Plus aria-hidden className="wa-icon" />New consultation
        </Link>
      </div>
      {rows && rows.length > 0 && (
        <div className="wa-stats">
          {TILES.map(([key, label]) => (
            <button key={key} type="button" className={key === "needs" ? "wa-stat wa-stat--lamp" : "wa-stat"} aria-pressed={filter === key}
              onClick={() => onFilter(filter === key ? null : key)}>
              <span className="wa-stat__value">{count(key)}</span><span className="wa-stat__label">{label}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** Finding a patient, and the order of the list (owner, 24 Oct). */
export function FindAndSort({ search, sort, onSearch, onSort }: { search: string; sort: Sort; onSearch: (text: string) => void; onSort: (sort: Sort) => void }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
      <div className="wa-field" style={{ flex: "1 1 260px" }}>
        <label className="wa-label" htmlFor="find">Find a patient</label>
        <input id="find" type="search" className="wa-input" placeholder="Name, phone, email or number" autoComplete="off"
          value={search} onChange={(event) => onSearch(event.target.value)} />
      </div>
      <div className="wa-field" style={{ flex: "0 1 230px" }}>
        <label className="wa-label" htmlFor="sort">Sort</label>
        <div className="wa-select">
          <select id="sort" value={sort} onChange={(event) => onSort(event.target.value as Sort)}>
            <option value="name">Patient&apos;s last name</option>
            <option value="date">Date, newest first</option>
          </select>
        </div>
      </div>
    </div>
  );
}

/** Why the list is empty: the search, the pressed number, or nothing in this tab yet. */
export function NothingShown({ search, filter, tab, onClearSearch, onClearFilter }: {
  search: string; filter: Filter | null; tab: ConsultationTab; onClearSearch: () => void; onClearFilter: () => void;
}) {
  if (search.trim()) {
    return <Notice title="No patient found" actions={<button type="button" className="wa-button wa-button--secondary wa-button--small"
      onClick={onClearSearch}>Clear the search</button>}>Nobody matches &ldquo;{search.trim()}&rdquo;. Check the spelling, or try their phone or email.</Notice>;
  }
  if (filter) {
    return <Notice title="Nothing here" actions={<button type="button" className="wa-button wa-button--secondary wa-button--small"
      onClick={onClearFilter}>Show all in this tab</button>}>No consultation matches this number right now.</Notice>;
  }
  return <Notice title={`No ${tab} consultations`}>{TAB_EMPTY[tab]}</Notice>;
}

/** A shelf of consultation cards: those that need the doctor, or that Watson is working on. */
export function Shelf({ id, title, rows }: { id: string; title: string; rows: Row[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="wa-shelf" aria-labelledby={id}>
      <div className="wa-shelf__head"><h2 className="wa-heading" id={id}>{title}</h2></div>
      <div className="wa-cases">{rows.map((row) => <Case key={row.id} row={row} />)}</div>
    </section>
  );
}

/** Finished consultations, one line each; completed ones can be archived. */
export function DoneShelf({ rows, archivable, onArchive }: { rows: Row[]; archivable: boolean; onArchive: (row: Row) => void }) {
  if (rows.length === 0) return null;
  return (
    <section className="wa-shelf" aria-labelledby="done">
      <div className="wa-shelf__head"><h2 className="wa-heading" id="done">Done</h2></div>
      <ul className="wa-done-list">
        {rows.map((row) => (
          <li key={row.id}>
            {/* The whole row opens it, not only the name (owner, 23 Nov): the link covers the row. */}
            <Link href={`/consultation/?id=${row.id}`} className="wa-row__ref" style={{ color: "inherit" }}>{who(row)}</Link>
            <span className="wa-meta">{dateTime(row.scheduled_at)} · {LANGUAGE_LABEL[row.language]}</span>
            <span className="wa-row__actions">
              <StatusChip status={row.status} />
              {archivable && (
                <button type="button" className="wa-button wa-button--quiet wa-button--small" onClick={() => onArchive(row)}>
                  <Archive aria-hidden className="wa-icon wa-icon--sm" />Archive
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Every patient's consultations at once, to keep (owner, 24 Oct). */
export function RecordsShelf() {
  const [exporting, setExporting] = useState<"idle" | "busy" | "failed">("idle");
  async function exportAll() {
    setExporting("busy");
    const records = await loadRecords();
    if (!records) return setExporting("failed");
    downloadAll(records);
    setExporting("idle");
  }
  return (
    <section className="wa-shelf" aria-labelledby="records">
      <div className="wa-shelf__head"><h2 className="wa-heading" id="records">Your records</h2></div>
      <p className="wa-text">Every patient&apos;s consultations and forms, to keep on your computer or to print.</p>
      <div className="wa-actions">
        <button type="button" className="wa-button wa-button--secondary" disabled={exporting === "busy"}
          aria-busy={exporting === "busy" || undefined} onClick={() => void exportAll()}>
          <Download aria-hidden className="wa-icon" />{exporting === "busy" ? "Preparing…" : "Download all as Excel"}
        </button>
        <Link href="/print/?all=1" className="wa-button wa-button--secondary">
          <Printer aria-hidden className="wa-icon" />Print all or save as PDF
        </Link>
      </div>
      {exporting === "failed" && <p className="wa-error" role="alert">Your records could not be loaded. Check your connection and try again.</p>}
    </section>
  );
}
