import { describe, expect, it } from "vitest";
import { createConsultation, localStack, newPractitioner, rpc, sqlAsOwner, transcriptWithFormJob } from "./local-stack";

const stack = localStack();

describe("archiving a consultation", () => {
  it("soft deletes any consultation owned by the practitioner", async () => {
    const owner = await newPractitioner(stack, "archive-owner");
    const other = await newPractitioner(stack, "archive-other");
    const consultationId = await createConsultation(owner, { ref: "SYN-0811" });

    expect(await rpc(other.client, "archive_consultation", { p_consultation_id: consultationId }))
      .toEqual({ ok: false, error_category: "NOT_FOUND" });

    expect(await rpc(owner.client, "archive_consultation", { p_consultation_id: consultationId })).toEqual({ ok: true });

    const status = await owner.client.from("consultations").select("status").eq("id", consultationId).single();
    expect(status.data?.status).toBe("archived");
    const audit = await owner.client.from("audit_events").select("event_type, result, metadata_without_clinical_content")
      .eq("consultation_id", consultationId).eq("event_type", "consultation.archived").single();
    expect(audit.data).toMatchObject({
      event_type: "consultation.archived",
      result: "success",
      metadata_without_clinical_content: { from_status: "ready_for_audio", to_status: "archived" },
    });
  });

  it("cancels active background work before archiving", async () => {
    const owner = await newPractitioner(stack, "archive-jobs");
    const transcribing = await createConsultation(owner, { ref: "SYN-0812" });
    sqlAsOwner(`
      insert into public.transcription_jobs (consultation_id, requested_by, status)
        values ('${transcribing}', '${owner.id}', 'processing');
      update public.consultations set status = 'transcription_processing' where id = '${transcribing}';`);
    expect(await rpc(owner.client, "archive_consultation", { p_consultation_id: transcribing })).toEqual({ ok: true });
    expect(sqlAsOwner(`select status from public.transcription_jobs where consultation_id = '${transcribing}'`)).toBe("cancelled");

    const fillingForm = await createConsultation(owner, { ref: "SYN-0813" });
    transcriptWithFormJob(fillingForm);
    expect(await rpc(owner.client, "archive_consultation", { p_consultation_id: fillingForm })).toEqual({ ok: true });
    expect(sqlAsOwner(`select status from public.form_jobs where consultation_id = '${fillingForm}'`)).toBe("cancelled");
  });
});
