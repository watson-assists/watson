// The intake in the order of the doctor's own sheet (owner's test team, 23 Nov: "make the order to fit
// this form", Dr. Robin's Excel; "add height and weight"). Watson's extra questions stay, where they
// fit; every question an earlier form asked is still asked, so dated values carry over.
import { beforeAll, describe, expect, it } from "vitest";
import { localStack, newPractitioner, rpc, sqlAsOwner, type Practitioner } from "./local-stack";

type Definition = { title: string; title_i18n?: { en: string; sk: string }; sections: { title: string; fields: { key: string; label: string }[] }[] };
const latest = (key: string): Definition =>
  JSON.parse(sqlAsOwner(`select definition from public.form_template_versions
    where is_built_in and template_key = '${key}' order by version_number desc limit 1;`));
const keys = (form: Definition) => form.sections.flatMap((section) => section.fields.map((field) => field.key));

let eva: Practitioner;
beforeAll(async () => {
  eva = await newPractitioner(localStack(), "intake-eva");
});

describe("Watson's intake form", () => {
  it("follows the doctor's sheet: details, questionnaire, history, present condition, then the doctor's part", () => {
    const form = latest("watson_standard");
    expect(form.sections.map((section) => section.title)).toEqual([
      "About the patient", "Questionnaire", "Health history", "Present condition",
      "Assessment", "Recommendation", "General instructions", "For you only",
    ]);
    expect(form.sections[0].fields.map((field) => field.key)).toEqual(["age", "height", "weight", "place_of_living", "work"]);
    // The sheet's questionnaire in its own order, with Watson's extra questions beside their kin.
    expect(form.sections[1].fields.map((field) => field.key)).toEqual([
      "diet", "habits", "digestion", "bowel_movements", "sleep", "energy_mood", "activity",
      "menstrual_cycle", "pregnancy_children", "allergies", "operations",
    ]);
    expect(form.sections[4].fields[0].key).toBe("assessment");
  });

  it("still asks every question the earlier form asked, plus height and weight", () => {
    const earlier = JSON.parse(sqlAsOwner(`select definition from public.form_template_versions
      where is_built_in and template_key = 'watson_standard' and version_number = 1;`)) as Definition;
    expect(keys(latest("watson_standard")).sort()).toEqual([...keys(earlier), "height", "weight"].sort());
  });

  it("comes in Slovak and English too, with the same questions in the same order", () => {
    const both = latest("watson_standard_sk_en");
    expect(keys(both)).toEqual(keys(latest("watson_standard")));
    expect(both.title_i18n).toEqual({ en: "Ayurvedic consultation", sk: "Ajurvédska konzultácia" });
    expect(both.sections[0].fields[1].label).toBe("Výška / Height");
  });

  it("is what a new consultation gets when the practitioner has not chosen a form", async () => {
    const made = await rpc(eva.client, "create_consultation", { p_scheduled_at: "2026-11-24T09:00:00Z", p_language: "en", p_consent_recorded: true });
    expect(sqlAsOwner(`select v.template_key || ' ' || v.version_number from public.consultations c
      join public.form_template_versions v on v.id = c.form_template_version_id where c.id = '${made.consultation_id}';`)).toBe("watson_standard 2");
  });
});
