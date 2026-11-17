import { describe, expect, it } from "vitest";
import { adminClient, browserClient, localStack } from "./local-stack";

const MAILPIT = "http://127.0.0.1:54324/api/v1";

describe("native Auth OTP does not grant patient access", () => {
  it("cannot bypass the server challenge to self-provision patient role", async () => {
    const stack = localStack();
    const client = browserClient(stack);
    const email = `patient-otp-${crypto.randomUUID()}@watson.test`;
    // Updated with the owner's approval, 17 Nov: since SEC-03 a native code cannot create an account
    // (sign-up is refused), so the same steps start from an account that already exists.
    expect((await client.auth.signInWithOtp({ email, options: { shouldCreateUser: true } })).error).not.toBeNull();
    expect((await adminClient(stack).auth.admin.createUser({ email, email_confirm: true })).error).toBeNull();

    const requested = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    expect(requested.error).toBeNull();
    expect(requested.data.session).toBeNull();

    const inboxResponse = await fetch(`${MAILPIT}/messages`);
    expect(inboxResponse.ok).toBe(true);
    const inbox = await inboxResponse.json() as {
      messages: { ID: string; To: { Address: string }[] }[];
    };
    const messageInfo = inbox.messages.find((message) => message.To.some((recipient) => recipient.Address === email));
    expect(messageInfo).toBeDefined();
    const messageResponse = await fetch(`${MAILPIT}/message/${messageInfo!.ID}`);
    expect(messageResponse.ok).toBe(true);
    const message = await messageResponse.json() as { Subject: string; Text: string };
    const code = message.Text.match(/(?:^|\n)(\d{8})(?:\n|$)/)?.[1];
    expect(code).toMatch(/^\d{8}$/);

    const verified = await client.auth.verifyOtp({ email, token: code!, type: "email" });
    expect(verified.error).toBeNull();
    expect(verified.data.session?.access_token).toBeTruthy();

    expect((await client.rpc("current_user_roles")).data).toEqual([]);
    const role = await client.rpc("provision_patient_role_after_otp" as never, {
      p_user_id: verified.data.user!.id,
    } as never);
    expect(role.error).not.toBeNull();
    expect((await client.rpc("current_user_roles")).data).toEqual([]);

    const replay = await client.auth.verifyOtp({ email, token: code!, type: "email" });
    expect(replay.error).not.toBeNull();
  });
});
