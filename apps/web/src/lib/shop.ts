// Watson's own simple shop (owner, 23 Nov): each practice's herbs and supplements, prescribed after a
// consultation and bought by the patient on their link, through Stripe.
import type { Tables } from "./database.types";
import { supabase } from "./supabase";

export type Product = Pick<Tables<"shop_products">, "id" | "name" | "description" | "price_cents" | "photo_path" | "active">;
/** What the patient's page shows of a prescription. */
export type Prescribed = { id: string; name: string; description: string; photo_path: string | null;
  price_cents: number; quantity: number; instructions: string; available: boolean };
export type OrderLine = { name: string; quantity: number; price_cents: number };
/** The address the patient gave Stripe. */
export type ShipTo = { name?: string | null; address?: Record<string, string | null> | null } | null;

/** A product photo's public address (the bucket is public: photos of products only). */
export const photoUrl = (path: string | null) => (path ? supabase.storage.from("shop").getPublicUrl(path).data.publicUrl : null);

/** A price typed in euros, in cents; null unless it is between 0.50 and 1000 with at most two decimals. */
export function priceCents(typed: string): number | null {
  const text = typed.trim().replace(/^€\s*/, "");
  if (!/^\d{1,4}([.,]\d{1,2})?$/.test(text)) return null;
  const cents = Math.round(Number(text.replace(",", ".")) * 100);
  return cents >= 50 && cents <= 100_000 ? cents : null;
}

const EXTENSION: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** Uploads a product photo to the practitioner's own folder: its path, or null when it is not a photo or did not arrive. */
export async function uploadPhoto(userId: string, file: File): Promise<string | null> {
  const extension = EXTENSION[file.type];
  if (!extension || file.size > 5 * 1024 * 1024) return null;
  const path = `${userId}/${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage.from("shop").upload(path, file, { contentType: file.type });
  return error ? null : path;
}

/** "2 × Tulsi tea, Triphala". */
export const lines = (items: OrderLine[]) => items.map((item) => (item.quantity > 1 ? `${item.quantity} × ${item.name}` : item.name)).join(", ");

/** The address on one line: "Jana Nováková, Hlavná 1, 811 01 Bratislava, SK". */
export const address = (to: ShipTo) => to ? [to.name, to.address?.line1, to.address?.line2,
  [to.address?.postal_code, to.address?.city].filter(Boolean).join(" "), to.address?.country].filter(Boolean).join(", ") : "";
