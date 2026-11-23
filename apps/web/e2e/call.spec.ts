import { expect, signIn, test } from "./account";

test("a video call records both voices and starts transcription when it ends", async ({ page, account, browser, problems }) => {
  test.setTimeout(120_000);
  await signIn(page, account);
  await page.getByRole("link", { name: "New consultation" }).first().click();
  await page.getByLabel("Language spoken").selectOption("en");
  await page.getByLabel("Patient's name").fill("Jana Nováková");
  await page.getByLabel("Phone or email").fill(`+421 905 ${Math.floor(Math.random() * 9e5 + 1e5)}`);
  await page.getByRole("button", { name: "Create consultation" }).click();

  // The doctor starts the call and gets the link for the patient.
  await page.getByRole("link", { name: "Start video call" }).click();
  await page.getByRole("button", { name: "Start video call" }).click();
  await expect(page.getByText("Waiting for the patient")).toBeVisible();
  const link = await page.getByLabel("Send this link to the patient").inputValue();

  // The patient, in another browser with no account, opens the link and joins.
  const elsewhere = await browser.newContext({ permissions: ["microphone", "camera"] });
  const patient = await elsewhere.newPage();
  await patient.goto(link);
  await patient.getByRole("button", { name: "Join the call" }).click();
  await expect(patient.getByText("Recorded")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^Recording \d+:\d\d$/)).toBeVisible();
  await page.waitForTimeout(5000);

  // Ending the call saves both voices and starts transcription.
  await page.getByRole("button", { name: "End call" }).click();
  await expect(patient.getByText("The consultation has ended.")).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Transcri(bing|pt)$/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Practitioner · \d:\d\d · (WEBM|OGG)/)).toBeVisible();
  await expect(page.getByText(/Patient · \d:\d\d · (WEBM|OGG)/)).toBeVisible();
  await elsewhere.close();
  expect(problems).toEqual([]);
});

// Owner's test team, 23 Nov: the patient answers for themselves before joining. Saying no, the call
// goes ahead and nothing is recorded.
test("a patient who says no to recording joins a call that is not recorded", async ({ page, account, browser, problems }) => {
  test.setTimeout(120_000);
  await signIn(page, account);
  await page.getByRole("link", { name: "New consultation" }).first().click();
  await page.getByLabel("Patient's name").fill("Ema Mráz");
  await page.getByLabel("Phone or email").fill(`+421 905 ${Math.floor(Math.random() * 9e5 + 1e5)}`);
  await page.getByRole("button", { name: "Create consultation" }).click();
  await expect(page).toHaveURL(/\/consultation\/\?id=/);
  const consultation = page.url();
  await page.getByRole("link", { name: "Start video call" }).click();
  await page.getByRole("button", { name: "Start video call" }).click();
  const link = await page.getByLabel("Send this link to the patient").inputValue();

  const elsewhere = await browser.newContext({ permissions: ["microphone", "camera"] });
  const patient = await elsewhere.newPage();
  await patient.goto(link);
  await expect(patient.getByRole("heading", { name: "Before you join" })).toBeVisible();
  await expect(patient.getByText("Your voice is recorded and written down.")).toBeVisible();
  await patient.getByRole("button", { name: "Join without recording" }).click();
  await expect(patient.getByText("Not recorded")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Not recorded")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("The patient chose not to be recorded, so this call has no transcript.")).toBeVisible();
  await expect(page.getByText(/^Recording \d+:\d\d$/)).toHaveCount(0);

  await page.getByRole("button", { name: "End call" }).click();
  await expect(page).toHaveURL(consultation);
  await expect(page.getByText("Patient said no to recording")).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Transcri(bing|pt)$/ })).toHaveCount(0);
  await elsewhere.close();
  expect(problems).toEqual([]);
});
