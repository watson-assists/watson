import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
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

type TypedField = {
  key: string;
  mode?: "extract" | "suggest" | "manual";
  value_type: string;
  required?: boolean;
  options?: { key: string }[];
  item_fields?: TypedField[];
};

type TypedTemplate = {
  sections: { fields: TypedField[] }[];
  approval_gates: { type: "attestation" | "signature"; field_key: string }[];
};

function valueFor(field: TypedField): unknown {
  if (field.value_type === "integer" || field.value_type === "decimal") return 1;
  if (field.value_type === "date") return "2026-12-01";
  if (field.value_type === "boolean") return true;
  if (field.value_type === "single_choice") return field.options?.[0]?.key;
  if (field.value_type === "multi_choice") return [field.options?.[0]?.key];
  if (field.value_type === "repeater") return [{
    item_id: randomUUID(),
    values: Object.fromEntries((field.item_fields ?? []).map((item) => [item.key, null])),
  }];
  return "Confirmed from the synthetic consultation.";
}

describe("typed bilingual form processing", () => {
  it("stores typed values and immutable revision provenance", async () => {
    const owner = await newPractitioner(stack, "typed-form-owner");
    const engine = await newEngine(stack, "typed-form-engine");
    const versionId = sqlAsOwner(`
      select id from public.form_template_versions
      where template_key = 'massage_assessment_en_sk' and version_number = 1;
    `);
    expect(await rpc(owner.client, "set_default_form_template_version", {
      p_version_id: versionId,
    })).toMatchObject({ ok: true, version_id: versionId });

    const created = await rpc(owner.client, "create_consultation_with_template", {
      p_scheduled_at: "2026-12-01T09:00:00Z",
      p_language: "en",
      p_consent_recorded: true,
      p_form_template_version_id: versionId,
    });
    const consultationId = created.consultation_id as string;
    transcriptWithFormJob(consultationId);

    const job = await claimFormJob(engine, consultationId) as Awaited<ReturnType<typeof claimFormJob>> & {
      template: TypedTemplate;
      template_version_id: string;
    };
    expect(job.template_version_id).toBe(versionId);
    const fields = job.template.sections.flatMap((section) => section.fields);
    const answers = fields.map((field) => {
      const known = field.key === "main_concern";
      return {
        key: field.key,
        text: known ? "Persistent fatigue." : null,
        value_type: field.value_type,
        state: known ? "known" : "unanswered",
        value: known ? "Persistent fatigue." : null,
        evidence: known ? [0] : [],
        documents: [],
      };
    });

    const livePieceId = sqlAsOwner(`
      insert into public.live_pieces (
        consultation_id, speaker, seq, offset_seconds, storage_path,
        status, text, engine_user_id
      ) values (
        '${consultationId}', 'patient', 999, 0, '${owner.id}/${consultationId}/live/patient-999',
        'done', 'Synthetic sleep statement.', '${engine.id}'
      ) returning id;
    `).split("\n")[0];
    expect(await rpc(engine.client, "engine_record_provisional_coverage", {
      p_piece_id: livePieceId,
      p_field_keys: ["sleep"],
    })).toEqual({ ok: true });

    const completed = await rpc(engine.client, "engine_complete_form_job", {
      p_job_id: job.job_id,
      p_attempt: job.attempt,
      p_answers: answers,
      p_metrics: {},
    });
    expect(completed).toMatchObject({ ok: true });

    const stored = JSON.parse(sqlAsOwner(`
      select json_build_object(
        'revision_number', f.revision_number,
        'revision_kind', f.revision_kind,
        'template_version_id', f.form_template_version_id,
        'value_type', a.value_type,
        'answer_state', a.answer_state,
        'machine_value', a.machine_value,
        'machine_text', a.machine_text
      )
      from public.forms f
      join public.form_answers a on a.form_id = f.id and a.field_key = 'main_concern'
      where f.consultation_id = '${consultationId}' and f.status <> 'superseded';
    `));
    expect(stored).toEqual({
      revision_number: 1,
      revision_kind: "generated",
      template_version_id: versionId,
      value_type: "long_text",
      answer_state: "known",
      machine_value: "Persistent fatigue.",
      machine_text: "Persistent fatigue.",
    });

    const formId = completed.form_id as string;
    expect(await rpc(owner.client, "review_form_answer", {
      p_form_id: formId,
      p_field_key: "main_concern",
      p_decision: "accept",
    })).toMatchObject({ ok: false, error_category: "FORM_TYPED_REVIEW_REQUIRED" });
    expect(await rpc(owner.client, "approve_form", { p_form_id: formId })).toMatchObject({
      ok: false,
      error_category: "FORM_REQUIRED_FIELDS_MISSING",
    });

    expect(await rpc(owner.client, "review_typed_form_answer", {
      p_form_id: formId, p_field_key: "main_concern", p_decision: "accept",
    })).toEqual({ ok: true });
    for (const field of fields.filter((item) => item.required
      && !["attestation", "signature"].includes(item.value_type)
      && item.key !== "main_concern")) {
      expect(await rpc(owner.client, "review_typed_form_answer", {
        p_form_id: formId,
        p_field_key: field.key,
        p_decision: "edit",
        p_state: "known",
        p_value: valueFor(field),
      }), field.key).toEqual({ ok: true });
    }
    expect(await rpc(owner.client, "approve_form", { p_form_id: formId })).toMatchObject({
      ok: false, error_category: "FORM_RECONCILIATION_REQUIRED",
    });
    const conflictId = sqlAsOwner(`
      select id from public.form_reconciliation_conflicts
      where form_id = '${formId}' and field_key = 'sleep';
    `);
    expect(await rpc(owner.client, "resolve_form_reconciliation", {
      p_conflict_id: conflictId,
    })).toEqual({ ok: true });
    expect(await rpc(owner.client, "approve_form", { p_form_id: formId })).toMatchObject({
      ok: false, error_category: "FORM_ATTESTATIONS_MISSING",
    });
    for (const gate of job.template.approval_gates.filter((item) => item.type === "attestation")) {
      expect(await rpc(owner.client, "set_form_attestation", {
        p_form_id: formId, p_field_key: gate.field_key, p_decision: "confirmed",
      }), gate.field_key).toEqual({ ok: true });
    }
    expect(await rpc(owner.client, "approve_form", { p_form_id: formId })).toMatchObject({
      ok: false, error_category: "FORM_SIGNATURE_MISSING",
    });
    const signature = job.template.approval_gates.find((item) => item.type === "signature")!;
    expect(await rpc(owner.client, "set_form_signature", {
      p_form_id: formId,
      p_field_key: signature.field_key,
      p_signer_role: "practitioner",
      p_method: "typed_confirmation",
      p_signed_name: "Synthetic Practitioner",
    })).toMatchObject({ ok: false, error_category: "VALIDATION" });
    expect(await rpc(owner.client, "set_form_signature", {
      p_form_id: formId,
      p_field_key: signature.field_key,
      p_signer_role: "practitioner",
      p_method: "wet_ink_on_print",
      p_signed_name: "Synthetic Practitioner",
    })).toEqual({ ok: true });
    expect(await rpc(owner.client, "approve_form", { p_form_id: formId })).toEqual({ ok: true });

    const revision = await rpc(owner.client, "queue_form_revision", {
      p_consultation_id: consultationId,
      p_form_template_version_id: versionId,
      p_revision_kind: "correction",
    });
    expect(revision).toMatchObject({ ok: true });
    const correctionJob = await claimFormJob(engine, consultationId);
    const correction = await rpc(engine.client, "engine_complete_form_job", {
      p_job_id: correctionJob.job_id,
      p_attempt: correctionJob.attempt,
      p_answers: answers,
      p_metrics: {},
    });
    expect(correction).toMatchObject({ ok: true });
    expect(sqlAsOwner(`select status from public.forms where id = '${formId}';`)).toBe("approved");
    expect(await rpc(owner.client, "reject_form_revision", {
      p_form_id: correction.form_id,
    })).toEqual({ ok: true });
    expect(sqlAsOwner(`select status from public.consultations where id = '${consultationId}';`)).toBe("approved");

    const nextRevision = await rpc(owner.client, "queue_form_revision", {
      p_consultation_id: consultationId,
      p_form_template_version_id: versionId,
      p_revision_kind: "correction",
    });
    expect(nextRevision).toMatchObject({ ok: true });
    expect(sqlAsOwner(`select parent_form_id from public.form_jobs where id = '${nextRevision.job_id}';`))
      .toBe(formId);

    sqlAsOwner(`
      update public.form_jobs set status = 'failed' where id = '${nextRevision.job_id}';
      update public.consultations set status = 'approved' where id = '${consultationId}';
    `);
    expect(await rpc(owner.client, "archive_consultation", {
      p_consultation_id: consultationId,
    })).toEqual({ ok: true });
    expect(await rpc(owner.client, "queue_form_revision", {
      p_consultation_id: consultationId,
      p_form_template_version_id: versionId,
      p_revision_kind: "correction",
    })).toMatchObject({ ok: false, error_category: "INVALID_STATE_TRANSITION" });
  });
});
