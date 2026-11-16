// Prices (owner, 24 Oct: the doctor "needs to have two prices, a base consultation and when a doctor
// creates a consultation he should be able to put any price including 0 and when its 0 the payment
// needs to be bypassed"). The usual fee is set in Practice; each consultation may differ, or be free.
import { expect, signIn, test } from "./account";
import { localStack, newPractitioner, PASSWORD } from "../tests/local-stack";

test("the usual fee starts each new consultation, 0 makes one free, and an unpaid one can be made free", async ({ page, problems }) => {
  const who = await newPractitioner(localStack(), "prices"); // a fee of its own, not the shared account's
  await signIn(page, { email: who.email, password: PASSWORD, references: [] });
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Practice" }).click();
  await page.getByLabel("Usual fee").fill("40");
  const yours = page.getByRole("region", { name: "Your page for patients" });
  await yours.getByLabel("Name patients see").fill("Dr. Eva Test");
  await yours.getByLabel("English").check();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

  const patient = page.getByRole("region", { name: "Patient", exact: true });
  const free = patient.getByText("The patient opens the link and waits for you to start the call.");
  async function create(fee?: string) {
    await page.goto("/consultations/new/");
    await expect(page.getByLabel("Fee")).toHaveValue("40.00");
    if (fee !== undefined) await page.getByLabel("Fee").fill(fee);
    await page.getByLabel("Patient's name").fill("Jana Nováková");
    await page.getByLabel("Phone or email").fill(`+421 905 ${Math.floor(Math.random() * 9e5 + 1e5)}`);
    await page.getByRole("button", { name: "Create consultation" }).click();
  }

  await create("0");
  await expect(free).toBeVisible();
  await expect(patient.getByText("Not paid yet")).toHaveCount(0);

  await create();
  await expect(patient.getByText("Not paid yet")).toBeVisible();
  await expect(patient.getByText(/The patient pays €40\.00 when they open the link/)).toBeVisible();
  await patient.getByRole("button", { name: "Make it free" }).click();
  await expect(free).toBeVisible();
  await expect(patient.getByText("Not paid yet")).toHaveCount(0);
  expect(problems).toEqual([]);
});
