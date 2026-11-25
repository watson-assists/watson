// The live transcript during the call (owner, 24 October: "like it happens in Teams", always on). The
// doctor's browser sends each voice in ten-second pieces; the cloud engine turns each into text first,
// before any other work, and removes the piece. A piece left over from an earlier call is not read.
import { beforeAll, describe, expect, it } from "vitest";
import { localStack, newEngine, newPractitioner, rpc, sqlAsOwner, type Practitioner } from "./local-stack";

const stack = localStack();
const OGG = Buffer.from("OggS fake opus piece");
let eva: Practitioner;
let engine: Practitioner;
beforeAll(async () => {
  [eva, engine] = await Promise.all([newPractitioner(stack, "live"), newEngine(stack, "live-engine")]);
});

async function consultation(consent = true) {
  const made = await rpc(eva.client, "create_consultation", { p_scheduled_at: "2026-10-24T10:00:00Z", p_language: "sk", p_consent_recorded: consent });
  return made.consultation_id!;
}
const pathOf = (id: string, speaker: string, seq: number) => `${eva.id}/${id}/live/${speaker}-${seq}`;
async function send(id: string, speaker: "practitioner" | "patient", seq: number, offset: number) {
  const upload = await eva.client.storage.from("audio").upload(pathOf(id, speaker, seq), OGG, { contentType: "audio/ogg" });
  return { upload, added: await rpc(eva.client, "add_live_piece", { p_consultation_id: id, p_speaker: speaker, p_seq: seq, p_offset_seconds: offset }) };
}
/** Claims pieces until it gets one of this consultation's; others left by earlier runs are finished. */
async function claim(id: string) {
  for (let i = 0; i < 50; i++) {
    const piece = (await rpc(engine.client, "engine_claim_live_piece")).piece as { id: string; storage_path: string; language: string | null; speaker: string } | null;
    if (!piece) return null;
    if (piece.storage_path.includes(id)) return piece;
    await rpc(engine.client, "engine_live_piece_done", { p_id: piece.id, p_text: "" });
  }
  return null;
}

describe("a live piece", () => {
  it("is sent by the doctor during a consented call and read by the engine, which then removes it", async () => {
    const id = await consultation();
    const { upload, added } = await send(id, "patient", 0, 0.4);
    expect(upload.error).toBeNull();
    expect(added).toEqual({ ok: true });
    expect(await rpc(eva.client, "add_live_piece", { p_consultation_id: id, p_speaker: "patient", p_seq: 0, p_offset_seconds: 0.4 })).toEqual({ ok: true }); // sent twice: once

    const piece = await claim(id);
    expect(piece).toMatchObject({ storage_path: pathOf(id, "patient", 0), language: "sk", speaker: "patient" });
    expect((await engine.client.storage.from("audio").download(piece!.storage_path)).error).toBeNull();
    expect(await rpc(engine.client, "engine_live_piece_done", { p_id: piece!.id, p_text: "Budím sa o tretej." })).toEqual({ ok: true });
    expect((await engine.client.storage.from("audio").remove([piece!.storage_path])).error).toBeNull();

    const { data } = await eva.client.from("live_pieces").select("speaker, seq, offset_seconds, text, status").eq("consultation_id", id);
    expect(data).toEqual([{ speaker: "patient", seq: 0, offset_seconds: 0.4, text: "Budím sa o tretej.", status: "done" }]);
  });

  it("comes with the same voice's next pieces of the same twenty seconds, read in one pass (25 Nov)", async () => {
    const id = await consultation();
    await send(id, "patient", 0, 0);
    await send(id, "practitioner", 0, 1);
    await send(id, "patient", 1, 4.5);
    await send(id, "patient", 2, 19.9);
    await send(id, "patient", 3, 20); // would make the pass longer than the speech model's 30 seconds
    const first = await claim(id);
    expect(first).toMatchObject({ speaker: "patient", storage_path: pathOf(id, "patient", 0) });
    const next = await rpc(engine.client, "engine_claim_next_live_pieces", { p_after: first!.id });
    expect(next).toEqual({ ok: true, pieces: [
      { id: expect.any(String), storage_path: pathOf(id, "patient", 1) },
      { id: expect.any(String), storage_path: pathOf(id, "patient", 2) },
    ] });
    expect(await rpc(engine.client, "engine_claim_next_live_pieces", { p_after: first!.id })).toEqual({ ok: true, pieces: [] }); // taken
    expect(await rpc(eva.client, "engine_claim_next_live_pieces", { p_after: first!.id })).toMatchObject({ ok: false, error_category: "NOT_AN_ENGINE" });
    for (const piece of [first!, ...(next.pieces as { id: string }[])]) {
      expect(await rpc(engine.client, "engine_live_piece_done", { p_id: piece.id, p_text: "" })).toEqual({ ok: true });
    }
    expect(await rpc(engine.client, "engine_claim_next_live_pieces", { p_after: first!.id })).toMatchObject({ ok: false, error_category: "NOT_FOUND" }); // read already
    expect((await claim(id))!.speaker).toBe("practitioner");
  });

  it("records when its words were written, so the live delay can be measured (17 Nov)", async () => {
    const id = await consultation();
    await send(id, "practitioner", 0, 0);
    const piece = await claim(id);
    expect(await rpc(engine.client, "engine_live_piece_done", { p_id: piece!.id, p_text: "Ako spávate?" })).toEqual({ ok: true });
    const { data } = await eva.client.from("live_pieces").select("created_at, claimed_at, read_at").eq("id", piece!.id).single();
    expect(data!.read_at).not.toBeNull();
    expect(Date.parse(data!.read_at!)).toBeGreaterThanOrEqual(Date.parse(data!.claimed_at!));
  });

  it("is refused without consent, for another doctor's consultation, and from anyone but the doctor", async () => {
    const pending = await consultation(false);
    expect((await send(pending, "practitioner", 0, 0)).added).toMatchObject({ ok: false });
    const id = await consultation();
    const other = await newPractitioner(stack, "live-other");
    expect(await rpc(other.client, "add_live_piece", { p_consultation_id: id, p_speaker: "practitioner", p_seq: 0, p_offset_seconds: 0 })).toEqual({ ok: false, error_category: "NOT_FOUND" });
    expect((await other.client.storage.from("audio").upload(pathOf(id, "practitioner", 0), OGG, { contentType: "audio/ogg" })).error).not.toBeNull();
    expect((await engine.client.storage.from("audio").download(pathOf(id, "practitioner", 0))).error).not.toBeNull(); // not claimed
  });

  it("comes before any other work, and wakes the cloud engine", async () => {
    const id = await consultation();
    await send(id, "practitioner", 3, 30);
    expect(sqlAsOwner("select private.engine_work_waiting();")).toBe("t");
    const piece = await claim(id);
    expect(piece).toMatchObject({ storage_path: pathOf(id, "practitioner", 3) });
    await rpc(engine.client, "engine_live_piece_done", { p_id: piece!.id, p_text: "" });
  });

  it("of a call that has ended is not read: the full transcript is on its way", async () => {
    const id = await consultation();
    await send(id, "patient", 9, 90);
    sqlAsOwner(`update public.consultations set status = 'audio_imported' where id = '${id}';`);
    expect(await claim(id)).toBeNull();
    expect(sqlAsOwner(`select status from public.live_pieces where consultation_id = '${id}';`)).toBe("failed");
  });

  it("left over from more than ten minutes ago is not read", async () => {
    const id = await consultation();
    await send(id, "patient", 7, 70);
    sqlAsOwner(`update public.live_pieces set created_at = now() - interval '11 minutes' where consultation_id = '${id}';`);
    expect(await claim(id)).toBeNull();
    expect(sqlAsOwner(`select status from public.live_pieces where consultation_id = '${id}';`)).toBe("failed");
  });
});

describe("a live piece set aside", () => {
  it("is handed to the engine to remove its file, so no audio is left behind", async () => {
    const id = await consultation();
    await send(id, "practitioner", 11, 110);
    sqlAsOwner(`update public.consultations set status = 'audio_imported' where id = '${id}';`);
    let removed: string[] = [];
    for (let i = 0; i < 50; i++) {
      const answer = await rpc(engine.client, "engine_claim_live_piece");
      removed = removed.concat((answer.remove as string[]) ?? []);
      if (!answer.piece) break;
      await rpc(engine.client, "engine_live_piece_done", { p_id: (answer.piece as { id: string }).id, p_text: "" });
    }
    expect(removed).toContain(pathOf(id, "practitioner", 11));
    expect((await engine.client.storage.from("audio").remove([pathOf(id, "practitioner", 11)])).error).toBeNull();
    expect(sqlAsOwner(`select count(*) from storage.objects where name = '${pathOf(id, "practitioner", 11)}';`)).toBe("0");
  });
});
