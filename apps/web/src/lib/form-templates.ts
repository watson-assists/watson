type TemplateVersion = {
  id: string;
  template_key: string;
  version_number: number;
  definition: unknown;
};

export const templateName = (version: TemplateVersion) => {
  const definition = version.definition as { title?: string };
  return definition.title ?? version.template_key;
};

export const templateLabel = (version: TemplateVersion) => {
  const definition = version.definition as { title_i18n?: { en?: string; sk?: string } };
  const languages = definition.title_i18n?.en && definition.title_i18n.sk ? "EN/SK" : "EN";
  return `${templateName(version)} · v${version.version_number} · ${languages}`;
};

/** What a practitioner may choose for new work: the newest version of each form (newest first, as
 *  formChoices orders them). An earlier copy (migration 20261108090000) only keeps an old form tied
 *  to the definition it was made with; older versions stay with the consultations made with them. */
export const forNewWork = <T extends TemplateVersion>(versions: T[]) =>
  versions.filter((version, index) => version.template_key !== "legacy_earlier"
    && versions.findIndex((other) => other.template_key === version.template_key) === index);

export const defaultTemplateId = (versions: TemplateVersion[], configured?: string | null) =>
  configured ?? versions.find((version) => version.template_key === "watson_standard")?.id ?? versions[0]?.id ?? "";
