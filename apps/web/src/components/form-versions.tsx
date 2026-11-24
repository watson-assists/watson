"use client";

import { useEffect, useState } from "react";
import { answerText, type FormAnswer, type FormTemplate } from "@/lib/export";
import { dateTime } from "@/lib/status";
import { supabase } from "@/lib/supabase";

type Medicine = { name: string; quantity: number; instructions: string };
type Version = { id: string; revision_number: number; approved_at: string; approved_by: string | null;
  medicines: Medicine[] | null; form_answers: FormAnswer[] };
type Change = { what: string; before: string; after: string };

const medicineText = (medicines: Medicine[] | null) => (medicines ?? [])
  .map((item) => `${item.quantity > 1 ? `${item.quantity} × ` : ""}${item.name}${item.instructions ? ` (${item.instructions})` : ""}`).join("; ");

/** What changed from one approved version to the next: each answer, and the medicines. */
export function changes(template: FormTemplate, before: Version, after: Version): Change[] {
  const was = new Map(before.form_answers.map((answer) => [answer.field_key, answer]));
  const now = new Map(after.form_answers.map((answer) => [answer.field_key, answer]));
  const found = template.sections.flatMap((section) => section.fields).flatMap((field) => {
    const [old, next] = [answerText(was.get(field.key), field), answerText(now.get(field.key), field)];
    return old === next ? [] : [{ what: field.label, before: old, after: next }];
  });
  // A version approved before medicines were kept with it says nothing about them.
  if (before.medicines !== null && after.medicines !== null && medicineText(before.medicines) !== medicineText(after.medicines)) {
    found.push({ what: "Medicines", before: medicineText(before.medicines), after: medicineText(after.medicines) });
  }
  return found;
}

/**
 * Every approved version of the form (owner's test team, 23 Nov: changes after approval, "who, what,
 * when"). Each earlier version is kept as it was; shown once the form has been changed.
 */
export function FormVersions({ consultationId, template }: { consultationId: string; template: FormTemplate }) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await supabase.from("forms")
        .select("id, revision_number, approved_at, approved_by, medicines, form_answers(field_key, machine_text, practitioner_text, review, value_type, answer_state, machine_value, practitioner_value)")
        .eq("consultation_id", consultationId).eq("status", "approved").order("revision_number");
      const found = (data ?? []) as unknown as Version[];
      const ids = [...new Set(found.flatMap((version) => version.approved_by ? [version.approved_by] : []))];
      const { data: profiles } = ids.length
        ? await supabase.from("practitioner_profiles").select("practitioner_id, display_name").in("practitioner_id", ids)
        : { data: [] };
      if (!alive) return;
      setVersions(found);
      setNames(new Map((profiles ?? []).map((profile) => [profile.practitioner_id, profile.display_name])));
    })();
    return () => { alive = false; };
  }, [consultationId]);

  if (versions.length < 2) return null;
  const who = (version: Version) => (version.approved_by && names.get(version.approved_by)) || "you";
  return (
    <section className="wa-panel" aria-labelledby="versions-title">
      <h2 className="wa-heading" id="versions-title">Versions</h2>
      <p className="wa-hint">Each change is a new version. Earlier versions stay as they were; the patient sees the latest.</p>
      <ol className="wa-versions">
        {versions.map((version, index) => ({ version, number: index + 1, before: versions[index - 1] })).reverse().map(({ version, number, before }) => {
          const found = before ? changes(template, before, version) : [];
          return (
            <li key={version.id}>
              <p className="wa-shop__name">Version {number} <span className="wa-meta">· approved {dateTime(version.approved_at)} by {who(version)}</span></p>
              {before && (found.length === 0 ? <p className="wa-meta">No changes.</p> : (
                <ul className="wa-versions__changes">
                  {found.map((change) => (
                    <li key={change.what}><strong>{change.what}:</strong> <del>{change.before || "—"}</del> → <ins>{change.after || "—"}</ins></li>
                  ))}
                </ul>
              ))}
              {!before && <p className="wa-meta">The first approved form.</p>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
