import { readFileSync } from "node:fs";
import { adminClient, browserClient, localStack, newPractitioner, PASSWORD, rpc, sqlAsOwner } from "../tests/local-stack";
import { expect, signIn, test } from "./account";

const TEMPLATE = readFileSync(new URL("../../../packages/test-fixtures/templates/ayurveda-intake.json", import.meta.url), "utf8");
const NARROW_TEMPLATE = TEMPLATE.replace(
  '"label": "Other"',
  '"label": "Allergies and food intolerances / Alergias e intolerancias alimentarias"',
);

/** A consultation whose form Watson has just filled in: three answers, the rest not discussed. */
function filledForm(consultationId: string, template = TEMPLATE) {
  const answers: Record<string, [string, number[]]> = {
    age: ["42", [1]],
    diet: ["Skips breakfast; three coffees before lunch.", [3]],
    present_conditions: ["Hyperacidity (amla pitta).", [4]],
  };
  const keys = (JSON.parse(template).sections as { fields: { key: string }[] }[]).flatMap((s) => s.fields.map((f) => f.key));
  const rows = keys.map((key, i) => {
    const [text, evidence] = answers[key] ?? [null, []];
    return `((select id from f), '${key}', ${i}, ${text === null ? "null" : `'${text}'`}, '{${evidence.join(",")}}')`;
  });
  const lines = [["practitioner", "How old are you?"], ["patient", "I'm forty-two."], ["practitioner", "And your meals?"],
    ["patient", "I skip breakfast and have three coffees before lunch."], ["practitioner", "There is a lot of pitta: the acidity."]];
  sqlAsOwner(`
    with c as (select * from public.consultations where id = '${consultationId}'),
    j as (insert into public.transcription_jobs (consultation_id, requested_by, status, finished_at)
          select id, practitioner_id, 'completed', now() from c returning id),
    t as (insert into public.transcripts (consultation_id, job_id, schema_version, ordering, low_confidence_threshold, tracks)
          select '${consultationId}', id, '2.0.0', 'exact', 0.5, '[]' from j returning id),
    s as (insert into public.transcript_segments (id, transcript_id, position, speaker, start_seconds, end_seconds, machine_text)
          select gen_random_uuid(), t.id, x.n - 1, x.who::public.speaker, x.n * 5, x.n * 5 + 4, x.said
          from t, (values ${lines.map(([who, said], i) => `(${i + 1}, '${who}', '${said.replace(/'/g, "''")}')`).join(", ")}) as x(n, who, said) returning 1),
    fj as (insert into public.form_jobs (
             consultation_id, transcript_id, form_template_version_id, status, claimed_at, finished_at
           )
           select '${consultationId}', id,
             coalesce(
               (select form_template_version_id from public.consultations where id = '${consultationId}'),
               (select id from public.form_template_versions
                where is_built_in and template_key = 'watson_standard'
                order by version_number desc limit 1)
             ),
             'completed', now() - interval '4 minutes', now()
           from t returning id, transcript_id),
     f as (insert into public.forms (consultation_id, job_id, transcript_id, template)
           select '${consultationId}', id, transcript_id, '${template.replace(/'/g, "''")}'::jsonb from fj returning id)
    insert into public.form_answers (form_id, field_key, position, machine_text, evidence) values ${rows.join(", ")};
    update public.form_answers
      set answer_state = case when machine_text is null then 'unanswered' else 'known' end,
          machine_state = case when machine_text is null then 'unanswered' else 'known' end,
          machine_value = case when machine_text is null then null else to_jsonb(machine_text) end
      where form_id = (select id from public.forms where consultation_id = '${consultationId}');
    update public.consultations set status = 'draft_ready' where id = '${consultationId}';
    with p as (insert into public.patients (practitioner_id, name, phone)
               select practitioner_id, 'Jana Nováková', '+4219' || floor(random() * 90000000 + 10000000)::text
               from public.consultations where id = '${consultationId}' returning id, practitioner_id),
    c as (update public.consultations set patient_id = (select id from p) where id = '${consultationId}' returning id),
    d as (insert into public.patient_documents (id, practitioner_id, patient_id, consultation_id, storage_path, file_name,
                                                media_type, size_bytes, source, uploaded_at, reading, page_texts, read_at)
          select gen_random_uuid(), p.practitioner_id, p.id, '${consultationId}', p.practitioner_id || '/' || gen_random_uuid(),
                 'Blood test 3 Oct.pdf', 'application/pdf', 1000, 'patient', now(), 'read', array['Ferritin 9 µg/L, low'], now()
          from p returning id)
    update public.form_answers set document_quotes = jsonb_build_array(jsonb_build_object(
             'document_id', (select id from d), 'page', 1, 'text', 'Ferritin 9 µg/L, low'))
      where field_key = 'present_conditions' and form_id = (select id from public.forms where consultation_id = '${consultationId}');`);
}

async function consultation(account: { email: string; password: string }, fee?: number) {
  const client = browserClient(localStack());
  await client.auth.signInWithPassword({ email: account.email, password: account.password });
  const made = await rpc(client, "create_consultation", {
    p_synthetic_patient_ref: "SYN-0061", p_scheduled_at: "2026-10-14T07:30:00Z", p_language: "en",
    p_consent_recorded: true, p_fee_cents: fee,
  });
  const { data } = await client.from("consultations").select("id, invite_token").eq("id", made.consultation_id!).single();
  return data!;
}

test("check every answer of the filled-in form against its quote, then approve it", async ({ page, account, problems }) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), "prepares a filled-in form directly in the local database");
  const { id } = await consultation(account);
  filledForm(id, NARROW_TEMPLATE);

  await signIn(page, account);
  await page.goto(`/consultation/?id=${id}`);
  await expect(page.getByRole("listitem").filter({ hasText: "Ready to check" })).toBeVisible();
  await page.getByRole("link", { name: "Check the form" }).click();

  await expect(page.getByText("Watson suggests · decide yourself")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Jana Nováková" })).toBeVisible();
  await expect(page.getByText(/and one document/)).toBeVisible();
  await expect(page.getByText("3 of 21 answered")).toBeVisible();
  await expect(page.getByText("3 answers still to check")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve form" })).toBeDisabled();
  await expect(page.getByRole("button", {
    name: "Add an answer: Allergies and food intolerances / Alergias e intolerancias alimentarias",
  })).toBeVisible();

  // Regression: long bilingual tucked labels must wrap without widening the review sheet or page.
  const originalViewport = page.viewportSize() ?? { width: 1280, height: 720 };
  for (const width of [320, 375]) {
    await page.setViewportSize({ ...originalViewport, width });
    const dimensions = await page.evaluate(() => {
      const sheet = document.querySelector<HTMLElement>(".wa-sheet");
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        sheetClientWidth: sheet?.clientWidth ?? 0,
        sheetScrollWidth: sheet?.scrollWidth ?? 0,
        answerActions: [...document.querySelectorAll<HTMLElement>(".wa-review .wa-button--small")]
          .filter((button) => button.offsetParent !== null)
          .map((button) => button.getBoundingClientRect().height),
      };
    });
    expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
    expect(dimensions.sheetScrollWidth).toBeLessThanOrEqual(dimensions.sheetClientWidth);
    expect(dimensions.answerActions.every((height) => height >= 44)).toBe(true);
  }
  await page.setViewportSize(originalViewport);

  const age = page.getByRole("article", { name: "Age" });
  await expect(age.getByText("I'm forty-two.")).toBeVisible(); // the quote, with its speaker
  await expect(age.getByText("Patient · 0:10")).toBeVisible();
  await age.getByRole("button", { name: "Accept" }).click();
  await expect(age.getByText("Accepted")).toBeVisible();

  const diet = page.getByRole("article", { name: "Diet" });
  await diet.getByRole("button", { name: "Edit" }).click();
  await diet.getByLabel("Your answer").fill("Skips breakfast. Three cups of coffee before lunch.");
  await diet.getByRole("button", { name: "Save" }).click();
  await expect(diet.getByText("Edited by you")).toBeVisible();
  await expect(diet.getByText("Three cups of coffee before lunch.")).toBeVisible();

  const diagnosis = page.getByRole("article", { name: /Diagnosis: present conditions/ });
  await expect(diagnosis.getByText("Suggestion")).toBeVisible();
  // A quote from the patient's document, by page, next to the one from the conversation.
  await expect(diagnosis.getByRole("button", { name: "Blood test 3 Oct.pdf" })).toBeVisible();
  await expect(diagnosis.getByText("page 1")).toBeVisible();
  await expect(diagnosis.getByText("Ferritin 9 µg/L, low")).toBeVisible();
  await diagnosis.getByRole("button", { name: "Reject" }).click();
  await expect(diagnosis.getByText("Rejected")).toBeVisible();

  // What was not discussed is folded into one line per section, each with a way to add an answer.
  await expect(page.getByRole("button", { name: "Add an answer: Exercise" })).toBeVisible();

  await expect(page.getByText("Every answer is checked.")).toBeVisible();
  await page.getByRole("button", { name: "Approve form" }).click();
  await expect(page.getByText("This form is final.")).toBeVisible();
  await page.getByRole("link", { name: "Consultation", exact: true }).click();
  await expect(page.getByRole("link", { name: "View the form" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("set a fee, send the patient's link; the patient sees the fee, then pays and can join", async ({ page, account, problems }) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), "records the payment directly in the local database");
  await signIn(page, account);
  await page.getByRole("link", { name: "New consultation" }).click();
  await page.getByLabel("Language spoken").selectOption("en");
  await page.getByLabel("Fee").fill("40");
  await page.getByRole("button", { name: "Create consultation" }).click();
  await expect(page.getByText("Fee €40.00")).toBeVisible();
  await expect(page.getByText("Not paid yet")).toBeVisible();
  const link = await page.getByLabel("Link for the patient").inputValue();
  expect(link).toMatch(/\/j\/[2-9A-HJ-NP-Z]{8}$/);

  const patient = await page.context().browser()!.newPage();
  await patient.setViewportSize({ width: 320, height: 720 });
  await patient.goto(link);
  await expect(patient.getByText("€40.00", { exact: true })).toBeVisible();
  await expect(patient.getByRole("button", { name: "Pay €40.00" })).toBeVisible();
  await expect(patient.getByRole("button", { name: "Join the call" })).toHaveCount(0);
  await expect(patient.getByLabel("Your name")).toBeVisible();
  await expect(patient.getByLabel("Phone or email")).toBeVisible();
  const phoneLayout = await patient.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    input: document.querySelector<HTMLInputElement>("#patient-name")?.getBoundingClientRect().toJSON(),
    upload: [...document.querySelectorAll<HTMLButtonElement>(".wa-patient-entry .wa-actions button")]
      .filter((button) => button.offsetParent !== null)
      .map((button) => button.getBoundingClientRect().toJSON()),
  }));
  expect(phoneLayout.document).toBeLessThanOrEqual(phoneLayout.viewport);
  expect(phoneLayout.input?.width).toBeGreaterThan(0);
  expect(phoneLayout.upload.length).toBeGreaterThan(0);
  expect(phoneLayout.upload.every((button) => button.height >= 44 && button.right <= phoneLayout.viewport)).toBe(true);

  // What Stripe's confirmation does, done here directly: the server records the payment.
  const id = new URL(page.url()).searchParams.get("id")!;
  const recorded = await adminClient(localStack()).rpc("record_payment", { p_consultation_id: id, p_session_id: `cs_test_${id}`, p_amount_cents: 4000 });
  expect(recorded.data).toEqual({ ok: true });
  await patient.reload();
  await expect(patient.getByText("Paid. Thank you.")).toBeVisible();
  await expect(patient.getByRole("button", { name: "Join the call" })).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Paid €40\.00/)).toBeVisible();
  await patient.close();
  expect(problems).toEqual([]);
});

test("a document that arrives after the form was filled in offers to fill the form in again", async ({ page, problems }) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), "prepares a filled-in form directly in the local database");
  // An account of its own: setting a form template here must not change the shared test account.
  const own = await newPractitioner(localStack(), "again");
  const account = { email: own.email, password: PASSWORD, references: [] };
  const { id } = await consultation(account);
  filledForm(id);
  expect(await rpc(own.client, "set_form_template", { p_definition: JSON.parse(TEMPLATE) })).toEqual({ ok: true });
  sqlAsOwner(`
    insert into public.patient_documents (id, practitioner_id, patient_id, consultation_id, storage_path, file_name,
                                          media_type, size_bytes, source, uploaded_at, reading, page_texts, read_at)
    select gen_random_uuid(), practitioner_id, patient_id, id, practitioner_id || '/' || gen_random_uuid(), 'Ultrasound.pdf',
           'application/pdf', 1000, 'whatsapp', clock_timestamp() + interval '1 second', 'read', array['Liver normal'], now()
    from public.consultations where id = '${id}';`);

  await signIn(page, account);
  await page.goto(`/form/?id=${id}`);
  const late = page.getByRole("status").filter({ hasText: "A document arrived after Watson filled this in" });
  await expect(late).toContainText("Ultrasound.pdf, sent by the patient on WhatsApp");
  await expect(late).toContainText("Answers you have already checked stay as you left them.");
  await late.getByRole("button", { name: "Fill in again" }).click();
  await expect(page).toHaveURL(new RegExp(`/consultation/\\?id=${id}$`));
  await expect(page.getByRole("heading", { name: "Filling in your form" })).toBeVisible();
  expect(problems).toEqual([]);
});
