// The forms a practitioner may choose for new work, and the one chosen now (Practice, and each new
// consultation).
import { defaultTemplateId, forNewWork } from "./form-templates";
import { supabase } from "./supabase";

export async function formChoices() {
  const [available, current] = await Promise.all([
    supabase.from("form_template_versions")
      .select("id, template_key, version_number, schema_version, definition")
      .order("is_built_in", { ascending: false }).order("template_key").order("version_number", { ascending: false }),
    supabase.from("form_template_defaults").select("form_template_version_id").maybeSingle(),
  ]);
  const versions = forNewWork(available.data ?? []);
  return { versions, chosen: defaultTemplateId(versions, current.data?.form_template_version_id) };
}
