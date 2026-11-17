// Who may take part in a call's handshake (security review SEC-03, 18 Oct). The doctor joins as
// themselves; the patient's browser has an anonymous session that the database admits only for an
// open, consented-or-pending and paid consultation, one device at a time. Each direction of the
// handshake is its own private channel, so a browser can no longer say for itself which side it is.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { browserClient, localStack, newPractitioner, rpc, sqlAsOwner, type Practitioner } from "./local-stack";

const stack = localStack();
let eva: Practitioner;
let finn: Practitioner;
beforeAll(async () => {
  [eva, finn] = await Promise.all([newPractitioner(stack, "call-eva"), newPractitioner(stack, "call-finn")]);
});

async function consultation(fee?: number) {
  const made = await rpc(eva.client, "create_consultation", {
    p_synthetic_patient_ref: "SYN-0401", p_scheduled_at: "2026-11-20T07:30:00Z", p_language: "en", p_consent_recorded: true,
    ...(fee ? { p_fee_cents: fee } : {}),
  });
  const { data } = await eva.client.from("consultations").select("id, invite_token").eq("id", made.consultation_id!).single();
  return data!;
}

/** A patient's browser: an anonymous session, as the join page makes. */
async function patientBrowser() {
  const client = browserClient(stack);
  const { data, error } = await client.auth.signInAnonymously();
  if (error) throw error;
  return { client, id: data.user!.id };
}

const topic = (consultationId: string, to: "doctor" | "patient") => `call:${consultationId}:to-${to}`;

/** What this user may do on a private channel, asked the way Realtime asks: through its row rules. */
function may(userId: string, channel: string) {
  const as = `set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}","role":"authenticated"}', true);
    select set_config('realtime.topic', '${channel}', true);`;
  const read = sqlAsOwner(`begin;
    insert into realtime.messages (topic, extension, event, payload, private) values ('${channel}', 'broadcast', 'probe', '{}', true);
    ${as}
    select exists (select 1 from realtime.messages where topic = '${channel}' and extension = 'broadcast');
    rollback;`).split("\n").filter((line) => line === "t" || line === "f").pop() === "t";
  let send = true;
  try {
    sqlAsOwner(`begin; ${as}
      insert into realtime.messages (topic, extension, event, payload, private) values ('${channel}', 'broadcast', 'probe', '{}', true);
      rollback;`);
  } catch (error) {
    if (!/row-level security/.test(String(error))) throw error;
    send = false;
  }
  return { read, send };
}

describe("joining a call", () => {
  it("admits a patient's browser to an open consultation and names the call", async () => {
    const { id, invite_token } = await consultation();
    const patient = await patientBrowser();
    expect(await rpc(patient.client, "admit_to_call", { p_token: invite_token })).toEqual({ ok: true, consultation_id: id });
  });

  it("refuses an unpaid consultation, a wrong link and a call that has ended", async () => {
    const unpaid = await consultation(4000);
    const patient = await patientBrowser();
    expect(await rpc(patient.client, "admit_to_call", { p_token: unpaid.invite_token })).toMatchObject({ ok: false, error_category: "PAYMENT_REQUIRED" });
    expect(await rpc(patient.client, "admit_to_call", { p_token: "0".repeat(64) })).toMatchObject({ ok: false, error_category: "NOT_FOUND" });
    const ended = await consultation();
    sqlAsOwner(`update public.consultations set status = 'audio_imported' where id = '${ended.id}';`);
    expect(await rpc(patient.client, "admit_to_call", { p_token: ended.invite_token })).toMatchObject({ ok: false, error_category: "CALL_CLOSED" });
  });

  it("gives a patient's browser an anonymous session, while public sign-up stays shut", async () => {
    expect((await browserClient(stack).auth.signInAnonymously()).error).toBeNull();
    const { error } = await browserClient(stack).auth.signUp({ email: `walk-in-${randomUUID().slice(0, 8)}@example.com`, password: "walk-in-password-1" });
    expect(error?.message).toMatch(/no public sign-up/);
  });

  it("refuses a browser without a session", async () => {
    const { invite_token } = await consultation();
    const { error } = await browserClient(stack).rpc("admit_to_call" as never, { p_token: invite_token } as never);
    expect(error).not.toBeNull();
  });
});

describe("the call's private channels", () => {
  it("let the doctor send only to the patient, and the admitted patient only to the doctor", async () => {
    const { id, invite_token } = await consultation();
    const patient = await patientBrowser();
    await rpc(patient.client, "admit_to_call", { p_token: invite_token });
    expect(may(eva.id, topic(id, "patient"))).toEqual({ read: true, send: true });
    expect(may(eva.id, topic(id, "doctor"))).toEqual({ read: true, send: false });
    expect(may(patient.id, topic(id, "doctor"))).toEqual({ read: true, send: true });
    expect(may(patient.id, topic(id, "patient"))).toEqual({ read: true, send: false });
  });

  it("keep out another doctor, a browser never admitted, and a patient device replaced by a newer one", async () => {
    const { id, invite_token } = await consultation();
    const first = await patientBrowser();
    const stranger = await patientBrowser();
    await rpc(first.client, "admit_to_call", { p_token: invite_token });
    for (const outsider of [finn.id, stranger.id, randomUUID()]) {
      expect(may(outsider, topic(id, "patient"))).toEqual({ read: false, send: false });
      expect(may(outsider, topic(id, "doctor"))).toEqual({ read: false, send: false });
    }
    const second = await patientBrowser();
    await rpc(second.client, "admit_to_call", { p_token: invite_token });
    expect(may(first.id, topic(id, "doctor"))).toEqual({ read: false, send: false });
    expect(may(second.id, topic(id, "doctor"))).toEqual({ read: true, send: true });
  });

  it("are refused by the Realtime server to a browser that was not admitted, and opened to one that was", async () => {
    const { id, invite_token } = await consultation();
    const join = (client: ReturnType<typeof browserClient>) => new Promise<string>((resolve) => {
      void client.realtime.setAuth().then(() => client.channel(topic(id, "patient"), { config: { private: true } })
        .subscribe((status) => { if (status !== "CLOSED") resolve(status); }));
    });
    const outsider = await patientBrowser();
    expect(await join(outsider.client)).toBe("CHANNEL_ERROR");
    const patient = await patientBrowser();
    await rpc(patient.client, "admit_to_call", { p_token: invite_token });
    expect(await join(patient.client)).toBe("SUBSCRIBED");
    await Promise.all([outsider.client.removeAllChannels(), patient.client.removeAllChannels()]);
  });

  it("leave other channels alone", async () => {
    const { id } = await consultation();
    expect(may(eva.id, `call:${id}:to-everyone`)).toEqual({ read: false, send: false });
    expect(may(eva.id, "call-public-anything")).toEqual({ read: false, send: false });
  });
});
