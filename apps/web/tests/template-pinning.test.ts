import { describe, expect, it } from "vitest";
import {
  claimFormJob,
  localStack,
  newEngine,
  newPractitioner,
  rpc,
  sqlAsOwner,
  transcriptWithFormJob,
} from "./local-stack";

const stack = localStack();
const PINNED = {
  title: "Pinned consultation form",
  sections: [{
    title: "Summary",
    fields: [{ key: "summary", label: "Summary", mode: "extract" }],
  }],
};
const CHANGED_DEFAULT = {
  title: "Changed practice form",
  sections: [{
    title: "Changed",
    fields: [{ key: "changed", label: "Changed", mode: "manual" }],
  }],
};

describe("pinned form-template processing", () => {
  it("pins the Watson built-in when a new practitioner has not chosen a default", async () => {
    const owner = await newPractitioner(stack, "template-fallback-owner");
    const made = await rpc(owner.client, "create_consultation", {
      p_scheduled_at: "2026-11-29T09:00:00Z",
      p_language: "en",
      p_consent_recorded: true,
    });
    expect(sqlAsOwner(`
      select v.template_key
      from public.consultations c
      join public.form_template_versions v on v.id = c.form_template_version_id
      where c.id = '${made.consultation_id}';
    `)).toBe("watson_standard");
  });

  it("claims, validates, and stores the consultation's immutable version", async () => {
    const owner = await newPractitioner(stack, "template-pin-owner");
    const engine = await newEngine(stack, "template-pin-engine");
    const createdVersion = await rpc(owner.client, "create_form_template_version", {
      p_definition: PINNED,
    });
    const versionId = createdVersion.version_id as string;
    expect(createdVersion).toMatchObject({ ok: true, template_key: "custom", version_number: 1 });

    const made = await rpc(owner.client, "create_consultation_with_template", {
      p_scheduled_at: "2026-11-30T09:00:00Z",
      p_language: "en",
      p_consent_recorded: true,
      p_form_template_version_id: versionId,
    });
    const consultationId = made.consultation_id as string;

    transcriptWithFormJob(consultationId);
    expect(await rpc(owner.client, "set_form_template", { p_definition: CHANGED_DEFAULT }))
      .toMatchObject({ ok: true });

    const job = await claimFormJob(engine, consultationId) as Awaited<ReturnType<typeof claimFormJob>> & {
      template: typeof PINNED;
      template_version_id: string;
      template_hash: string;
    };
    expect(job.template).toEqual(PINNED);
    expect(job.template_version_id).toBe(versionId);
    expect(job.template_hash).toMatch(/^[0-9a-f]{64}$/);

    expect(await rpc(engine.client, "engine_complete_form_job", {
      p_job_id: job.job_id,
      p_attempt: job.attempt,
      p_answers: [{ key: "summary", text: "Patient feels tired.", evidence: [0], documents: [] }],
      p_metrics: {},
    })).toMatchObject({ ok: true });

    const stored = JSON.parse(sqlAsOwner(`
      select json_build_object(
        'title', template ->> 'title',
        'version_id', form_template_version_id,
        'template_hash', template_hash
      )
      from public.forms
      where consultation_id = '${consultationId}' and status <> 'superseded';
    `));
    expect(stored).toEqual({
      title: PINNED.title,
      version_id: versionId,
      template_hash: job.template_hash,
    });
  });
});
