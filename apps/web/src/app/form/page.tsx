"use client";

import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { AnswerCard, type Decision } from "@/components/answer-card";
import { AppShell } from "@/components/app-shell";
import { ConversationAside } from "@/components/conversation-aside";
import { DoctorNotes } from "@/components/doctor-notes";
import { DocumentViewer } from "@/components/document-viewer";
import { FormHero, FormNotices } from "@/components/form-hero";
import { FormVersions } from "@/components/form-versions";
import { PrescriptionsPanel } from "@/components/prescriptions-panel";
import { Notice } from "@/components/status";
import { TypedFormView } from "@/components/typed-form-view";
import { isId } from "@/lib/api";
import { openDocument, showsInPage, type Viewable } from "@/lib/documents";
import { downloadConsultation } from "@/lib/download";
import { formBmi, isTypedFormTemplate, type FormTemplate } from "@/lib/export";
import { fetchForm, type Answer, type Field, type Loaded, type Template } from "@/lib/form-page";
import { loadRecords } from "@/lib/records";
import { RequireSession, useSession } from "@/lib/session";
import { useAction } from "@/lib/use-action";

export default function FormPage() {
  return (
    <RequireSession>
      {(user) => (
        <AppShell user={user}>
          <Suspense fallback={<p className="wa-meta" role="status">Loading the form…</p>}>
            <FormView />
          </Suspense>
        </AppShell>
      )}
    </RequireSession>
  );
}

function FormView() {
  const id = useSearchParams().get("id") ?? "";
  const [loaded, setLoaded] = useState<Loaded | "missing" | "failed" | null>(null);
  const load = useCallback(() => void fetchForm(id).then(setLoaded), [id]);
  useEffect(() => {
    if (!isId(id)) return;
    let current = true;
    fetchForm(id).then((result) => current && setLoaded(result));
    return () => { current = false; };
  }, [id]);

  const back = (
    <Link href={`/consultation/?id=${id}`} className="wa-crumb"><ChevronLeft aria-hidden className="wa-icon wa-icon--sm" />Consultation</Link>
  );
  if (!isId(id) || loaded === "missing") return <>{back}<p className="wa-text">There is no form for this consultation yet.</p></>;
  if (loaded === "failed") return <>{back}<Notice tone="failed" title="The form could not be loaded">Check your connection and reload the page.</Notice></>;
  if (loaded === null) return <p className="wa-meta" role="status">Loading the form…</p>;
  const template = loaded.form.template as unknown as Template;
  if (isTypedFormTemplate(template)) return <TypedFormView loaded={loaded} template={template} reload={load} back={back} />;
  return <TextFormView loaded={loaded} template={template} reload={load} back={back} />;
}

/** A form of plain-text answers: each checked by the doctor, then approved. */
function TextFormView({ loaded, template, reload, back }: { loaded: Loaded; template: Template; reload: () => void; back: ReactNode }) {
  const { consultation, form, answers, segments, documents } = loaded;
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Viewable | null>(null);
  const { busy, setBusy, problem, setProblem, run } = useAction();
  const router = useRouter();
  const session = useSession();

  const fields = new Map(template.sections.flatMap((section) => section.fields).map((field) => [field.key, field]));
  const byKey = new Map(answers.map((answer) => [answer.field_key, answer]));
  const approved = form.status === "approved";
  const recorded = form.transcript_id !== null; // else made from the notes, or by hand (owner's test team, 23 Nov)
  // A field only the practitioner fills in, such as private notes (owner, 24 Oct): never "not discussed".
  const manual = (answer: Answer) => fields.get(answer.field_key)?.mode === "manual";
  const isEmpty = (answer: Answer) => !manual(answer) && answer.machine_text === null && answer.review !== "edited";
  const answered = answers.filter((answer) => answer.machine_text !== null).length;
  const toCheck = answers.filter((answer) => answer.machine_text !== null && answer.review === "unreviewed").length;
  const counts = { answered, asked: answers.filter((answer) => !manual(answer)).length, checked: answered - toCheck };
  const suggested = answers.filter((answer) => fields.get(answer.field_key)?.mode === "suggest" && !isEmpty(answer) && answer.review !== "rejected");
  // Changing the approved form (owner's test team, 23 Nov): only the doctor who approved it; a new version.
  const mine = session.status === "signed-in" && form.approved_by === session.user.id;
  const changing = !approved && form.revision_number > 1 && form.revision_kind === "correction";
  // The answer whose quotes are lit: the one picked, else the first still to check.
  const focus = active ?? answers.find((answer) => !isEmpty(answer) && answer.review === "unreviewed")?.field_key ?? null;
  const bmi = formBmi(byKey);

  const notOpened = () => setProblem("The document could not be opened. Try again.");
  const open = async (document: Viewable) => {
    if (showsInPage(document.media_type)) return setViewing(document);
    if (!(await openDocument(document.storage_path))) notOpened();
  };
  const done = (outcome: object | null) => outcome && reload();
  const decide = async (key: string, decision: Decision, text?: string) => {
    if (!(await run("review_form_answer", { p_form_id: form.id, p_field_key: key, p_decision: decision, p_text: text }))) return;
    setEditing(null);
    reload();
  };
  const fillAgain = async () => {
    if (await run("fill_form_again", { p_consultation_id: consultation.id })) router.push(`/consultation/?id=${consultation.id}`);
  };
  const downloadExcel = async () => {
    setBusy(true);
    setProblem(null);
    const records = await loadRecords(consultation.id);
    setBusy(false);
    if (!records?.length) return setProblem("The form could not be loaded. Check your connection and try again.");
    downloadConsultation(records[0]);
  };
  const edit = (answer: Answer) => {
    setEditing(answer.field_key);
    setDraft(answer.practitioner_text ?? answer.machine_text ?? "");
  };
  const card = (answer: Answer) => (
    <AnswerCard key={answer.field_key} answer={answer} field={fields.get(answer.field_key)}
      state={{ empty: isEmpty(answer), own: manual(answer), recorded, approved, active: focus === answer.field_key, busy, bmi }}
      lines={answer.evidence.map((position) => segments.get(position)).filter((segment) => segment !== undefined)}
      documents={documents} editing={editing === answer.field_key ? { draft, setDraft, cancel: () => setEditing(null) } : null}
      onActivate={() => setActive(answer.field_key)} onDecide={(decision, text) => void decide(answer.field_key, decision, text)}
      onEdit={() => edit(answer)} onOpen={(document) => void open(document)} />
  );

  return (
    <>
      {back}
      <FormHero loaded={loaded} counts={counts} suggested={suggested} busy={busy} onDownload={() => void downloadExcel()} />
      <FormNotices loaded={loaded} mine={mine} changing={changing} busy={busy}
        onChange={() => void run("start_form_change", { p_consultation_id: consultation.id }).then(done)}
        onDiscard={() => void run("reject_form_revision", { p_form_id: form.id }).then(done)} onFillAgain={() => void fillAgain()} />
      {problem && <Notice tone="failed" title="That did not work">{problem}</Notice>}
      <div className="wa-review">
        <div className="wa-sheet">
          {template.sections.map((section, index) => (
            <Fragment key={section.title}>
              <SheetSection section={section} index={index} answers={section.fields.map((field) => byKey.get(field.key)).filter((answer) => answer !== undefined)}
                tucked={(answer) => isEmpty(answer) && editing !== answer.field_key} fields={fields} recorded={recorded} approved={approved}
                busy={busy} card={card} onAdd={edit} />
              {/* The medicines follow the general instructions: together, the prescriptions (owner, 23 Nov). */}
              {holdsMedicines(template, index) && <PrescriptionsPanel consultationId={consultation.id} editable={!approved} />}
            </Fragment>
          ))}
        </div>
        {recorded ? <ConversationAside segments={segments} lit={new Set(byKey.get(focus ?? "")?.evidence ?? [])} /> : (
          <aside className="wa-review__aside">
            <DoctorNotes consultationId={consultation.id} editable={!approved} look="side" />
          </aside>
        )}
      </div>
      {!approved && (
        <div className="wa-approve">
          <p className="wa-meta" role="status">
            {toCheck === 0 ? "Every answer is checked." : `${toCheck} ${toCheck === 1 ? "answer" : "answers"} still to check`}
          </p>
          <button type="button" className="wa-button wa-button--primary" disabled={busy || toCheck > 0}
            onClick={() => void run("approve_form", { p_form_id: form.id }).then(done)}>
            {changing ? "Approve changes" : "Approve form"}
          </button>
        </div>
      )}
      <FormVersions key={`${form.id}-${form.status}`} consultationId={consultation.id} template={template as unknown as FormTemplate} />
      <DocumentViewer document={viewing} onClose={() => setViewing(null)} onFailed={() => { setViewing(null); notOpened(); }} />
    </>
  );
}

/** Whether the medicines go after this section: the general instructions', else the last one. */
const holdsMedicines = (template: Template, index: number) => {
  const has = (section: Template["sections"][number]) => section.fields.some((field) => field.key === "daily_routine");
  return has(template.sections[index]!) || (index === template.sections.length - 1 && !template.sections.some(has));
};

/** One section of the form: its answers, then the questions not discussed (or not written yet) as buttons. */
function SheetSection({ section, index, answers, tucked, fields, recorded, approved, busy, card, onAdd }: {
  section: Template["sections"][number]; index: number; answers: Answer[]; tucked: (answer: Answer) => boolean;
  fields: Map<string, Field>; recorded: boolean; approved: boolean; busy: boolean;
  card: (answer: Answer) => ReactNode; onAdd: (answer: Answer) => void;
}) {
  const empty = answers.filter(tucked);
  const label = (answer: Answer) => fields.get(answer.field_key)?.label ?? answer.field_key;
  return (
    <section className="wa-sheet__section" aria-labelledby={`s-${index}`}>
      <h2 className="wa-sheet__title" id={`s-${index}`}>{section.title}</h2>
      {answers.filter((answer) => !empty.includes(answer)).map(card)}
      {empty.length > 0 && (
        <p className="wa-tucked">
          {recorded ? "Not discussed:" : "To fill in:"}
          {empty.map((answer) => approved ? (
            <strong key={answer.field_key}>{label(answer)}</strong>
          ) : (
            <button key={answer.field_key} type="button" className="wa-button wa-button--quiet wa-button--small"
              aria-label={`Add an answer: ${label(answer)}`} disabled={busy} onClick={() => onAdd(answer)}>
              {label(answer)}
            </button>
          ))}
        </p>
      )}
    </section>
  );
}
