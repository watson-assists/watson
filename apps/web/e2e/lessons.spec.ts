// What Watson has learned from the doctor's corrections (plan step 4, 25 Nov 2026), on Practice:
// each lesson in plain words, and the doctor can make Watson forget it, or bring it back.
import { expect, signIn, test } from "./account";
import { sqlAsOwner } from "../tests/local-stack";

test("the doctor sees what Watson learned from them, forgets a lesson and brings it back", async ({ page, account, problems }) => {
  // As the engine keeps them after a form (engine_save_lessons).
  sqlAsOwner(`insert into public.practitioner_lessons (practitioner_id, key, said, seen)
    select id, l.key, l.said, l.seen from auth.users,
      (values ('word:imbalance>vitiation', 'You write "vitiation" where Watson wrote "imbalance".', 3),
              ('empty:referral', 'You usually clear "Referral or tests": Watson fills it only when you say it.', 2)) l(key, said, seen)
    where email = '${account.email}'
    on conflict (practitioner_id, key) do update set forgotten_at = null;`);
  await signIn(page, account);
  await page.goto("/calendar/");
  const panel = page.getByRole("region", { name: "What Watson has learned from you" });
  const lesson = panel.getByRole("listitem").filter({ hasText: "Referral or tests" });
  await expect(panel.getByText('You write "vitiation" where Watson wrote "imbalance".')).toBeVisible();

  await lesson.getByRole("button", { name: "Forget" }).click();
  await expect(panel.getByText("Forgotten (1)")).toBeVisible();
  await panel.getByText("Forgotten (1)").click();
  await lesson.getByRole("button", { name: "Bring back" }).click();
  await expect(lesson.getByRole("button", { name: "Forget" })).toBeVisible();
  await expect(panel.getByText(/^Forgotten/)).toHaveCount(0);
  expect(problems).toEqual([]);
});
