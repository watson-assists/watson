// MASTER_BUILD_SPEC.md section 20.4: nobody reaches another practitioner's data,
// and nobody changes state except through the database functions.
import { beforeAll, describe, expect, it } from "vitest";
import {
  adminClient, attachTrack, browserClient, createConsultation, FIXTURE_WAV, localStack,
  newPractitioner, PASSWORD, rpc, sqlAsOwner, type Practitioner,
} from "./local-stack";

const stack = localStack();
let anna: Practitioner;
let ben: Practitioner;
let annas: string;
let bens: string;

beforeAll(async () => {
  anna = await newPractitioner(stack, "anna");
  ben = await newPractitioner(stack, "ben");
  annas = await createConsultation(anna, { ref: "SYN-1001" });
  bens = await createConsultation(ben, { ref: "SYN-2002" });
  expect((await attachTrack(anna, annas, "patient")).ok).toBe(true);
});

describe("a practitioner", () => {
  it("sees only their own consultations, tracks and audit events", async () => {
    const consultations = await anna.client.from("consultations").select("id");
    expect(consultations.data).toEqual([{ id: annas }]);
    const tracks = await ben.client.from("audio_tracks").select("id");
    expect(tracks.data).toEqual([]);
    const events = await ben.client.from("audit_events").select("consultation_id");
    expect(new Set(events.data?.map((event) => event.consultation_id))).toEqual(new Set([bens]));
  });

  it("cannot write any table directly, even their own rows", async () => {
    const row = { practitioner_id: anna.id, synthetic_patient_ref: "SYN-1003", scheduled_at: "2026-10-03T09:00:00Z", language: "en", status: "approved" } as const;
    expect((await anna.client.from("consultations").insert(row)).error).not.toBeNull();
    await anna.client.from("consultations").update({ status: "approved" }).eq("id", annas);
    await anna.client.from("consultations").delete().eq("id", annas);
    await anna.client.from("audio_tracks").delete().eq("consultation_id", annas);
    await anna.client.from("audit_events").delete().eq("consultation_id", annas);
    await anna.client.from("audit_events").update({ event_type: "nothing.happened" }).eq("consultation_id", annas);

    const after = await anna.client.from("consultations").select("status").eq("id", annas).single();
    expect(after.data?.status).toBe("ready_for_audio");
    expect((await anna.client.from("audio_tracks").select("id")).data).toHaveLength(1);
    const events = await anna.client.from("audit_events").select("event_type").eq("consultation_id", annas).order("seq");
    expect(events.data?.map((event) => event.event_type)).toEqual([
      "form_template.pinned", "consultation.created", "consent.recorded", "audio.imported",
    ]);
  });

  it("cannot act on someone else's consultation", async () => {
    expect(await rpc(ben.client, "record_consent", { p_consultation_id: annas })).toMatchObject({ ok: false, error_category: "NOT_FOUND" });
    expect(await rpc(ben.client, "remove_audio_track", { p_consultation_id: annas, p_speaker: "patient" })).toMatchObject({ ok: false, error_category: "NOT_FOUND" });
    const check = await ben.client.rpc("verify_audit_chain", { p_consultation_id: annas });
    expect(check.data).toBeNull();
  });

  it("cannot read, replace or delete someone else's audio", async () => {
    const path = `${anna.id}/${annas}/patient`;
    expect((await ben.client.storage.from("audio").download(path)).data).toBeNull();
    expect((await ben.client.storage.from("audio").upload(path, FIXTURE_WAV)).error).not.toBeNull();
    await ben.client.storage.from("audio").remove([path]);
    const mine = await anna.client.storage.from("audio").download(path);
    expect(mine.data?.size).toBe(FIXTURE_WAV.byteLength);
  });

  it("cannot put files anywhere but a track of their own consultation", async () => {
    const upload = (path: string) => anna.client.storage.from("audio").upload(path, FIXTURE_WAV);
    expect((await upload(`${anna.id}/${annas}/notes.txt`)).error).not.toBeNull();
    expect((await upload(`${anna.id}/anything`)).error).not.toBeNull();
    expect((await upload(`${anna.id}/${bens}/patient`)).error).not.toBeNull();
    expect((await upload(`${ben.id}/${bens}/patient`)).error).not.toBeNull();
  });
});

describe("a signed-out visitor", () => {
  const visitor = browserClient(stack);

  it("reads nothing", async () => {
    for (const table of ["consultations", "audio_tracks", "audit_events"] as const) {
      expect((await visitor.from(table).select("*")).data ?? []).toEqual([]);
    }
    expect((await visitor.storage.from("audio").download(`${anna.id}/${annas}/patient`)).data).toBeNull();
  });

  it("can call no function", async () => {
    const create = await visitor.rpc("create_consultation", { p_synthetic_patient_ref: "SYN-1", p_scheduled_at: "2026-10-05T08:30:00Z", p_language: "en", p_consent_recorded: true });
    expect(create.error).not.toBeNull();
    expect((await visitor.rpc("record_consent", { p_consultation_id: annas })).error).not.toBeNull();
  });

  it("cannot get a session from signup before verifying the email", async () => {
    const email = `unverified-${crypto.randomUUID()}@watson.test`;
    const { data, error } = await visitor.auth.signUp({ email, password: PASSWORD });
    expect(error).toBeNull();
    expect(data.user).not.toBeNull();
    expect(data.session).toBeNull();
  });

  it("is refused with a wrong password", async () => {
    const { error } = await visitor.auth.signInWithPassword({ email: anna.email, password: "wrong-password-123" });
    expect(error?.status).toBe(400);
  });
});

describe("a patient account", () => {
  it("cannot provision itself through a public Auth session", async () => {
    const email = `new-patient-${crypto.randomUUID()}@watson.test`;
    const created = await adminClient(stack).auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    expect(created.error).toBeNull();
    const patient = browserClient(stack);
    const signedIn = await patient.auth.signInWithPassword({ email, password: PASSWORD });
    expect(signedIn.error).toBeNull();

    const { error } = await patient.rpc("provision_patient_role_after_otp" as never, {
      p_user_id: created.data.user!.id,
    } as never);
    expect(error).not.toBeNull();
    expect((await patient.rpc("current_user_roles")).data).toEqual([]);
  });

  it("can be provisioned only through the trusted service role after email verification", async () => {
    const email = `verified-patient-${crypto.randomUUID()}@watson.test`;
    const created = await adminClient(stack).auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    expect(created.error).toBeNull();
    const { data, error } = await adminClient(stack).rpc("provision_patient_role_after_otp" as never, {
      p_user_id: created.data.user!.id,
    } as never);
    expect(error).toBeNull();
    expect(data).toEqual({ ok: true, roles: ["patient"] });

    const patient = browserClient(stack);
    const signedIn = await patient.auth.signInWithPassword({ email, password: PASSWORD });
    expect(signedIn.error).toBeNull();
    const payload = signedIn.data.session!.access_token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const sessionId = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "="))).session_id as string;
    expect((await patient.rpc("current_user_roles")).data).toEqual([]);

    const wrongContact = await adminClient(stack).rpc("register_patient_otp_session" as never, {
      p_user_id: created.data.user!.id, p_session_id: sessionId,
      p_verified_email: `other-${crypto.randomUUID()}@watson.test`, p_verified_phone: null,
    } as never);
    expect(wrongContact.error).toBeNull();
    expect(wrongContact.data).toEqual({ ok: false, error_category: "CONTACT_UNVERIFIED" });
    expect((await patient.rpc("current_user_roles")).data).toEqual([]);

    const registered = await adminClient(stack).rpc("register_patient_otp_session" as never, {
      p_user_id: created.data.user!.id, p_session_id: sessionId,
      p_verified_email: email, p_verified_phone: null,
    } as never);
    expect(registered.error).toBeNull();
    expect(registered.data).toEqual({ ok: true });
    expect((await patient.rpc("current_user_roles")).data).toEqual(["patient"]);
    const refreshed = await patient.auth.refreshSession();
    expect(refreshed.error).toBeNull();
    expect((await patient.rpc("current_user_roles")).data).toEqual(["patient"]);
  });

  it("does not add patient role to a practitioner account", async () => {
    const { data, error } = await adminClient(stack).rpc("provision_patient_role_after_otp" as never, {
      p_user_id: anna.id,
    } as never);
    expect(error).toBeNull();
    expect(data).toEqual({ ok: false, error_category: "ROLE_ALREADY_ASSIGNED" });
    expect((await anna.client.rpc("current_user_roles")).data).toEqual(["practitioner"]);
  });

  it("cannot call practitioner functions, even when it owns a practitioner record", async () => {
    const patient = await newPractitioner(stack, "patient-role");
    sqlAsOwner(`
      delete from private.user_roles where user_id = '${patient.id}' and role = 'practitioner';
      insert into private.user_roles (user_id, role) values ('${patient.id}', 'patient');
    `);
    const currentSession = (await patient.client.auth.getSession()).data.session!;
    const sessionPayload = currentSession.access_token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const sessionId = JSON.parse(atob(sessionPayload.padEnd(Math.ceil(sessionPayload.length / 4) * 4, "="))).session_id as string;
    const admitted = await adminClient(stack).rpc("register_patient_otp_session" as never, {
      p_user_id: patient.id, p_session_id: sessionId,
      p_verified_email: patient.email, p_verified_phone: null,
    } as never);
    expect(admitted.error).toBeNull();
    expect((await patient.client.rpc("current_user_roles")).data).toEqual(["patient"]);
    expect((await anna.client.rpc("current_user_roles")).data).toEqual(["practitioner"]);
    const ownConsultation = sqlAsOwner(`
      with inserted as (
        insert into public.consultations (practitioner_id, synthetic_patient_ref, scheduled_at, language, status)
        values ('${patient.id}', 'SYN-900001', now() + interval '1 day', 'en', 'consent_pending')
        returning id
      ) select id from inserted;
    `);
    expect((await patient.client.from("consultations").select("id")).data).toEqual([]);

    const answer = await rpc(patient.client, "create_consultation", {
      p_synthetic_patient_ref: "SYN-900002",
      p_scheduled_at: "2026-10-05T08:30:00Z",
      p_language: "en",
      p_consent_recorded: true,
    });
    expect(answer).toMatchObject({ ok: false, error_category: "NOT_A_PRACTITIONER" });
    expect(await rpc(patient.client, "record_consent", { p_consultation_id: ownConsultation }))
      .toMatchObject({ ok: false, error_category: "NOT_A_PRACTITIONER" });
    const pageWrite = await patient.client.rpc("save_booking_page" as never, {
      p_display_name: "Patient acting as practitioner",
      p_offer: "",
      p_about: "",
      p_languages: ["en"],
      p_hours: { "1": ["09:00", "12:00"] },
      p_length_minutes: 45,
      p_gap_minutes: 15,
      p_fee_cents: 4000,
    } as never);
    expect(pageWrite.error?.code).toBe("42501");
  });
});

describe("the engine credential", () => {
  const engine = adminClient(stack);

  it("cannot be registered on an account with practitioner role", async () => {
    const practitioner = await newPractitioner(stack, "engine-role-conflict");
    const attempt = await engine.rpc("register_engine", {
      p_user_id: practitioner.id,
      p_label: "must-not-overlap",
    });
    expect(attempt.error).not.toBeNull();
  });

  it("can read, but cannot change tables directly", async () => {
    expect((await engine.from("consultations").select("id").eq("id", annas)).data).toHaveLength(1);
    expect((await engine.from("consultations").update({ status: "approved" }).eq("id", annas)).error).not.toBeNull();
    expect((await engine.from("audit_events").delete().eq("consultation_id", annas)).error).not.toBeNull();
    expect((await engine.from("audio_tracks").delete().eq("consultation_id", annas)).error).not.toBeNull();
  });

  it("cannot use the practitioner's functions", async () => {
    expect((await engine.rpc("record_consent", { p_consultation_id: annas })).error).not.toBeNull();
  });
});
