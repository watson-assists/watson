// The third part of the record (owner, 23 Nov): the doctor's own shop, prescriptions from it, and the
// patient's own page on their link: the report, the instructions, and the products to buy through
// Stripe. Stripe itself is stood in for here; the database does what the payment function would.
import { expect, signIn, test } from "./account";
import { sqlAsOwner } from "../tests/local-stack";

// A 1×1 PNG: the product's photo.
const PHOTO = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

test("the doctor prescribes from their own shop; the patient reads the report and buys; the doctor sends it", async ({ page, account, browser, baseURL, problems }) => {
  test.setTimeout(90_000);
  await signIn(page, account);
  await page.goto("/calendar/");
  await page.getByRole("button", { name: "Add a product" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Tulsi tea");
  await page.getByLabel("Price (€)").fill("6,50");
  await page.getByLabel("What it is").fill("Holy basil, 20 bags.");
  await page.getByLabel(/^Photo/).setInputFiles({ name: "tulsi.png", mimeType: "image/png", buffer: PHOTO });
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page.getByText("Tulsi tea · €6.50")).toBeVisible();

  // A consultation without a recording, written by the doctor, with a prescription.
  await page.getByRole("link", { name: "Home", exact: true }).click();
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
  for (const [label, text] of [["Age", "42"], ["Main concern", "Wakes at three every night"], ["Assessment", "Vata imbalance"]]) {
    await page.getByRole("button", { name: `Add an answer: ${label}` }).click();
    await page.getByLabel("Your answer").fill(text);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("article").filter({ hasText: label }).getByText(text, { exact: true })).toBeVisible();
  }
  await page.getByLabel("Product", { exact: true }).selectOption({ label: "Tulsi tea · €6.50" });
  await page.getByLabel("Quantity", { exact: true }).fill("2");
  await page.getByLabel("How to take it").fill("A cup after dinner");
  await page.getByRole("button", { name: "Prescribe" }).click();
  await expect(page.getByText("2 × Tulsi tea")).toBeVisible();
  await page.getByRole("button", { name: "Approve form" }).click();
  await expect(page.getByText(/^Approved /)).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove Tulsi tea" })).toHaveCount(0);
  await page.getByRole("link", { name: "Print for the patient" }).click();
  await expect(page.getByRole("heading", { name: "Lieky / Medicines" })).toBeVisible();
  await expect(page.getByText("2 × Tulsi tea")).toBeVisible();

  // The patient, on their link: the report and the medicines, never the intake.
  const token = sqlAsOwner(`select invite_token from public.consultations where id = '${id}';`);
  const item = sqlAsOwner(`select id from public.prescription_items where consultation_id = '${id}';`);
  const elsewhere = await browser.newContext();
  const patient = await elsewhere.newPage();
  const asked: unknown[] = [];
  await patient.route("**/functions/v1/payment", async (route) => {
    const body = route.request().postDataJSON() as { items?: string[]; session_id?: string };
    asked.push(body);
    if (body.items) {
      // What the payment function and Stripe's webhook do: an order of these items, paid, with an address.
      sqlAsOwner(`select public.record_shop_payment((o ->> 'order_id')::uuid, '${id}', 'cs_test_e2e${Date.now()}', (o ->> 'total_cents')::int,
        '{"name": "Jana Nováková", "address": {"line1": "Hlavná 1", "postal_code": "811 01", "city": "Bratislava", "country": "SK"}}')
        from (select public.open_shop_order('${token}', array['${item}']::uuid[]) as o) opened;`);
      return route.fulfill({ json: { url: `${baseURL}/join/?t=${token}&session_id=cs_test_e2e` } });
    }
    return route.fulfill({ json: { paid: true } });
  });
  await patient.goto(`/join/?t=${token}`);
  await expect(patient.getByRole("heading", { name: "Your report" })).toBeVisible();
  await expect(patient.getByText("Wakes at three every night")).toBeVisible();
  await expect(patient.getByText("Vata imbalance")).toBeVisible();
  await expect(patient.getByText("42", { exact: true })).toHaveCount(0);
  await expect(patient.getByText("A cup after dinner")).toBeVisible();
  await expect(patient.getByText("€6.50 each")).toBeVisible();
  await expect(patient.getByRole("button", { name: "Join the call" })).toHaveCount(0);
  await patient.getByRole("button", { name: "Buy for €13.00" }).click();
  await expect(patient.getByText(/^Paid .*Thank you\.$/)).toBeVisible();
  await expect(patient.getByText(/2 × Tulsi tea, €13\.00/)).toBeVisible();
  expect(asked[0]).toEqual({ token, items: [item] });

  // The doctor sends it.
  await page.goto("/calendar/");
  await expect(page.getByText("Send to: Jana Nováková, Hlavná 1, 811 01 Bratislava, SK")).toBeVisible();
  await page.getByRole("button", { name: "Mark as sent" }).click();
  await expect(page.getByText(/^No orders waiting\./)).toBeVisible();
  await patient.reload();
  await expect(patient.getByText(/^Sent /)).toBeVisible();
  await elsewhere.close();
  expect(problems).toEqual([]);
});
