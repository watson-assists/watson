// Getting around (owner, 25 Nov: "the home icon and the title on every page should take you home …
// ensure all navigation works as expected on mobiles and desktops"). On a phone and on a desktop: the
// Watson logo goes home, Home and Practice work and show where you are, every back link goes back, a
// call asks before it is left, and an address that does not exist offers a way back.
import { expect, signIn, test } from "./account";
import { browserClient, localStack, rpc, sqlAsOwner } from "../tests/local-stack";

for (const [device, viewport] of [["phone", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 900 }]] as const) {
  test.describe(device, () => {
    test.use({ viewport });

    test("the doctor's pages: the logo and Home go home, back links go back, the menu shows where you are", async ({ page, account, problems }) => {
      const doctor = browserClient(localStack());
      await doctor.auth.signInWithPassword({ email: account.email, password: account.password });
      const made = await rpc(doctor, "create_consultation", { p_scheduled_at: new Date(Date.now() + 3600_000).toISOString(), p_language: "en",
        p_consent_recorded: false, p_patient_name: "Jana Nováková", p_patient_contact: `+421 905 ${Math.floor(Math.random() * 9e5 + 1e5)}` });
      const id = made.consultation_id as string;
      await rpc(doctor, "start_form_without_recording", { p_consultation_id: id, p_by_watson: false });
      await signIn(page, account);
      const menu = page.getByRole("navigation", { name: "Main" });
      const home = /\/consultations\/$/;

      await page.goto(`/consultation/?id=${id}`);
      await expect(menu.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "true");
      await page.getByRole("link", { name: "Watson, home" }).click();
      await expect(page).toHaveURL(home);
      await expect(menu.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
      await menu.getByRole("link", { name: "Practice" }).click();
      await expect(page).toHaveURL(/\/calendar\/$/);
      await expect(menu.getByRole("link", { name: "Practice" })).toHaveAttribute("aria-current", "page");
      await menu.getByRole("link", { name: "Home" }).click();
      await expect(page).toHaveURL(home);

      // Back links: printout to the form, the form to the consultation, the consultation to Home.
      await page.goto(`/print/?id=${id}`);
      await page.getByRole("link", { name: "The form" }).click();
      await expect(page).toHaveURL(new RegExp(`/form/\\?id=${id}$`));
      await page.getByRole("link", { name: "Consultation", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/consultation/\\?id=${id}$`));
      await page.getByRole("link", { name: "Consultations", exact: true }).click();
      await expect(page).toHaveURL(home);
      await page.getByRole("link", { name: "New consultation" }).first().click();
      await page.getByRole("link", { name: "Consultations", exact: true }).click();
      await expect(page).toHaveURL(home);
      expect(problems).toEqual([]);
    });

    test("during a call, the logo and the menu ask before leaving it", async ({ page, account }) => {
      const doctor = browserClient(localStack());
      await doctor.auth.signInWithPassword({ email: account.email, password: account.password });
      const made = await rpc(doctor, "create_consultation", { p_scheduled_at: new Date(Date.now() + 3600_000).toISOString(), p_language: "en",
        p_consent_recorded: true, p_patient_name: "Eva Malá", p_patient_contact: `+421 905 ${Math.floor(Math.random() * 9e5 + 1e5)}` });
      await signIn(page, account);
      await page.goto(`/room/?id=${made.consultation_id}`);
      await page.getByRole("button", { name: "Start video call" }).click();
      await expect(page.getByText("Waiting for the patient")).toBeVisible();
      page.once("dialog", (dialog) => void dialog.dismiss());
      await page.getByRole("link", { name: "Watson, home" }).click();
      await expect(page).toHaveURL(/\/room\//);
      await expect(page.getByRole("button", { name: "End call" })).toBeVisible();
      let asked = "";
      page.once("dialog", (dialog) => { asked = dialog.message(); void dialog.accept(); });
      await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Home" }).click();
      await expect(page).toHaveURL(/\/consultations\/$/);
      expect(asked).toMatch(/^Leave the call\?/);
    });

    test("public pages: the logo goes to the front page; an unknown address offers a way back", async ({ page }) => {
      const token = sqlAsOwner("select invite_token from public.consultations where status = 'consent_pending' order by created_at desc limit 1;");
      for (const [path, logo] of [["/privacy/", "Watson, find a practitioner"], ["/sign-in/", "Watson home"],
        ["/patient/sign-in/", "Watson home"], [`/join/?t=${token}`, "Watson, find a practitioner"]] as const) {
        await page.goto(path);
        await page.getByRole("link", { name: logo }).click();
        await expect(page.getByRole("heading", { name: "Find a practitioner", level: 1 })).toBeVisible();
        await expect(page).toHaveURL(/\/$/);
      }
      await page.goto("/no-such-page/");
      await expect(page.getByRole("heading", { name: "This page does not exist" })).toBeVisible();
      await page.getByRole("link", { name: "Find a practitioner", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Find a practitioner", level: 1 })).toBeVisible();
    });
  });
}
