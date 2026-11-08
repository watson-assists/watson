// The browser may draw a native date picker in its locale, but its value remains an unambiguous local date.
import { expect, signIn, test } from "./account";

test.use({ locale: "en-US" });

test("in an American browser, a consultation uses a date picker and a 24-hour clock", async ({ page, account, problems }) => {
  await signIn(page, account);
  await page.getByRole("link", { name: "New consultation" }).first().click();
  const day = page.getByLabel("Date");
  const time = page.getByLabel("Time");
  await expect(day).toHaveAttribute("type", "date");
  await expect(day).toHaveValue(/^\d{4}-\d{2}-\d{2}$/); // today
  await expect(time).toHaveValue(/^([01]\d|2[0-3]):[0-5]\d$/); // now

  await time.fill("2:30 PM");
  await page.getByRole("button", { name: "Create consultation" }).click();
  await expect(page.getByText("Write the time on the 24-hour clock, like 14:30.")).toBeVisible();

  await day.fill("2026-10-27");
  await time.fill("14:30");
  await page.getByRole("button", { name: "Create consultation" }).click();
  await expect(page.getByText("Tue 27 Oct 2026, 14:30")).toBeVisible();
  expect(problems).toEqual([]);
});
