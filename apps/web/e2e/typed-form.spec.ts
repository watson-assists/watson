import { browserClient, claimFormJob, localStack, newEngine, rpc, sqlAsOwner,
  transcriptWithFormJob } from "../tests/local-stack";
import { expect, signIn, test } from "./account";

type TypedField = {
  key: string;
  value_type: string;
};

type TypedTemplate = {
  sections: { fields: TypedField[] }[];
};

test("practice and consultation selectors expose and pin the bilingual form", async ({ page, account, problems }) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), "changes the synthetic local practitioner's default form");
  await signIn(page, account);
  await page.goto("/calendar/");
  const defaultForm = page.getByLabel("Form", { exact: true });
  const massageOption = defaultForm.locator("option", {
    hasText: /Ayurvedic health & massage therapy assessment.*v1.*EN\/SK/,
  });
  await expect(massageOption).toHaveCount(1);
  const selectedVersion = await massageOption.getAttribute("value");
  if (!selectedVersion) throw new Error("bilingual form option has no version id");
  await defaultForm.selectOption(selectedVersion);
  await page.getByRole("button", { name: "Save default" }).click();
  await expect(page.getByRole("button", { name: "Save default" })).toBeDisabled();

  await page.goto("/consultations/new/");
  const consultationForm = page.getByLabel("Consultation form");
  await expect(consultationForm).toHaveValue(selectedVersion);
  await expect(consultationForm).toContainText(/Ayurvedic health & massage therapy assessment.*v1.*EN\/SK/);
  await page.getByLabel("Date").fill("2026-12-03");
  await page.getByLabel("Time (24-hour)").fill("09:00");
  await page.getByRole("button", { name: "Create consultation" }).click();
  await expect(page.getByText("Add the patient's name.")).toBeVisible();
  await expect(page.getByText("Add their phone or email.")).toBeVisible();
  await page.getByLabel("Patient's name").fill("Jana Nováková");
  await page.getByLabel("Phone or email").fill("+421 905 111 222");
  await page.getByRole("button", { name: "Create consultation" }).click();
  await expect(page.getByRole("heading", { name: "Jana Nováková" })).toBeVisible();
  const consultationId = new URL(page.url()).searchParams.get("id");
  expect(consultationId).not.toBeNull();
  expect(sqlAsOwner(`
    select v.template_key
    from public.consultations c
    join public.form_template_versions v on v.id = c.form_template_version_id
    where c.id = '${consultationId}';
  `)).toBe("massage_assessment_en_sk");
  expect(problems).toEqual([]);
});

test("a completed bilingual massage form opens in typed review", async ({ page, account, problems }) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), "prepares synthetic worker output in the local database");
  const stack = localStack();
  const practitioner = browserClient(stack);
  await practitioner.auth.signInWithPassword({ email: account.email, password: account.password });
  const engine = await newEngine(stack, "typed-form-browser");
  const versionId = sqlAsOwner(`
    select id from public.form_template_versions
    where template_key = 'massage_assessment_en_sk' and version_number = 1;
  `);
  expect(await rpc(practitioner, "set_default_form_template_version", {
    p_version_id: versionId,
  })).toMatchObject({ ok: true });
  const created = await rpc(practitioner, "create_consultation_with_template", {
    p_scheduled_at: "2026-12-02T09:00:00Z",
      p_language: "en",
      p_consent_recorded: true,
      p_form_template_version_id: versionId,
      p_patient_name: "Jana Nováková",
      p_patient_contact: "+421 905 111 222",
  });
  const consultationId = created.consultation_id as string;
  transcriptWithFormJob(consultationId);
  const job = await claimFormJob(engine, consultationId) as Awaited<ReturnType<typeof claimFormJob>> & {
    template: TypedTemplate;
  };
  const answers = job.template.sections.flatMap((section) => section.fields).map((field) => {
    const known = field.key === "main_concern";
    return {
      key: field.key,
      text: known ? "Persistent synthetic fatigue." : null,
      value_type: field.value_type,
      state: known ? "known" : "unanswered",
      value: known ? "Persistent synthetic fatigue." : null,
      evidence: known ? [0] : [],
      documents: [],
    };
  });
  expect(await rpc(engine.client, "engine_complete_form_job", {
    p_job_id: job.job_id,
    p_attempt: job.attempt,
    p_answers: answers,
    p_metrics: {},
  })).toMatchObject({ ok: true });

  await signIn(page, account);
  await page.goto(`/form/?id=${consultationId}`);
  await expect(page.getByText(/Ayurvedic health & massage therapy assessment/).first()).toBeVisible();
  await expect(page.getByText(/Revision 1 · final transcript is authoritative/)).toBeVisible();
  const concern = page.getByRole("article", { name: /Main concern/ });
  await expect(concern.getByText("Persistent synthetic fatigue.")).toBeVisible();
  await expect(concern.getByRole("button", { name: "Accept" })).toBeVisible();
  await expect(page.getByText("Record only after the signer has signed the printed form in wet ink."))
    .toHaveCount(2);
  await expect(page.getByText("Typed confirmation")).toHaveCount(0);
  await page.goto(`/print/?id=${consultationId}`);
  await expect(page.getByText("Practitioner signature / Podpis poskytovateľa", { exact: true })).toHaveCount(1);
  expect(problems).toEqual([]);
});
