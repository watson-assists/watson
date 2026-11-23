import { fileURLToPath } from "node:url";
import { expect, signIn, test } from "./account";

const LAB_PHOTO = fileURLToPath(new URL("../../../packages/test-fixtures/documents/lab-report-sk.jpg", import.meta.url));

// The patient sends a document from their link; the practitioner sees it under the patient's
// name; the patient can take it back. Works locally and against the deployed app.
test("a patient sends a document from their link, and the practitioner sees it", async ({ page, account, problems }) => {
  test.setTimeout(90_000);
  await signIn(page, account);
  await page.getByRole("link", { name: "New consultation" }).click();
  await page.getByLabel("Language spoken").selectOption("en");
  // The practitioner names the patient (required since 11 Nov); the patient confirms the same number.
  const number = `+421 9${String(Date.now()).slice(-8)}`;
  await page.getByLabel("Patient's name").fill("Jana Nováková");
  await page.getByLabel("Phone or email").fill(number);
  await page.getByRole("button", { name: "Create consultation" }).click();
  const link = await page.getByLabel("Link for the patient").inputValue();
  const consultation = page.url();

  const patient = await page.context().browser()!.newPage();
  await patient.goto(link);
  const documents = patient.getByRole("region", { name: "Documents for your practitioner" });
  // Without a usable phone number nothing is sent, and the page says what to type.
  await documents.getByLabel("Your name").fill("Jana Nováková");
  await documents.getByLabel("Phone or email").fill("0900 123 456");
  await documents.getByLabel("Documents to send").setInputFiles(LAB_PHOTO);
  await expect(documents.getByText("Enter a phone number with its country code")).toBeVisible();

  await documents.getByLabel("Phone or email").fill(number);
  await documents.getByLabel("Documents to send").setInputFiles(LAB_PHOTO);
  const sent = documents.getByRole("list", { name: "Documents you sent" });
  await expect(sent.getByText("lab-report-sk.jpg")).toBeVisible();
  await expect(sent.getByText("Sent")).toBeVisible();

  await page.goto(consultation);
  await expect(page.getByRole("heading", { name: "Jana Nováková" })).toBeVisible();
  const panel = page.getByRole("region", { name: "Documents" });
  await expect(panel.getByText("lab-report-sk.jpg")).toBeVisible();
  await expect(panel.getByText(/^sent by the patient /)).toBeVisible();
  await expect(panel.getByText("1 sent by the patient")).toBeVisible();
  // Owner, 23 Nov: a document opens over the page, in the same window, and closes back to it.
  await panel.getByRole("button", { name: "Open lab-report-sk.jpg" }).click();
  const viewer = page.getByRole("dialog", { name: "lab-report-sk.jpg" });
  await expect(viewer.getByRole("img", { name: "lab-report-sk.jpg" })).toBeVisible();
  expect(page.context().pages()).toHaveLength(1);
  await viewer.getByRole("button", { name: "Close" }).click();
  await expect(viewer).toBeHidden();

  await sent.getByRole("button", { name: "Remove lab-report-sk.jpg" }).click();
  await expect(sent.getByText("Removal pending")).toBeVisible();
  await expect(sent.getByRole("button", { name: "Retry removal of lab-report-sk.jpg" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("region", { name: "Documents" }).getByText("lab-report-sk.jpg")).toHaveCount(0);
  await patient.close();
  expect(problems).toEqual([]);
});
