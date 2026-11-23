// Watson's own consultation form (owner, 24 Oct: Robin's sheets are what he follows — "learn from it
// but make it a 100 times better and more intuitive"). Every practitioner can start from it with one
// press, and a field can be the practitioner's alone: Watson never fills it in.
import { beforeAll, describe, expect, it } from "vitest";
import { localStack, newPractitioner, rpc, type Practitioner } from "./local-stack";

const stack = localStack();
let eva: Practitioner;
beforeAll(async () => {
  eva = await newPractitioner(stack, "watson-form");
});

type Template = { title: string; sections: { title: string; fields: { key: string; label: string; mode?: string }[] }[] };
const mine = async (who: Practitioner) =>
  (await who.client.from("form_templates").select("definition").maybeSingle()).data?.definition as Template | undefined;

describe("Watson's consultation form", () => {
  it("is the practitioner's with one press, and a second press changes nothing", async () => {
    expect(await mine(eva)).toBeUndefined();
    expect(await rpc(eva.client, "use_watson_form")).toEqual({ ok: true });
    const form = (await mine(eva))!;
    expect(form.title).toBe("Ayurvedic consultation");
    // In the order of the doctor's own sheet since 23 Nov (owner's test team: "make the order to fit this form").
    expect(form.sections.map((s) => s.title)).toEqual([
      "About the patient", "Questionnaire", "Health history", "Present condition",
      "Assessment", "Recommendation", "General instructions", "For you only",
    ]);
    const fields = form.sections.flatMap((s) => s.fields);
    expect(fields.find((f) => f.key === "medicines")?.label).toBe("Medicines and supplements");
    expect(fields.find((f) => f.key === "safety")?.mode).toBe("suggest");
    expect(fields.find((f) => f.key === "private_notes")?.mode).toBe("manual");

    expect(await rpc(eva.client, "use_watson_form")).toEqual({ ok: true });
    expect((await mine(eva))!.title).toBe("Ayurvedic consultation");
  });

  it("keeps a practitioner's own form when they already have one", async () => {
    const own = await newPractitioner(stack, "own-form");
    const template = { title: "My intake", sections: [{ title: "Notes", fields: [{ key: "notes", label: "Notes" }] }] };
    expect(await rpc(own.client, "set_form_template", { p_definition: template })).toEqual({ ok: true });
    expect(await rpc(own.client, "use_watson_form")).toEqual({ ok: true });
    expect((await mine(own))!.title).toBe("My intake");
  });
});

describe("a field only the practitioner fills in", () => {
  it("is allowed in any form", async () => {
    const who = await newPractitioner(stack, "manual-field");
    const template = { title: "T", sections: [{ title: "S", fields: [{ key: "notes", label: "Private notes", mode: "manual" }] }] };
    expect(await rpc(who.client, "set_form_template", { p_definition: template })).toEqual({ ok: true });
  });
});
