// A call recorded in Firefox (owner's test of 24 Oct: the upload failed with a 400). Firefox records
// Ogg and leaves the recording unlabelled, so Watson must recognise the audio itself. Firefox's fake
// camera and microphone come from the project's settings in playwright.config.ts.
import { expect, signIn, test } from "./account";

test("a call recorded in Firefox is saved and goes to transcription", async ({ page, account, browser, problems }) => {
  test.setTimeout(120_000);
  await signIn(page, account);
  await page.getByRole("link", { name: "New consultation" }).first().click();
  await page.getByLabel("Language spoken").selectOption("en");
  await page.getByLabel("Patient's name").fill("Jana Nováková");
  await page.getByLabel("Phone or email").fill(`+421 905 ${Math.floor(Math.random() * 9e5 + 1e5)}`);
  await page.getByRole("button", { name: "Create consultation" }).click();

  await page.getByRole("link", { name: "Start video call" }).click();
  await page.getByRole("button", { name: "Start video call" }).click();
  await expect(page.getByText("Waiting for the patient")).toBeVisible();
  const link = await page.getByLabel("Send this link to the patient").inputValue();

  const elsewhere = await browser.newContext();
  const patient = await elsewhere.newPage();
  await patient.goto(link);
  await patient.getByRole("button", { name: "Join the call" }).click();
  await expect(patient.getByText("Recorded")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(5000);

  await page.getByRole("button", { name: "End call" }).click();
  await expect(page.getByRole("heading", { name: /^Transcri(bing|pt)$/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Practitioner · \d:\d\d · OGG/)).toBeVisible();
  await expect(page.getByText(/Patient · \d:\d\d · OGG/)).toBeVisible();
  await elsewhere.close();
  expect(problems).toEqual([]);
});
