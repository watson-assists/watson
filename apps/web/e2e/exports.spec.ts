// Watson's own form and taking it out (owner, 24 Oct): the practitioner picks Excel or PDF, for one
// consultation or all their patients at once; private notes are theirs alone; a practitioner without
// a form of their own fills in Watson's with one press.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { strFromU8, unzipSync } from "fflate";
import { expect, signIn, test } from "./account";
import { localStack, newPractitioner, PASSWORD, sqlAsOwner } from "../tests/local-stack";

async function as(account: { email: string; password: string }) {
  const stack = localStack();
  const client = createClient(stack.url, stack.publishableKey, { auth: { persistSession: false } });
  await client.auth.signInWithPassword({ email: account.email, password: account.password });
  return client;
}
const contact = () => `+421 905 ${Math.floor(Math.random() * 9e5 + 1e5)}`;
const sheets = (path: string) => Object.fromEntries(Object.entries(unzipSync(readFileSync(path)))
  .filter(([name]) => name.startsWith("xl/worksheets/")).map(([name, data]) => [name, strFromU8(data)]));

/** A consultation with a transcript and a form Watson has filled in, as the engine would leave them. */
async function filledIn(account: { email: string; password: string }, name: string) {
  const client = await as(account);
  const made = await client.rpc("create_consultation", {
    p_scheduled_at: "2026-10-27T09:00:00Z", p_language: "en", p_consent_recorded: true, p_patient_name: name, p_patient_contact: contact(),
  });
  const id = (made.data as { consultation_id: string }).consultation_id;
  sqlAsOwner(`
    with j as (insert into public.transcription_jobs (consultation_id, requested_by, status, finished_at)
               select id, practitioner_id, 'completed', now() from public.consultations where id = '${id}' returning id),
    t as (insert into public.transcripts (consultation_id, job_id, schema_version, ordering, low_confidence_threshold, tracks)
          select '${id}', id, '2.0.0', 'exact', 0.5, '[]' from j returning id),
    s as (insert into public.transcript_segments (id, transcript_id, position, speaker, start_seconds, end_seconds, machine_text)
          select gen_random_uuid(), t.id, 0, 'patient', 3, 6, 'I wake at three every night.' from t returning 1),
    fj as (insert into public.form_jobs (
             consultation_id, transcript_id, form_template_version_id, status, finished_at
           )
           select '${id}', t.id,
             coalesce(
               (select form_template_version_id from public.consultations where id = '${id}'),
               (select id from public.form_template_versions
                where is_built_in and template_key = 'watson_standard'
                order by version_number desc limit 1)
             ),
             'completed', now()
           from t returning id, transcript_id),
    f as (insert into public.forms (consultation_id, job_id, transcript_id, template)
          select '${id}', fj.id, fj.transcript_id, private.watson_form() from fj returning id)
    insert into public.form_answers (
      form_id, field_key, position, machine_text, evidence,
      answer_state, machine_state, machine_value
    )
      select f.id, field ->> 'key', n - 1,
             case field ->> 'key' when 'sleep' then 'Wakes at three every night' when 'age' then '42' end,
             case when field ->> 'key' = 'sleep' then '{0}'::int[] else '{}'::int[] end,
             case when field ->> 'key' in ('sleep', 'age') then 'known' else 'unanswered' end,
             case when field ->> 'key' in ('sleep', 'age') then 'known' else 'unanswered' end,
             case field ->> 'key'
               when 'sleep' then to_jsonb('Wakes at three every night'::text)
               when 'age' then to_jsonb('42'::text)
             end
      from f, jsonb_array_elements((select jsonb_agg(x) from jsonb_array_elements(private.watson_form() -> 'sections') s,
                                    jsonb_array_elements(s -> 'fields') x)) with ordinality as e(field, n);
    update public.consultations set status = 'draft_ready' where id = '${id}';`);
  return id;
}

test("one consultation is taken out as Excel, with the form in order and the conversation", async ({ page, account, problems }) => {
  const id = await filledIn(account, "Jana Nováková");
  await signIn(page, account);
  await page.goto(`/form/?id=${id}`);
  const saving = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download as Excel" }).click();
  const file = await saving;
  expect(file.suggestedFilename()).toMatch(/^Jana Nováková 27-10-2026\.xlsx$/);
  const book = sheets(await file.path());
  expect(book["xl/worksheets/sheet1.xml"]).toContain("Wakes at three every night");
  expect(book["xl/worksheets/sheet1.xml"]).toContain("Medicines and supplements");
  expect(book["xl/worksheets/sheet2.xml"]).toContain("I wake at three every night.");
  expect(problems).toEqual([]);
});

test("one consultation is printed, or saved as PDF, from a clean page with one Print button", async ({ page, account, problems }) => {
  const id = await filledIn(account, "Ema Mráz");
  await signIn(page, account);
  await page.goto(`/form/?id=${id}`);
  await page.getByRole("link", { name: "Print or save as PDF" }).click();
  await expect(page.getByRole("heading", { name: "Ema Mráz", level: 1 })).toBeVisible();
  await expect(page.getByText("Wakes at three every night")).toBeVisible();
  await expect(page.getByText("Private notes")).toBeVisible();
  await expect(page.getByText("I wake at three every night.").first()).toBeVisible();
  await page.evaluate(() => { window.print = () => { document.body.dataset.printed = "yes"; }; });
  await page.getByRole("button", { name: "Print or save as PDF" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-printed", "yes");
  expect(problems).toEqual([]);
});

test("all patients are taken out at once as Excel, one row each", async ({ page, account, problems }) => {
  await filledIn(account, "Peter Adamec");
  await signIn(page, account);
  const saving = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download all as Excel" }).click();
  const book = sheets(await (await saving).path());
  expect(book["xl/worksheets/sheet1.xml"]).toContain("Peter Adamec");
  expect(book["xl/worksheets/sheet1.xml"]).toContain("Wakes at three every night");
  await page.getByRole("link", { name: "Print all or save as PDF" }).click();
  await expect(page.getByRole("heading", { name: "Peter Adamec" }).first()).toBeVisible();
  expect(problems).toEqual([]);
});

test("private notes are the practitioner's to write", async ({ page, account, problems }) => {
  const id = await filledIn(account, "Zuzana Kováčová");
  await signIn(page, account);
  await page.goto(`/form/?id=${id}`);
  const notes = page.getByRole("article").filter({ hasText: "Private notes" });
  await expect(notes.getByText("Only you see this")).toBeVisible();
  await notes.getByRole("button", { name: "Write" }).click();
  await notes.getByLabel("Your answer").fill("Call back in a week.");
  await notes.getByRole("button", { name: "Save" }).click();
  await expect(notes.getByText("Call back in a week.")).toBeVisible();
  expect(problems).toEqual([]);
});

test("without a custom form, the practitioner automatically gets Watson's built-in", async ({ page, problems }) => {
  // A practitioner of its own gets the immutable Watson fallback, which must not affect the account
  // the other tests share.
  const who = await newPractitioner(localStack(), "no-form");
  const account = { email: who.email, password: PASSWORD, references: [] };
  const client = await as(account);
  const made = await client.rpc("create_consultation", {
    p_scheduled_at: "2026-10-27T09:00:00Z", p_language: "en", p_consent_recorded: true, p_patient_name: "Ján Malý", p_patient_contact: contact(),
  });
  const id = (made.data as { consultation_id: string }).consultation_id;
  sqlAsOwner(`
    with j as (insert into public.transcription_jobs (consultation_id, requested_by, status, finished_at)
               select id, practitioner_id, 'completed', now() from public.consultations where id = '${id}' returning id),
    t as (insert into public.transcripts (consultation_id, job_id, schema_version, ordering, low_confidence_threshold, tracks)
          select '${id}', id, '2.0.0', 'exact', 0.5, '[]' from j returning id)
    insert into public.transcript_segments (id, transcript_id, position, speaker, start_seconds, end_seconds, machine_text)
      select gen_random_uuid(), t.id, 0, 'patient', 1, 2, 'Hello.' from t;
    update public.consultations set status = 'transcript_ready' where id = '${id}';`);
  await signIn(page, account);
  await page.goto(`/consultation/?id=${id}`);
  await expect(page.getByRole("heading", { name: "Filling in your form" })).toBeVisible();
  expect(problems).toEqual([]);
});
