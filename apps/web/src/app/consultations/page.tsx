"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { ConsultationTabs } from "@/components/dashboard-cards";
import { DashboardHero, DoneShelf, FindAndSort, NothingShown, RecordsShelf, Shelf } from "@/components/dashboard-parts";
import { Notice } from "@/components/status";
import { call, explain } from "@/lib/api";
import type { Week } from "@/lib/booking";
import { consultationTab, type ConsultationTab } from "@/lib/consultation-tabs";
import { byLastName, FILTER, matches, newestFirst, plural, TABS, who, type Filter, type Row, type Sort } from "@/lib/dashboard";
import { engineStatus, type Engine } from "@/lib/engine";
import { PATIENT_COLUMNS, shownPatient } from "@/lib/patient";
import { earlierPatients } from "@/lib/records";
import { RequireSession } from "@/lib/session";
import { summarise } from "@/lib/status";
import { supabase } from "@/lib/supabase";

export default function ConsultationsPage() {
  return <RequireSession>{(user) => <AppShell user={user}><Dashboard /></AppShell>}</RequireSession>;
}

/** Home's data: the practitioner's consultations, Watson's engine, and today's open booking times. */
function useHome() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [failed, setFailed] = useState(false);
  const [openToday, setOpenToday] = useState<number | null>(null);
  useEffect(() => {
    // Row-level security returns only the signed-in practitioner's consultations.
    supabase
      .from("consultations")
      .select(`id, synthetic_patient_ref, scheduled_at, updated_at, language, status, fee_cents, paid_at, forms(form_answers(machine_text)), ${PATIENT_COLUMNS}`)
      .filter("released", "eq", false) // an unpaid booking whose hold ran out is not the practitioner's business
      .order("scheduled_at", { ascending: false })
      .then(async ({ data, error }) => {
        if (error) return setFailed(true);
        const loaded = data as unknown as Row[];
        const earlier = await earlierPatients(loaded);
        setRows(loaded.map((row) => ({ ...row, person: shownPatient(row, earlier) })));
      });
    engineStatus().then(setEngine);
    const start = new Date();
    const midnight = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    call<Week>("calendar_week", { p_from: start.toISOString(), p_to: midnight.toISOString() }).then((week) => {
      if (week.ok && week.page) setOpenToday(week.open.length);
    });
  }, []);
  return { rows, setRows, engine, failed, openToday };
}

function Dashboard() {
  const { rows, setRows, engine, failed, openToday } = useHome();
  const [filter, setFilter] = useState<Filter | null>(null);
  const [tab, setTab] = useState<ConsultationTab>("booked");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("name");
  const [archiveTarget, setArchiveTarget] = useState<Row | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [archiveProblem, setArchiveProblem] = useState<string | null>(null);

  function chooseTab(next: ConsultationTab) {
    setTab(next);
    setFilter(null);
    setArchiveTarget(null);
    setArchiveProblem(null);
  }
  async function archiveConsultation() {
    if (!archiveTarget) return;
    setArchiving(true);
    setArchiveProblem(null);
    const outcome = await call("archive_consultation", { p_consultation_id: archiveTarget.id });
    setArchiving(false);
    if (!outcome.ok) return setArchiveProblem(explain(outcome.error_category));
    setRows((current) => current?.map((row) => row.id === archiveTarget.id
      ? { ...row, status: "archived", updated_at: new Date().toISOString() } : row) ?? current);
    setArchiveTarget(null);
    chooseTab("archived");
  }

  const now = new Date();
  const all = rows ?? [];
  const allCount = (key: Filter) => all.filter((row) => FILTER[key](row, now)).length;
  const tabRows = all.filter((row) => consultationTab(row) === tab);
  const tabCounts = Object.fromEntries(TABS.map(([key]) => [key, all.filter((row) => consultationTab(row) === key).length])) as Record<ConsultationTab, number>;
  // The numbers and shelves describe the active lifecycle tab; changing tabs clears a pressed number.
  const shown = tabRows.filter((row) => (!filter || FILTER[filter](row, now)) && matches(row, search)).sort(sort === "name" ? byLastName : newestFirst);
  const group = (name: string) => shown.filter((row) => summarise(row.status).group === name);
  const next = all.filter((row) => Date.parse(row.scheduled_at) > now.getTime() && summarise(row.status).stages[1] !== "done")
    .sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at))[0];
  const summary = rows === null ? " " : [
    allCount("needs") ? `${plural(allCount("needs"), "consultation needs", "consultations need")} you.` : "Nothing needs you right now.",
    allCount("working") ? `Watson is working on ${allCount("working") === 1 ? "one" : allCount("working")}.` : "",
  ].join(" ");

  return (
    <>
      <DashboardHero rows={rows} summary={summary} next={next} openToday={openToday} engine={engine} filter={filter}
        count={(key) => tabRows.filter((row) => FILTER[key](row, now)).length} onFilter={setFilter} />
      {failed ? (
        <Notice tone="failed" title="Your consultations could not be loaded">Check your connection and reload the page.</Notice>
      ) : rows === null ? <Loading /> : rows.length === 0 ? <NoConsultations /> : (
        <>
          <ConsultationTabs active={tab} counts={tabCounts} onChange={chooseTab} />
          <div id="consultations-tabpanel" role="tabpanel" aria-labelledby={`consultations-tab-${tab}`} className="wa-tabpanel">
            <FindAndSort search={search} sort={sort} onSearch={setSearch} onSort={setSort} />
            {archiveTarget && (
              <Notice tone="attention" title={`Archive ${who(archiveTarget)}?`} actions={<>
                <button type="button" className="wa-button wa-button--danger" disabled={archiving}
                  onClick={() => void archiveConsultation()}>Archive consultation</button>
                <button type="button" className="wa-button wa-button--secondary" disabled={archiving}
                  onClick={() => setArchiveTarget(null)}>Keep consultation</button>
              </>}>
                This removes it from Completed, but keeps the consultation and its audit history under Archived.
              </Notice>
            )}
            {archiveProblem && <Notice tone="failed" title="Not archived">{archiveProblem}</Notice>}
            {shown.length === 0 && <NothingShown search={search} filter={filter} tab={tab} onClearSearch={() => setSearch("")} onClearFilter={() => setFilter(null)} />}
            <Shelf id="needs" title="Needs you" rows={group("Needs you")} />
            <Shelf id="working" title="Watson is working" rows={group("Watson is working")} />
            <DoneShelf rows={group("Done")} archivable={tab === "completed"} onArchive={(row) => { setArchiveTarget(row); setArchiveProblem(null); }} />
          </div>
          <RecordsShelf />
        </>
      )}
    </>
  );
}

function Loading() {
  return (
    <div className="wa-cases" aria-busy="true" aria-label="Loading your consultations">
      {[0, 1].map((key) => (
        <div key={key} className="wa-case" aria-hidden>
          <span className="wa-skeleton" style={{ width: 120 }} /><span className="wa-skeleton" style={{ width: 200 }} />
        </div>
      ))}
    </div>
  );
}

function NoConsultations() {
  return (
    <div className="wa-list">
      <div className="wa-empty">
        <h2 className="wa-heading">No consultations yet</h2>
        <p className="wa-text">Create one, send the patient their link, and meet them by video. Watson writes the transcript and fills in your form.</p>
        <Link href="/consultations/new/" className="wa-button wa-button--primary">
          <Plus aria-hidden className="wa-icon" />New consultation
        </Link>
      </div>
    </div>
  );
}
