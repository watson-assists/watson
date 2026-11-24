// The doctor's own notes, a form without a recording, the form during the call, and what the patient
// gets (owner's test team, 23 Nov: notes "all considered for the diagnosis"; "the form filled alongside
// the conversation"; a call not recorded is filled in by hand; the report goes to the patient, never
// the intake or the conversation).
import { expect, signIn, test } from "./account";
import { sqlAsOwner } from "../tests/local-stack";

const contact = () => `+421 905 ${Math.floor(Math.random() * 9e5 + 1e5)}`;

async function newConsultation(page: import("@playwright/test").Page, name: string) {
  await page.getByRole("link", { name: "New consultation" }).first().click();
  await page.getByLabel("Language spoken").selectOption("en");
  await page.getByLabel("Patient's name").fill(name);
  await page.getByLabel("Phone or email").fill(contact());
  await page.getByRole("button", { name: "Create consultation" }).click();
  await expect(page).toHaveURL(/\/consultation\/\?id=/);
  return new URL(page.url()).searchParams.get("id")!;
}

test("without a recording, the doctor writes the form beside their notes, and the patient's copy leaves the intake out", async ({ page, account, problems }) => {
  await signIn(page, account);
  await newConsultation(page, "Mária Kováčová");
  await expect(page.getByRole("heading", { name: "Without a recording" })).toBeVisible();
  await page.getByLabel("Your notes").fill("Pale, tongue coated. Wakes at three.");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Your notes")).toHaveValue("Pale, tongue coated. Wakes at three.");

  await page.getByRole("button", { name: "Write it myself" }).click();
  await expect(page).toHaveURL(/\/form\/\?id=/);
  await expect(page.getByText(/^Written by you, without a recording/)).toBeVisible();
  await expect(page.getByLabel("Your notes")).toHaveValue("Pale, tongue coated. Wakes at three.");
  for (const [label, text] of [["Age", "42"], ["Main concern", "Wakes at three every night"], ["Assessment", "Vata imbalance"]]) {
    await page.getByRole("button", { name: `Add an answer: ${label}` }).click();
    await page.getByLabel("Your answer").fill(text);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("article").filter({ hasText: label }).getByText(text, { exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Approve form" }).click();
  await expect(page.getByText(/^Approved /)).toBeVisible();

  await page.getByRole("link", { name: "Print for the patient" }).click();
  await expect(page.getByText("Vaša konzultácia / Your consultation")).toBeVisible();
  await expect(page.getByText("Wakes at three every night")).toBeVisible();
  await expect(page.getByText("Vata imbalance")).toBeVisible();
  await expect(page.getByText("42", { exact: true })).toHaveCount(0); // the intake stays with the doctor
  await expect(page.getByText("Private notes")).toHaveCount(0);
  await expect(page.getByText("Pale, tongue coated.")).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("without a recording, Watson fills in the form from the doctor's notes", async ({ page, account, problems }) => {
  await signIn(page, account);
  await newConsultation(page, "Peter Novák");
  await page.getByRole("button", { name: "Fill in from my notes" }).click();
  await expect(page.getByText("Write your notes first, or add the patient’s documents")).toBeVisible();
  await page.getByLabel("Your notes").fill("Wakes at three every night. Coffee four times a day.");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Fill in from my notes" }).click();
  await expect(page.getByText("Filling in", { exact: true })).toBeVisible();
  await expect(page.getByText("Not recorded", { exact: true })).toBeVisible();
  await expect(page.getByText("No transcript", { exact: true })).toBeVisible();
  expect(problems).toEqual([]);
});

test("during the call, the doctor has Watson fill in the form so far, and sees what is still to ask", async ({ page, account, problems }) => {
  await signIn(page, account);
  const id = await newConsultation(page, "Eva Malá");
  await page.getByRole("link", { name: "Start video call" }).click();
  await page.getByRole("button", { name: "Start video call" }).click();
  await expect(page.getByText("Waiting for the patient")).toBeVisible();

  await page.getByRole("button", { name: "Fill in the form now" }).click();
  await expect(page.getByText("Nothing to go on yet. Let the patient speak first, or write a note.")).toBeVisible();
  await page.getByLabel("Your notes").fill("Wakes at three every night.");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Fill in the form now" }).click();
  await expect(page.getByText(/Watson is filling it in from the call so far/)).toBeVisible();

  // What the engine leaves (apps/clinical-worker: engine_complete_call_fill).
  sqlAsOwner(`update public.form_jobs set status = 'completed', finished_at = now(),
    preview = '[{"key": "sleep", "text": "Wakes at three every night"}]'
    where consultation_id = '${id}' and revision_kind = 'during_call';`);
  await expect(page.getByRole("heading", { name: "Still to ask" })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".wa-sofar")).toContainText("Main concern");
  await expect(page.locator(".wa-sofar")).not.toContainText("Sleep");
  await page.getByText("Answered (1)").click();
  await expect(page.getByText("Wakes at three every night", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Fill in again" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("the doctor speaks a note, and Watson's words join their notes", async ({ page, account, problems }) => {
  await signIn(page, account);
  const id = await newConsultation(page, "Jozef Malý");
  await page.getByLabel("Your notes").fill("Pale.");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Speak a note" }).click();
  await expect(page.getByText("Listening. Watson writes it down when you stop.")).toBeVisible();
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: /^Stop · 0:0\d$/ }).click();
  await expect(page.getByText("Writing down your note…")).toBeVisible();
  await expect(page.getByLabel("Your notes")).toHaveAttribute("readonly", "");

  // What the live worker leaves (apps/clinical-worker: engine_voice_note_done), once the file arrived.
  await expect.poll(() => sqlAsOwner(`select count(*) from public.voice_notes v join storage.objects o
    on o.bucket_id = 'audio' and o.name = v.storage_path where v.consultation_id = '${id}';`)).toBe("1");
  sqlAsOwner(`update public.voice_notes set status = 'done' where consultation_id = '${id}';
    update public.doctor_notes set text = text || E'\\n\\nWakes at three every night.' where consultation_id = '${id}';`);
  await expect(page.getByLabel("Your notes")).toHaveValue("Pale.\n\nWakes at three every night.", { timeout: 10_000 });
  await expect(page.getByLabel("Your notes")).not.toHaveAttribute("readonly");
  expect(problems).toEqual([]);
});
