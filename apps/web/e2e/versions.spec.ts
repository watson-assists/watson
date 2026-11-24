// Changing an approved form (owner's test team, 23 Nov, point 5): only the doctor who approved it, as a
// new version; the earlier one is kept, and the change shows who made it, when and what changed.
import { expect, signIn, test } from "./account";
import { browserClient, localStack, sqlAsOwner } from "../tests/local-stack";

test("the doctor changes an approved form: a new version, with what changed, and the patient sees it once approved", async ({ page, account, problems }) => {
  await signIn(page, account);
  await page.getByRole("link", { name: "New consultation" }).first().click();
  await page.getByLabel("Patient's name").fill("Jana Nováková");
  await page.getByLabel("Phone or email").fill(`+421 905 ${Math.floor(Math.random() * 9e5 + 1e5)}`);
  // Watson's own form, whatever another test made this account's default.
  const form = page.getByLabel("Consultation form");
  await form.selectOption((await form.locator("option", { hasText: /^Ayurvedic consultation/ }).first().getAttribute("value"))!);
  await page.getByRole("button", { name: "Create consultation" }).click();
  await expect(page).toHaveURL(/\/consultation\/\?id=/);
  const id = new URL(page.url()).searchParams.get("id")!;
  await page.getByRole("button", { name: "Write it myself" }).click();
  const write = async (label: string, text: string) => {
    await page.getByRole("button", { name: `Add an answer: ${label}` }).click();
    await page.getByLabel("Your answer").fill(text);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("article").filter({ hasText: label }).getByText(text, { exact: true })).toBeVisible();
  };
  await write("Main concern", "Wakes at three every night");
  await page.getByRole("button", { name: "Approve form" }).click();
  await expect(page.getByText(/^Approved /)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Versions" })).toHaveCount(0); // one version: nothing to compare

  // A change that is discarded leaves the approved form as it was.
  await page.getByRole("button", { name: "Change the form" }).click();
  await expect(page.getByText("Changing the approved form")).toBeVisible();
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(page.getByText(/^Approved /)).toBeVisible();

  // A change that is approved becomes version 2; the patient sees it only then.
  const token = sqlAsOwner(`select invite_token from public.consultations where id = '${id}';`);
  const patientSees = async () => JSON.stringify(((await browserClient(localStack()).rpc("patient_report", { p_token: token })).data as { report: unknown }).report);
  await page.getByRole("button", { name: "Change the form" }).click();
  await expect(page.getByText("Changing the approved form")).toBeVisible();
  await page.getByRole("article").filter({ hasText: "Main concern" }).getByRole("button", { name: "Change" }).click();
  await write("Main concern", "Sleeps through since the new routine");
  expect(await patientSees()).toContain("Wakes at three every night");
  await page.getByRole("button", { name: "Approve changes" }).click();
  await expect(page.getByText(/^Approved /)).toBeVisible();
  expect(await patientSees()).toContain("Sleeps through since the new routine");

  const versions = page.getByRole("region", { name: "Versions" });
  await expect(versions.getByText(/^Version 2 · approved .* by /)).toBeVisible();
  await expect(versions.getByText(/^Version 1 · approved /)).toBeVisible();
  await expect(versions.locator(".wa-versions__changes li").filter({ hasText: "Main concern:" })).toContainText("Wakes at three every night → Sleeps through since the new routine");
  expect(problems).toEqual([]);
});
