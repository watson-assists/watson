import { describe, expect, it } from "vitest";
import { defaultTemplateId, forNewWork, templateLabel } from "../lib/form-templates";

const versions = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    template_key: "massage_assessment_en_sk",
    version_number: 1,
    schema_version: 2,
    definition: {
      title: "Massage / Masáž",
      title_i18n: { en: "Massage", sk: "Masáž" },
    },
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    template_key: "watson_standard",
    version_number: 1,
    schema_version: 1,
    definition: { title: "Watson" },
  },
];

describe("form template selectors", () => {
  it("keeps Watson standard as the effective default until a practice chooses another", () => {
    expect(defaultTemplateId(versions)).toBe(versions[1].id);
    expect(defaultTemplateId(versions, versions[0].id)).toBe(versions[0].id);
  });

  it("shows stable version and language metadata without raw JSON", () => {
    expect(templateLabel(versions[0])).toBe("Massage / Masáž · v1 · EN/SK");
    expect(templateLabel(versions[1])).toBe("Watson · v1 · EN");
  });

  it("offers no earlier copy for new work: those only keep old forms tied to what they were made with", () => {
    const earlier = { id: "33333333-3333-4333-8333-333333333333", template_key: "legacy_earlier", version_number: 1, schema_version: 1, definition: { title: "Intake, as it was in October" } };
    expect(forNewWork([...versions, earlier])).toEqual(versions);
  });
});
