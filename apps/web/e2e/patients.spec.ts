// Patients by name (owner, 24 Oct: "we see only the random number generated for that record ... the
// doctor would need a better way to determine the patient ... search ... sorted by patient last name").
import { createClient } from "@supabase/supabase-js";
import { expect, signIn, test } from "./account";
import { localStack, rpc, sqlAsOwner } from "../tests/local-stack";

/** The signed-in practitioner's own database client, to prepare consultations quickly. */
async function as(account: { email: string; password: string }) {
  const stack = localStack();
  const client = createClient(stack.url, stack.publishableKey, { auth: { persistSession: false } });
  await client.auth.signInWithPassword({ email: account.email, password: account.password });
  return client;
}
const suffix = () => Math.random().toString(36).slice(2, 6);

test("the practitioner names the patient when creating the consultation, and Home shows the name", async ({ page, account }) => {
  const name = `Jana Nováková-${suffix()}`;
  await signIn(page, account);
  await page.getByRole("link", { name: "New consultation" }).first().click();
  await page.getByLabel("Patient's name").fill(name);
  await page.getByLabel("Phone or email").fill(`+421 905 ${Math.floor(Math.random() * 9e5 + 1e5)}`);
  await page.getByRole("button", { name: "Create consultation" }).click();
  await expect(page.getByText(name).first()).toBeVisible();
  await page.goto("/consultations/");
  await expect(page.getByText(name).first()).toBeVisible();
});

test("a patient seen before is suggested, and their phone or email filled in", async ({ page, account }) => {
  const client = await as(account);
  const name = `Ema Mráz-${suffix()}`;
  const email = `ema-${suffix()}@example.com`;
  const made = await rpc(client, "create_consultation", {
    p_scheduled_at: "2026-10-20T08:00:00Z", p_language: "sk", p_consent_recorded: true,
    p_patient_name: name, p_patient_contact: email,
  });
  const practitioner = (await client.auth.getUser()).data.user!.id;
  const patientId = sqlAsOwner(`
    insert into public.patients (practitioner_id, name, email)
    values ('${practitioner}', '${name}', '${email}') returning id;
  `).split("\n")[0]!;
  expect(await rpc(client, "patient_review_association", {
    p_consultation_id: made.consultation_id, p_patient_id: patientId, p_decision: "confirm",
  })).toMatchObject({ ok: true });
  await signIn(page, account);
  await page.getByRole("link", { name: "New consultation" }).first().click();
  await expect(page.locator(`#patients option[value="${name}"]`)).toHaveCount(1);
  await page.getByLabel("Patient's name").fill(name);
  await expect(page.getByLabel("Phone or email")).toHaveValue(email);
});

test("Home finds a patient by name, phone, email or number, and sorts them by last name", async ({ page, account }) => {
  const client = await as(account);
  const tag = suffix();
  const people = [
    { name: `Zoe Zúbek${tag}`, contact: `+421 905 ${Math.floor(Math.random() * 9e5 + 1e5)}`, at: "2026-10-23T09:00:00Z" },
    { name: `Ida Aalto${tag}`, contact: `ida-${tag}@example.com`, at: "2026-10-21T09:00:00Z" },
    { name: `Ema Mráz${tag}`, contact: `ema-${tag}@example.com`, at: "2026-10-22T09:00:00Z" },
  ];
  for (const person of people) {
    await client.rpc("create_consultation", { p_scheduled_at: person.at, p_language: "en", p_consent_recorded: true, p_patient_name: person.name, p_patient_contact: person.contact });
  }
  const unnamed = await client.rpc("create_consultation", { p_scheduled_at: "2026-10-20T09:00:00Z", p_language: "en", p_consent_recorded: true });
  const { data: row } = await client.from("consultations").select("synthetic_patient_ref").eq("id", (unnamed.data as { consultation_id: string }).consultation_id).single();

  await signIn(page, account);
  const order = async () => {
    for (const person of people) await expect(page.getByText(person.name)).toBeVisible(); // the list has loaded
    const text = await page.locator("main").innerText();
    return people.map((p) => p.name).sort((a, b) => text.indexOf(a) - text.indexOf(b));
  };
  // By last name, by default: Aalto, Mráz, Zúbek.
  expect(await order()).toEqual([`Ida Aalto${tag}`, `Ema Mráz${tag}`, `Zoe Zúbek${tag}`]);
  await expect(page.getByText("Patient not named yet").first()).toBeVisible();

  await page.getByLabel("Sort").selectOption({ label: "Date, newest first" });
  expect(await order()).toEqual([`Zoe Zúbek${tag}`, `Ema Mráz${tag}`, `Ida Aalto${tag}`]);

  const search = page.getByLabel("Find a patient");
  await search.fill(`mraz${tag}`); // without the accent
  await expect(page.getByText(`Ema Mráz${tag}`)).toBeVisible();
  await expect(page.getByText(`Ida Aalto${tag}`)).toHaveCount(0);
  await search.fill(`ida-${tag}@`);
  await expect(page.getByText(`Ida Aalto${tag}`)).toBeVisible();
  await expect(page.getByText(`Ema Mráz${tag}`)).toHaveCount(0);
  await search.fill(people[0].contact.replace(/\D/g, "").slice(-6));
  await expect(page.getByText(`Zoe Zúbek${tag}`)).toBeVisible();
  await search.fill(row!.synthetic_patient_ref);
  await expect(page.getByText(row!.synthetic_patient_ref)).toBeVisible();
  await expect(page.getByText(`Zoe Zúbek${tag}`)).toHaveCount(0);
});

// Owner, 23 Nov: "Patients name needs to be editable", where the doctor sees it: at the top.
test("the doctor changes a confirmed patient's name at the top of the consultation, and it changes everywhere", async ({ page, account, problems }) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), "confirms a local patient directly");
  const client = await as(account);
  const made = await rpc(client, "create_consultation", {
    p_scheduled_at: "2026-11-23T09:00:00Z", p_language: "sk", p_consent_recorded: true,
    p_patient_name: `Zuzana Kovac-${suffix()}`, p_patient_contact: `+421 905 ${Math.floor(Math.random() * 9e5 + 1e5)}`,
  });
  expect(await rpc(client, "confirm_new_patient", { p_consultation_id: made.consultation_id })).toMatchObject({ ok: true });

  await signIn(page, account);
  await page.goto(`/consultation/?id=${made.consultation_id}`);
  await page.getByRole("button", { name: "Change name" }).click();
  const renamed = `Zuzana Kováčová-${suffix()}`;
  await page.getByLabel("Patient's name").fill(renamed);
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("heading", { name: renamed, level: 1 })).toBeVisible();
  await page.goto("/consultations/");
  await expect(page.getByText(renamed).first()).toBeVisible();
  expect(problems).toEqual([]);
});
