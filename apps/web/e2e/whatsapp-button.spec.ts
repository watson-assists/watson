// The patient's "Message Watson on WhatsApp" button: on Watson's own gateway the number is the
// owner's, so the page asks for it with the patient's link instead of carrying it in its code.
import { expect, signIn, test } from "./account";

test("the patient's WhatsApp button opens the number given to their link, or the built-in one", async ({ page, account }) => {
  await signIn(page, account);
  await page.getByRole("link", { name: "New consultation" }).click();
  await page.getByLabel("Language spoken").selectOption("en");
  await page.getByLabel("Patient's name").fill("Jana Nováková");
  await page.getByLabel("Phone or email").fill(`+421 905 ${Math.floor(Math.random() * 9e5 + 1e5)}`);
  await page.getByRole("button", { name: "Create consultation" }).click();
  const link = await page.getByLabel("Link for the patient").inputValue();
  const button = (p: import("@playwright/test").Page) => p.getByRole("link", { name: "Message Watson on WhatsApp" });

  const builtIn = await page.context().browser()!.newPage();
  await builtIn.goto(link);
  await expect(button(builtIn)).toHaveAttribute("href", /^https:\/\/wa\.me\/15556623667\?text=Watson%20[0-9A-F]{8}$/);

  const gateway = await page.context().browser()!.newPage();
  await gateway.route("**/rest/v1/rpc/watson_whatsapp", (route) => route.fulfill({ json: { ok: true, number: "+421 900 000 123" } }));
  await gateway.goto(link);
  await expect(button(gateway)).toHaveAttribute("href", /^https:\/\/wa\.me\/421900000123\?text=Watson%20[0-9A-F]{8}$/);
});
