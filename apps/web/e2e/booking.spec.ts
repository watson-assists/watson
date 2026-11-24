import { expect, signIn, test } from "./account";
import { adminClient, browserClient, localStack, PASSWORD, sqlAsOwner } from "../tests/local-stack";

test("warns the doctor that changed booking hours are not live until saved", async ({ page, account }) => {
  await signIn(page, account);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Practice" }).click();
  const hours = page.getByRole("region", { name: "Hours patients can book" });
  const monday = hours.getByLabel("Monday", { exact: true });
  if (await monday.isChecked()) await monday.uncheck();
  else await monday.check();

  await expect(page.getByRole("status").filter({ hasText: "Hours changed but not saved" })).toBeVisible();
});

// The whole booking path in two browsers: the practitioner opens hours on their page; a patient
// with no account finds them, books a time and lands on their link; the booking reaches Home.
// The page is free, so no payment step (Stripe's page cannot run against the local stack).
test("a practitioner opens hours, a patient books one, the practitioner sees it", async ({ page, account, browser, problems }) => {
  const name = `Dr. Test ${Math.floor(1000 + Math.random() * 9000)}`;
  await signIn(page, account);
  await expect(page.getByText(/^Watson's laptop is (on|off)/)).toBeVisible();

  // Practice: no Google yet, so it offers to connect; then the hours and the page.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Practice" }).click();
  await expect(page.getByRole("heading", { name: "Practice", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Google Calendar" })).toBeVisible();
  const hours = page.getByRole("region", { name: "Hours patients can book" });
  for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]) {
    await hours.getByLabel(day, { exact: true }).check();
    await hours.getByLabel(`${day} from`).selectOption("06:00");
    await hours.getByLabel(`${day} until`).selectOption("22:00");
  }
  await hours.getByLabel("Fee").fill("");
  const yours = page.getByRole("region", { name: "Your page for patients" });
  await yours.getByLabel("Name patients see").fill(name);
  await yours.getByLabel("What you offer").fill("Ayurveda · sleep");
  await yours.getByLabel("English").check();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await expect(page.locator(".wa-block--open").first()).toBeVisible();

  // A patient, in a browser of their own, without an account.
  const patientContext = await browser.newContext();
  const patient = await patientContext.newPage();
  await patient.goto("/find/");
  await expect(patient.getByRole("heading", { name: "Find a practitioner" })).toBeVisible();
  const card = patient.getByRole("article").filter({ has: patient.getByRole("heading", { name }) });
  await expect(card.getByText(/^Next free: /)).toBeVisible();
  await card.getByRole("link", { name: "See times" }).click();

  await expect(patient.getByRole("heading", { name, level: 1 })).toBeVisible();
  const chooser = patient.getByRole("region", { name: "Choose a time" });
  await expect(chooser.locator('.wa-day[aria-pressed="true"]')).toHaveCount(0);
  await expect(chooser.locator(".wa-time")).toHaveCount(0);
  await chooser.locator(".wa-day:not(:disabled)").first().click();
  const firstTime = chooser.getByRole("group").getByRole("button").first();
  const chosen = (await firstTime.textContent())!.trim();
  await firstTime.click();
  await expect(firstTime).toHaveAttribute("aria-pressed", "true");
  await patient.getByRole("link", { name: "Continue" }).click();

  await expect(patient.getByRole("heading", { name: "Your details" })).toBeVisible();
  await expect(patient.getByText(chosen, { exact: false }).first()).toBeVisible();
  await patient.getByLabel("Your name").fill("Jana Nováková");
  await patient.getByLabel("Phone or email").fill("+421 905 111 222");
  await patient.getByLabel("Language for the consultation").selectOption("en");
  await patient.getByRole("button", { name: "Book this time" }).click();
  await expect(patient.getByRole("heading", { name: "Your consultation" })).toBeVisible();
  await expect(patient).toHaveURL(/\/join\/\?t=[0-9a-f]{64}$/);

  await patientContext.close();

  // Home names the booking; the calendar shows it in ink.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Home" }).click();
  await expect(page.getByText(/^Next: /)).toContainText("Jana Nováková");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Practice" }).click();
  await expect(page.locator(".wa-block--booked", { hasText: "Jana Nováková" }).first()).toBeVisible();
  expect(problems).toEqual([]);
});

// Owner, 24 Nov: "I've already logged in, meaning you have my phone number, and yet to make an
// appointment you ask for my number again." A signed-in patient books with what they verified.
test("a signed-in patient books without typing their phone or email again", async ({ browser, account }) => {
  const stack = localStack();
  const doctor = browserClient(stack);
  await doctor.auth.signInWithPassword({ email: account.email, password: account.password });
  const every = Object.fromEntries(["1", "2", "3", "4", "5", "6", "7"].map((day) => [day, ["06:00", "22:00"]]));
  const { data: page } = await doctor.rpc("save_booking_page", {
    p_display_name: "Dr. Eva Test", p_offer: "", p_about: "", p_languages: ["en"], p_hours: every,
    p_length_minutes: 45, p_gap_minutes: 15, p_fee_cents: null as unknown as number, // free: no payment step
  });
  const slug = (page as { slug: string }).slug;
  expect(slug).toBeTruthy();

  // A patient account, verified by its email code (as the patient-otp function leaves it).
  const email = `patient-${crypto.randomUUID().slice(0, 8)}@watson.test`;
  const created = await adminClient(stack).auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  await adminClient(stack).rpc("provision_patient_role_after_otp" as never, { p_user_id: created.data.user!.id } as never);
  const patientClient = browserClient(stack);
  const { data: signedIn } = await patientClient.auth.signInWithPassword({ email, password: PASSWORD });
  const payload = signedIn.session!.access_token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
  const sessionId = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "="))).session_id as string;
  await adminClient(stack).rpc("register_patient_otp_session" as never, {
    p_user_id: created.data.user!.id, p_session_id: sessionId, p_verified_email: email, p_verified_phone: null,
  } as never);

  const context = await browser.newContext();
  const key = `sb-${new URL(stack.url).hostname.split(".")[0]}-auth-token`;
  await context.addInitScript(([name, value]) => localStorage.setItem(name, value), [key, JSON.stringify(signedIn.session)] as const);
  const patient = await context.newPage();
  await patient.goto(`/book/?p=${slug}`);
  await expect(patient.getByRole("link", { name: "Your account" })).toBeVisible();
  const chooser = patient.getByRole("region", { name: "Choose a time" });
  await chooser.locator(".wa-day:not(:disabled)").first().click();
  await chooser.getByRole("group").getByRole("button").first().click();
  await patient.getByRole("link", { name: "Continue" }).click();
  await expect(patient.getByText(`${email}, from your account.`)).toBeVisible();
  await expect(patient.getByRole("textbox", { name: "Phone or email" })).toHaveCount(0);
  await patient.getByLabel("Your name").fill("Jana Nováková");
  await patient.getByRole("button", { name: "Book this time" }).click();
  await expect(patient).toHaveURL(/\/join\/\?t=[0-9a-f]{64}$/);
  const token = new URL(patient.url()).searchParams.get("t")!;
  expect(sqlAsOwner(`select patient_claim_email from public.consultations where invite_token = '${token}';`)).toBe(email);
  await context.close();
});
