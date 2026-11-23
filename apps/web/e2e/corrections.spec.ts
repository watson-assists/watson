// Correcting the transcript (owner, 24 Oct: "I am unable to correct it as we speak … the doctor having
// the ability to correct anything that he sees real time"). Every line has a visible Correct button;
// Watson keeps what it heard and spells the name that way everywhere after.
import { createClient } from "@supabase/supabase-js";
import { expect, signIn, test } from "./account";
import { localStack, newEngine, rpc, sqlAsOwner } from "../tests/local-stack";

async function as(account: { email: string; password: string }) {
  const stack = localStack();
  const client = createClient(stack.url, stack.publishableKey, { auth: { persistSession: false } });
  await client.auth.signInWithPassword({ email: account.email, password: account.password });
  return client;
}
const contact = () => `+421 905 ${Math.floor(Math.random() * 9e5 + 1e5)}`;

test("after the call, a line of the transcript is corrected, and the name is spelled that way throughout", async ({ page, account, problems }) => {
  const client = await as(account);
  const made = await client.rpc("create_consultation", {
    p_scheduled_at: "2026-10-27T09:00:00Z", p_language: "en", p_consent_recorded: true,
    p_patient_name: "Jana Nováková", p_patient_contact: contact(),
  });
  const id = (made.data as { consultation_id: string }).consultation_id;
  sqlAsOwner(`
    with j as (insert into public.transcription_jobs (consultation_id, requested_by, status, finished_at)
               select id, practitioner_id, 'completed', now() from public.consultations where id = '${id}' returning id),
    t as (insert into public.transcripts (consultation_id, job_id, schema_version, ordering, low_confidence_threshold, tracks)
          select '${id}', id, '2.0.0', 'exact', 0.5, '[]' from j returning id)
    insert into public.transcript_segments (id, transcript_id, position, speaker, start_seconds, end_seconds, machine_text)
      select gen_random_uuid(), t.id, n - 1, 'patient', n, n + 1, line
      from t, unnest(array['My name is Yana Novakova.', 'Yana Novakova, yes, from Nitra.']) with ordinality as l(line, n);
    update public.consultations set status = 'transcript_ready' where id = '${id}';`);

  await signIn(page, account);
  await page.goto(`/consultation/?id=${id}`);
  const transcript = page.getByRole("region", { name: "Transcript" });
  const first = transcript.getByRole("listitem").filter({ hasText: "My name is Yana Novakova." });
  await first.getByRole("button", { name: "Correct" }).click();
  const box = first.getByLabel("Correct this line");
  await expect(box).toHaveValue("My name is Yana Novakova.");
  await box.fill("My name is Jana Nováková.");
  await first.getByRole("button", { name: "Save" }).click();

  await expect(transcript.getByText("My name is Jana Nováková.")).toBeVisible();
  await expect(transcript.getByText("Jana Nováková, yes, from Nitra.")).toBeVisible();
  await expect(transcript.getByText("Watson will spell it your way")).toBeVisible();
  await expect(transcript.getByText("Corrected").first()).toBeVisible();
  expect(problems).toEqual([]);
});

// Owner's test team, 23 Nov: "parts of the conversation does not need to be in the transcript which could be edited out".
test("after the call, a line is removed from the conversation, and put back with Undo", async ({ page, account, problems }) => {
  const client = await as(account);
  const made = await client.rpc("create_consultation", {
    p_scheduled_at: "2026-11-23T09:00:00Z", p_language: "en", p_consent_recorded: true,
    p_patient_name: "Jana Nováková", p_patient_contact: contact(),
  });
  const id = (made.data as { consultation_id: string }).consultation_id;
  sqlAsOwner(`
    with j as (insert into public.transcription_jobs (consultation_id, requested_by, status, finished_at)
               select id, practitioner_id, 'completed', now() from public.consultations where id = '${id}' returning id),
    t as (insert into public.transcripts (consultation_id, job_id, schema_version, ordering, low_confidence_threshold, tracks)
          select '${id}', id, '2.0.0', 'exact', 0.5, '[]' from j returning id)
    insert into public.transcript_segments (id, transcript_id, position, speaker, start_seconds, end_seconds, machine_text)
      select gen_random_uuid(), t.id, n - 1, 'patient', n, n + 1, line
      from t, unnest(array['I sleep badly since August.', 'By the way, my neighbour drinks too much.']) with ordinality as l(line, n);
    update public.consultations set status = 'transcript_ready' where id = '${id}';`);

  await signIn(page, account);
  await page.goto(`/consultation/?id=${id}`);
  const transcript = page.getByRole("region", { name: "Transcript" });
  const aside = transcript.getByRole("listitem").filter({ hasText: "my neighbour drinks too much" });
  await aside.getByRole("button", { name: "Remove" }).click();
  await expect(transcript.getByText("my neighbour drinks too much", { exact: false })).toHaveCount(0);
  await expect(transcript.getByText("Removed from the conversation")).toBeVisible();
  await expect(transcript.getByText("Removed lines stay out of the form")).toBeVisible();
  await page.reload();
  await expect(transcript.getByText("my neighbour drinks too much", { exact: false })).toHaveCount(0);
  await transcript.getByRole("button", { name: "Undo" }).click();
  await expect(transcript.getByText("By the way, my neighbour drinks too much.")).toBeVisible();
  await expect(transcript.getByText("I sleep badly since August.")).toBeVisible();
  expect(problems).toEqual([]);
});

test("during the call, a line of the live transcript is corrected as it appears", async ({ page, account, browser, problems }) => {
  test.setTimeout(120_000);
  const engine = await newEngine(localStack(), "fix-e2e");
  await signIn(page, account);
  await page.getByRole("link", { name: "New consultation" }).first().click();
  await page.getByLabel("Patient's name").fill("Jana Nováková");
  await page.getByLabel("Phone or email").fill(contact());
  await page.getByRole("button", { name: "Create consultation" }).click();
  await page.getByRole("link", { name: "Start video call" }).click();
  await page.getByRole("button", { name: "Start video call" }).click();
  const link = await page.getByLabel("Send this link to the patient").inputValue();
  const id = new URL(page.url()).searchParams.get("id")!;

  const elsewhere = await browser.newContext({ permissions: ["microphone", "camera"] });
  const patient = await elsewhere.newPage();
  await patient.goto(link);
  await patient.getByRole("button", { name: "Join the call" }).click();
  const panel = page.getByRole("complementary", { name: "Live transcript" });
  await expect(panel).toBeVisible();

  // The engine's part: the first piece of the patient's voice, misheard.
  let written = false;
  for (let i = 0; i < 60 && !written; i++) {
    const piece = (await rpc(engine.client, "engine_claim_live_piece")).piece as { id: string; speaker: string; consultation_id: string } | null;
    if (!piece) { await page.waitForTimeout(1000); continue; }
    const ours = piece.consultation_id === id && piece.speaker === "patient";
    await rpc(engine.client, "engine_live_piece_done", { p_id: piece.id, p_text: ours ? "My name is Yana Novakova." : "" });
    written = ours;
  }
  expect(written).toBe(true);
  const line = panel.getByRole("listitem").filter({ hasText: "My name is Yana Novakova." });
  await line.getByRole("button", { name: "Correct" }).click({ timeout: 10_000 });
  await line.getByLabel("Correct this line").fill("My name is Jana Nováková.");
  await line.getByRole("button", { name: "Save" }).click();
  await expect(panel.getByText("My name is Jana Nováková.")).toBeVisible();
  await expect(panel.getByText("Watson will spell it your way")).toBeVisible();

  await page.getByRole("button", { name: "End call" }).click();
  await elsewhere.close();
  expect(problems).toEqual([]);
});
