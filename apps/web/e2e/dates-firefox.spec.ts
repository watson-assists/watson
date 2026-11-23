// The browser may draw a native date picker in its locale, but its value remains an unambiguous local date.
import { expect, signIn, test } from "./account";

test.use({ locale: "en-US" });

test("in an American browser, a new consultation starts today and now, with a date and a time picker", async ({ page, account, problems }) => {
  await signIn(page, account);
  await page.getByRole("link", { name: "New consultation" }).first().click();
  const day = page.getByLabel("Date");
  const time = page.getByLabel("Time");
  await expect(day).toHaveAttribute("type", "date");
  await expect(time).toHaveAttribute("type", "time");
  const now = new Date();
  await expect(day).toHaveValue(now.toLocaleDateString("sv")); // today, as YYYY-MM-DD
  const [hours, minutes] = (await time.inputValue()).split(":").map(Number);
  expect(Math.abs(hours * 60 + minutes - (now.getHours() * 60 + now.getMinutes()))).toBeLessThanOrEqual(2); // now

  await day.fill("2026-10-27");
  await time.fill("14:30");
  await page.getByLabel("Patient's name").fill("Jana Nováková");
  await page.getByLabel("Phone or email").fill(`+421 905 ${Math.floor(Math.random() * 9e5 + 1e5)}`);
  await page.getByRole("button", { name: "Create consultation" }).click();
  await expect(page.getByText("Tue 27 Oct 2026, 14:30")).toBeVisible();
  expect(problems).toEqual([]);
});
