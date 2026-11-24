"use client";

import { Plus, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { call, explain } from "@/lib/api";
import type { Tables } from "@/lib/database.types";
import { euros } from "@/lib/fee";
import type { Product } from "@/lib/shop";
import { supabase } from "@/lib/supabase";

type Item = Pick<Tables<"prescription_items">, "id" | "product_name" | "quantity" | "instructions">;

/**
 * The medicines part of the prescriptions (owner, 23 Nov): products of the doctor's own shop, how much
 * and how to take them. The patient sees them with the report on their link, and can buy them there.
 * Changed until the form is approved.
 */
export function PrescriptionsPanel({ consultationId, editable }: { consultationId: string; editable: boolean }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [chosen, setChosen] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const read = useCallback(async () => {
    const [prescribed, shop] = await Promise.all([
      supabase.from("prescription_items").select("id, product_name, quantity, instructions").eq("consultation_id", consultationId).order("created_at"),
      supabase.from("shop_products").select("id, name, description, price_cents, photo_path, active").eq("active", true).order("name"),
    ]);
    return { items: prescribed.data ?? [], products: shop.data ?? [] };
  }, [consultationId]);
  const show = (result: Awaited<ReturnType<typeof read>>) => {
    setItems(result.items);
    setProducts(result.products);
  };
  useEffect(() => {
    let alive = true;
    read().then((result) => {
      if (!alive) return;
      setItems(result.items);
      setProducts(result.products);
    });
    return () => { alive = false; };
  }, [read]);

  async function add(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    if (!chosen) return setProblem("Choose a product from your shop.");
    setBusy(true);
    const outcome = await call("prescribe", { p_consultation_id: consultationId, p_product_id: chosen,
      p_quantity: Number(quantity), p_instructions: instructions });
    setBusy(false);
    if (!outcome.ok) return setProblem(outcome.field === "quantity" ? "Choose a quantity from 1 to 20." : explain(outcome.error_category));
    setChosen("");
    setQuantity("1");
    setInstructions("");
    show(await read());
  }
  async function remove(item: Item) {
    setProblem(null);
    const outcome = await call("unprescribe", { p_item_id: item.id });
    if (!outcome.ok) return setProblem(explain(outcome.error_category));
    show(await read());
  }

  if (items === null || (!editable && items.length === 0)) return null;
  return (
    <section className="wa-sheet__section" aria-labelledby="medicines-title">
      <h2 className="wa-sheet__title" id="medicines-title">Medicines</h2>
      <p className="wa-hint">From your shop. The patient sees them with your report and can buy them on their link.</p>
      {items.length > 0 && (
        <ul className="wa-shop">
          {items.map((item) => (
            <li key={item.id} className="wa-shop__item">
              <div className="wa-shop__text">
                <p className="wa-shop__name">{item.quantity > 1 ? `${item.quantity} × ` : ""}{item.product_name}</p>
                {item.instructions && <p className="wa-meta">{item.instructions}</p>}
              </div>
              {editable && (
                <button type="button" className="wa-button wa-button--quiet wa-button--small" aria-label={`Remove ${item.product_name}`} onClick={() => void remove(item)}>
                  <X aria-hidden className="wa-icon wa-icon--sm" />Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && (products.length === 0 ? (
        <p className="wa-text">Your shop is empty. <Link href="/calendar/#shop">Add products under Practice</Link>, then prescribe them here.</p>
      ) : (
        <form className="wa-form" style={{ gap: 12 }} onSubmit={(event) => void add(event)}>
          <div className="wa-fields-row">
            <div className="wa-field">
              <label className="wa-label" htmlFor="prescribe-product">Product</label>
              <div className="wa-select">
                <select id="prescribe-product" value={chosen} onChange={(event) => setChosen(event.target.value)}>
                  <option value="">Choose…</option>
                  {products.map((product) => <option key={product.id} value={product.id}>{product.name} · {euros(product.price_cents)}</option>)}
                </select>
              </div>
            </div>
            <div className="wa-field">
              <label className="wa-label" htmlFor="prescribe-quantity">Quantity</label>
              <input id="prescribe-quantity" className="wa-input" type="number" min={1} max={20} value={quantity}
                onChange={(event) => setQuantity(event.target.value)} />
            </div>
          </div>
          <div className="wa-field">
            <label className="wa-label" htmlFor="prescribe-how">How to take it</label>
            <input id="prescribe-how" className="wa-input" value={instructions} maxLength={500} placeholder="Two capsules after dinner, for six weeks"
              onChange={(event) => setInstructions(event.target.value)} />
          </div>
          <div className="wa-actions">
            <button type="submit" className="wa-button wa-button--secondary" disabled={busy} aria-busy={busy || undefined}>
              <Plus aria-hidden className="wa-icon" />Prescribe
            </button>
          </div>
        </form>
      ))}
      {problem && <p className="wa-error" role="alert">{problem}</p>}
    </section>
  );
}
