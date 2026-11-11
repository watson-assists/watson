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

export const defaultTemplateId = (versions: TemplateVersion[], configured?: string | null) =>
  configured ?? versions.find((version) => version.template_key === "watson_standard")?.id ?? versions[0]?.id ?? "";
