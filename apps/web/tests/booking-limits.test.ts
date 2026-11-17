// Limits that keep a stranger from filling a practitioner's calendar (security review SEC-04,
// 18 Oct; the owner chose the pragmatic fix on 17 Nov): no extra step for patients, instead at most
// 20 online bookings a day per practitioner, and an unpaid time held at most two hours after booking.
import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, browserClient, localStack, newPractitioner, rpc, sqlAsOwner, type Practitioner } from "./local-stack";

const stack = localStack();
const server = adminClient(stack);
const patient = browserClient(stack); // no account: the public key only

const WEEKDAYS = Object.fromEntries(["1", "2", "3", "4", "5"].map((d) => [d, ["08:00", "18:00"]]));
const page = (fee: number | null) => ({
  p_display_name: "Dr. Limit Test", p_offer: "Ayurveda", p_about: "Test page.", p_languages: ["en"],
  p_hours: WEEKDAYS, p_length_minutes: 30, p_gap_minutes: 0, p_fee_cents: fee,
});
const booking = (slug: string, startsAt: string, n: number) => ({
  p_slug: slug, p_starts_at: startsAt, p_name: `Patient ${n}`, p_contact: `+4219${String(10_000_000 + n).slice(-8)}`,
  p_language: "en", p_remind_whatsapp: false,
});

async function openTimes(who: Practitioner, fee: number | null) {
  const saved = await rpc(who.client, "save_booking_page", page(fee));
  const slug = saved.slug as string;
  const from = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const to = new Date(Date.now() + 16 * 86_400_000).toISOString();
  const answer = await rpc(patient, "booking_times", { p_slug: slug, p_from: from, p_to: to });
  return { slug, times: answer.times as string[] };
}

let eva: Practitioner;
let finn: Practitioner;
beforeAll(async () => {
  [eva, finn] = await Promise.all([newPractitioner(stack, "limit-eva"), newPractitioner(stack, "limit-finn")]);
});

describe("online booking limits", () => {
  it("takes 20 bookings a day for a practitioner, then asks the next patient to contact the practice", async () => {
    const { slug, times } = await openTimes(eva, null);
    expect(times.length).toBeGreaterThan(21);
    for (let n = 0; n < 20; n++) {
      expect(await rpc(patient, "book_time", booking(slug, times[n], n)), `booking ${n + 1}`).toMatchObject({ ok: true });
    }
    expect(await rpc(patient, "book_time", booking(slug, times[20], 20))).toEqual({ ok: false, error_category: "BOOKING_LIMIT" });
  });

  it("holds an unpaid time at most two hours after booking, however often payment starts", async () => {
    const { slug, times } = await openTimes(finn, 4000);
    const made = await rpc(patient, "book_time", booking(slug, times[0], 99));
    const token = made.token as string;
    const renewed = await rpc(server, "renew_hold", { p_token: token });
    expect(renewed).toMatchObject({ ok: true });
    // 88 minutes after booking, the two-hour ceiling leaves 32 minutes: less than the usual 35.
    sqlAsOwner(`update public.consultations set booked_at = now() - interval '88 minutes' where invite_token = '${token}';`);
    const capped = await rpc(server, "renew_hold", { p_token: token });
    const until = Date.parse(capped.hold_until as string);
    expect(until).toBeLessThanOrEqual(Date.now() - 88 * 60_000 + 120 * 60_000 + 5_000);
    expect(until).toBeGreaterThan(Date.now() + 30 * 60_000);
    sqlAsOwner(`update public.consultations set booked_at = now() - interval '3 hours' where invite_token = '${token}';`);
    expect(await rpc(server, "renew_hold", { p_token: token })).toEqual({ ok: false, error_category: "TIME_TAKEN" });
  });
});
