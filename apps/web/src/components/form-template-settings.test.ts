import { describe, expect, it } from "vitest";
import { defaultTemplateId, templateLabel } from "../lib/form-templates";

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
});
