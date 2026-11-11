"use client";

import { useEffect, useState } from "react";
import { call, explain } from "@/lib/api";
import type { Tables } from "@/lib/database.types";
import { Notice } from "@/components/status";
import { defaultTemplateId, templateLabel } from "@/lib/form-templates";
import { supabase } from "@/lib/supabase";

type Version = Pick<Tables<"form_template_versions">,
  "id" | "template_key" | "version_number" | "schema_version" | "definition">;

export function FormTemplateSettings() {
  const [versions, setVersions] = useState<Version[]>([]);
  const [selected, setSelected] = useState("");
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      supabase.from("form_template_versions")
        .select("id, template_key, version_number, schema_version, definition")
        .order("is_built_in", { ascending: false }).order("template_key").order("version_number", { ascending: false }),
      supabase.from("form_template_defaults").select("form_template_version_id").maybeSingle(),
    ]).then(([available, current]) => {
      if (!alive) return;
      const rows = available.data ?? [];
      const id = defaultTemplateId(rows, current.data?.form_template_version_id);
      setVersions(rows);
      setSelected(id);
      setSaved(id);
      setLoading(false);
    });
    return () => { alive = false; };
  }, []);

  async function save() {
    setBusy(true);
    setProblem(null);
    const outcome = await call("set_default_form_template_version", { p_version_id: selected });
    setBusy(false);
    if (!outcome.ok) return setProblem(explain(outcome.error_category));
    setSaved(selected);
  }

  return (
    <section className="wa-panel" aria-labelledby="default-form-title">
      <h2 className="wa-heading" id="default-form-title">Default consultation form</h2>
      <p className="wa-hint" id="default-form-hint">
        New consultations start with this immutable form version. You can choose another while creating one.
      </p>
      {loading ? <p className="wa-meta" role="status">Loading forms…</p> : (
        <div className="wa-fields-row" style={{ alignItems: "end" }}>
          <div className="wa-field">
            <label className="wa-label" htmlFor="default-form">Form</label>
            <div className="wa-select">
              <select id="default-form" value={selected} aria-describedby="default-form-hint"
                onChange={(event) => setSelected(event.target.value)}>
                {versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {templateLabel(version)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button type="button" className="wa-button wa-button--secondary"
            disabled={busy || !selected || selected === saved} aria-busy={busy || undefined} onClick={save}>
            {busy ? "Saving…" : "Save default"}
          </button>
        </div>
      )}
      {problem && <Notice tone="failed" title="The default form was not changed">{problem}</Notice>}
    </section>
  );
}
