// Watson's engine in the cloud (owner, 16 October; decision 0009): started on Modal when work waits,
// stopped when there is none, and paused once the month's allowance of running time is used, so the
// bill stays inside Modal's free credit. The database decides when to wake it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localStack, newEngine, newPractitioner, rpc, sqlAsOwner, transcriptWithFormJob, type Practitioner } from "./local-stack";

const stack = localStack();
let cloud: Practitioner;
let cara: Practitioner;
beforeAll(async () => {
  [cloud, cara] = await Promise.all([newEngine(stack, "cloud"), newPractitioner(stack, "cloud-cara")]);
  sqlAsOwner(`update public.engines set on_demand = true where user_id = '${cloud.id}';`);
});
afterAll(() => {
  sqlAsOwner(`delete from public.engine_runs; update public.engines set on_demand = false;`);
});

const decision = () => sqlAsOwner("select private.engine_wake_decision();");
/** No work waiting anywhere: what earlier test files left queued is set aside as failed. */
const noWork = () => sqlAsOwner(`
  update public.transcription_jobs set status = 'failed', error_category = 'ENGINE_STALLED' where status in ('queued', 'processing');
  update public.form_jobs set status = 'failed', error_category = 'ENGINE_STALLED' where status in ('queued', 'processing');
  update public.patient_documents set reading = 'failed', error_category = 'ENGINE_STALLED' where reading in ('waiting', 'reading');`);
async function waitingForm() {
  const made = await rpc(cara.client, "create_consultation", { p_scheduled_at: "2026-10-20T07:30:00Z", p_language: "en", p_consent_recorded: true });
  transcriptWithFormJob(made.consultation_id!);
}

describe("the cloud engine", () => {
  it("is woken when work waits and nothing runs, and not otherwise", async () => {
    noWork();
    expect(decision()).toBe("no work");
    await waitingForm();
    expect(decision()).toBe("wake");

    const started = await rpc(cloud.client, "engine_run_started");
    expect(started).toMatchObject({ ok: true, run_id: expect.any(String) });
    expect(decision()).toBe("running");
  });

  it("may stop only when no work waits, so a job that arrives as it stops is never stranded", async () => {
    const { run_id: run } = await rpc(cloud.client, "engine_run_started");
    await waitingForm();
    expect(await rpc(cloud.client, "engine_run_finished", { p_run_id: run })).toEqual({ ok: false, work_waiting: true });
    noWork();
    expect(await rpc(cloud.client, "engine_run_finished", { p_run_id: run })).toEqual({ ok: true });
    expect(decision()).toBe("no work");
  });

  it("closes its own runs that never finished when it starts again (a container that died)", async () => {
    const { run_id: lost } = await rpc(cloud.client, "engine_run_started");
    await rpc(cloud.client, "engine_run_started");
    expect(sqlAsOwner(`select finished_at is not null from public.engine_runs where id = '${lost}';`)).toBe("t");
  });

  it("pauses for the rest of the month once its allowance is used, and Home is told", async () => {
    sqlAsOwner(`delete from public.engine_runs;
      insert into public.engine_runs (engine_user_id, started_at, finished_at)
        values ('${cloud.id}', now() - interval '3 hours 1 minute', now());`);
    await waitingForm();
    expect(decision()).toBe("allowance used");
    expect(await rpc(cara.client, "engine_status")).toMatchObject({ on_demand: true, paused: true });

    sqlAsOwner("delete from public.engine_runs;");
    expect(decision()).toBe("wake");
    expect(await rpc(cara.client, "engine_status")).toMatchObject({ on_demand: true, paused: false });
  });

  it("tells the owner once a month, by email, when the allowance stops work that waits", async () => {
    const notices = () => sqlAsOwner("select key from private.owner_notices where key like 'engine-allowance-%';");
    sqlAsOwner(`delete from private.owner_notices; delete from public.engine_runs;
      insert into public.engine_runs (engine_user_id, started_at, finished_at)
        values ('${cloud.id}', now() - interval '3 hours 1 minute', now());`);
    await waitingForm();
    expect(notices()).toBe(`engine-allowance-${new Date().toISOString().slice(0, 7)}`);
    await waitingForm(); // more work, the same month: no second email
    expect(notices().split("\n")).toHaveLength(1);
    sqlAsOwner("delete from private.owner_notices; delete from public.engine_runs;");
  });

  it("is not woken where no engine runs on demand (the laptop engine)", async () => {
    sqlAsOwner("update public.engines set on_demand = false;");
    expect(decision()).toBe("no on-demand engine");
    expect(await rpc(cara.client, "engine_status")).toMatchObject({ on_demand: false, paused: false });
    sqlAsOwner(`update public.engines set on_demand = true where user_id = '${cloud.id}';`);
  });

  it("keeps its runs to engines", async () => {
    expect(await rpc(cara.client, "engine_run_started")).toMatchObject({ ok: false, error_category: "NOT_AN_ENGINE" });
    expect(await rpc(cara.client, "engine_run_finished", { p_run_id: "00000000-0000-0000-0000-000000000000" })).toMatchObject({ ok: false, error_category: "NOT_AN_ENGINE" });
  });
});

// 18 Nov: the live worker. During a call the words on the doctor's screen never wait behind a
// transcript, a document or a form: live pieces have a worker of their own on Modal, woken by the
// first piece and stopped a minute after the last. Its running time counts in the same allowance.
describe("the live worker", () => {
  const liveDecision = () => sqlAsOwner("select private.engine_wake_decision(true);");
  const noLivePieces = () => sqlAsOwner("update public.live_pieces set status = 'failed' where status in ('waiting', 'reading');");
  async function livePiece() {
    const made = await rpc(cara.client, "create_consultation", { p_scheduled_at: "2026-11-18T09:00:00Z", p_language: "sk", p_consent_recorded: true });
    const id = made.consultation_id!;
    await cara.client.storage.from("audio").upload(`${cara.id}/${id}/live/patient-0`, Buffer.from("OggS piece"), { contentType: "audio/ogg" });
    expect(await rpc(cara.client, "add_live_piece", { p_consultation_id: id, p_speaker: "patient", p_seq: 0, p_offset_seconds: 0 })).toEqual({ ok: true });
  }
  beforeAll(() => sqlAsOwner("delete from public.engine_runs;"));

  it("is woken by a live piece, and the main engine is not", async () => {
    noWork();
    noLivePieces();
    expect(liveDecision()).toBe("no work");
    await livePiece();
    expect(liveDecision()).toBe("wake");
    expect(decision()).toBe("no work");
  });

  it("runs beside the main engine: neither start closes the other's run", async () => {
    const { run_id: main } = await rpc(cloud.client, "engine_run_started");
    const { run_id: live } = await rpc(cloud.client, "engine_run_started", { p_live: true });
    expect(sqlAsOwner(`select count(*) from public.engine_runs where id in ('${main}', '${live}') and finished_at is null;`)).toBe("2");
    expect(liveDecision()).toBe("running");
    expect(decision()).toBe("running");
  });

  it("may stop only when no live piece waits; the main engine may stop during a call", async () => {
    const { run_id: main } = await rpc(cloud.client, "engine_run_started");
    const { run_id: live } = await rpc(cloud.client, "engine_run_started", { p_live: true });
    expect(await rpc(cloud.client, "engine_run_finished", { p_run_id: main })).toEqual({ ok: true });
    expect(await rpc(cloud.client, "engine_run_finished", { p_run_id: live })).toEqual({ ok: false, work_waiting: true });
    noLivePieces();
    expect(await rpc(cloud.client, "engine_run_finished", { p_run_id: live })).toEqual({ ok: true });
  });

  it("counts in the same monthly allowance as the main engine", async () => {
    sqlAsOwner(`delete from public.engine_runs;
      insert into public.engine_runs (engine_user_id, started_at, finished_at, live)
        values ('${cloud.id}', now() - interval '2 hours', now(), false), ('${cloud.id}', now() - interval '61 minutes', now(), true);`);
    await livePiece();
    expect(liveDecision()).toBe("allowance used");
    await waitingForm();
    expect(decision()).toBe("allowance used");
    sqlAsOwner("delete from public.engine_runs; delete from private.owner_notices;");
    noWork();
    noLivePieces();
  });
});
