import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { localStack, newPractitioner, rpc, sqlAsOwner, type Practitioner } from "./local-stack";

const stack = localStack();
let eva: Practitioner;
let finn: Practitioner;

beforeAll(async () => {
  [eva, finn] = await Promise.all([
    newPractitioner(stack, "followup-eva"),
    newPractitioner(stack, "followup-finn"),
  ]);
});

async function consultation(who: Practitioner, scheduledAt: string) {
  const made = await rpc(who.client, "create_consultation", {
    p_scheduled_at: scheduledAt,
    p_language: "en",
    p_consent_recorded: true,
  });
  expect(made).toMatchObject({ ok: true });
  return made.consultation_id as string;
}

function patientFor(who: Practitioner) {
  return sqlAsOwner(`
    insert into public.patients (practitioner_id, name, email)
    values ('${who.id}', 'Synthetic Follow-up Patient', 'followup-${randomUUID()}@watson.test')
    returning id;
  `).split("\n")[0]!;
}

async function confirmPatient(who: Practitioner, consultationId: string, patientId: string) {
  expect(await rpc(who.client, "patient_review_association", {
    p_consultation_id: consultationId,
    p_patient_id: patientId,
    p_decision: "confirm",
  })).toMatchObject({ ok: true, patient_id: patientId, association_state: "practitioner_confirmed" });
}

async function previousId(who: Practitioner, consultationId: string) {
  const { data, error } = await who.client.from("consultations")
    .select("previous_consultation_id")
    .eq("id", consultationId)
    .single();
  if (error) throw error;
  return (data as { previous_consultation_id: string | null }).previous_consultation_id;
}

describe("explicit previous-consultation links", () => {
  it("links an owned later consultation to the same confirmed patient and audits identifiers only", async () => {
    const patientId = patientFor(eva);
    const previous = await consultation(eva, "2026-11-10T09:00:00Z");
    const current = await consultation(eva, "2026-11-17T09:00:00Z");
    await confirmPatient(eva, previous, patientId);
    await confirmPatient(eva, current, patientId);

    expect(await previousId(eva, current)).toBeNull();
    expect(await rpc(eva.client, "link_previous_consultation", {
      p_consultation_id: current,
      p_previous_consultation_id: previous,
    })).toEqual({ ok: true, consultation_id: current, previous_consultation_id: previous });
    expect(await previousId(eva, current)).toBe(previous);

    const event = JSON.parse(sqlAsOwner(`
      select json_build_object(
        'consultation_id', consultation_id,
        'resource_id', resource_id,
        'metadata', metadata_without_clinical_content
      )
      from public.audit_events
      where consultation_id = '${current}' and event_type = 'consultation.previous_linked'
      order by seq desc limit 1;
    `));
    expect(event).toEqual({ consultation_id: current, resource_id: previous, metadata: {} });
  });

  it("allows only the practitioner who owns the current and previous consultations", async () => {
    const patientId = patientFor(eva);
    const previous = await consultation(eva, "2026-11-11T09:00:00Z");
    const current = await consultation(eva, "2026-11-18T09:00:00Z");
    await confirmPatient(eva, previous, patientId);
    await confirmPatient(eva, current, patientId);

    expect(await rpc(finn.client, "link_previous_consultation", {
      p_consultation_id: current,
      p_previous_consultation_id: previous,
    })).toEqual({ ok: false, error_category: "NOT_FOUND" });
    expect(await previousId(eva, current)).toBeNull();
  });

  it("requires the same confirmed patient on both consultations", async () => {
    const firstPatient = patientFor(eva);
    const secondPatient = patientFor(eva);
    const previous = await consultation(eva, "2026-11-12T09:00:00Z");
    const current = await consultation(eva, "2026-11-19T09:00:00Z");
    await confirmPatient(eva, previous, firstPatient);

    expect(await rpc(eva.client, "link_previous_consultation", {
      p_consultation_id: current,
      p_previous_consultation_id: previous,
    })).toEqual({ ok: false, error_category: "PATIENT_NOT_CONFIRMED" });

    await confirmPatient(eva, current, secondPatient);
    expect(await rpc(eva.client, "link_previous_consultation", {
      p_consultation_id: current,
      p_previous_consultation_id: previous,
    })).toEqual({ ok: false, error_category: "PATIENT_MISMATCH" });
    expect(await previousId(eva, current)).toBeNull();
  });

  it("rejects self-links, non-earlier links, and cycles", async () => {
    const patientId = patientFor(eva);
    const earlier = await consultation(eva, "2026-11-13T09:00:00Z");
    const later = await consultation(eva, "2026-11-20T09:00:00Z");
    await confirmPatient(eva, earlier, patientId);
    await confirmPatient(eva, later, patientId);

    expect(await rpc(eva.client, "link_previous_consultation", {
      p_consultation_id: earlier,
      p_previous_consultation_id: earlier,
    })).toEqual({ ok: false, error_category: "SELF_LINK" });
    expect(await rpc(eva.client, "link_previous_consultation", {
      p_consultation_id: earlier,
      p_previous_consultation_id: later,
    })).toEqual({ ok: false, error_category: "PREVIOUS_NOT_EARLIER" });

    expect(await rpc(eva.client, "link_previous_consultation", {
      p_consultation_id: later,
      p_previous_consultation_id: earlier,
    })).toMatchObject({ ok: true });
    expect(await rpc(eva.client, "link_previous_consultation", {
      p_consultation_id: earlier,
      p_previous_consultation_id: later,
    })).toEqual({ ok: false, error_category: "CYCLE_DETECTED" });
    expect(await previousId(eva, earlier)).toBeNull();
  });
});
