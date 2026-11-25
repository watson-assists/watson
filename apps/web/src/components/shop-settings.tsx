"use client";

import { ExternalLink, Plus, Send } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CopyButton } from "@/components/copy-button";
import { FieldError, Notice } from "@/components/status";
import { call, explain } from "@/lib/api";
import { euros, fromCents } from "@/lib/fee";
import { address, lines, photoUrl, priceCents, uploadPhoto, type OrderLine, type ShipTo, type StockedProduct } from "@/lib/shop";
import { dateTime } from "@/lib/status";
import { supabase } from "@/lib/supabase";

type Order = { id: string; items: OrderLine[]; total_cents: number; paid_at: string; ship_to: ShipTo;
  consultations: { patient_claim_name: string | null; patients: { name: string } | null } | null };

type Shop = { products: StockedProduct[]; orders: Order[]; slug: string | null };

/**
 * The practice's own shop (owner, 23 Nov): the herbs and supplements the doctor prescribes. Patients see
 * them on their link once the doctor approves their form, and buy them there; the doctor sends them.
 * Since 25 Nov the doctor's shop link sells the products they put in it to anyone.
 */
export function ShopSettings() {
  const [shop, setShop] = useState<Shop | null>(null);
  const [editing, setEditing] = useState<StockedProduct | "new" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const read = useCallback(async (): Promise<Shop> => {
    const [products, waiting, page] = await Promise.all([
      supabase.from("shop_products").select("id, name, description, price_cents, photo_path, active, in_open_shop").order("created_at"),
      supabase.from("shop_orders").select("id, items, total_cents, paid_at, ship_to, consultations(patient_claim_name, patients(name))")
        .eq("status", "paid").order("paid_at"),
      supabase.from("practitioner_profiles").select("slug").maybeSingle(),
    ]);
    return { products: products.data ?? [], orders: (waiting.data ?? []) as unknown as Order[], slug: page.data?.slug ?? null };
  }, []);
  const load = useCallback(() => void read().then(setShop), [read]);
  useEffect(() => {
    let alive = true;
    read().then((result) => alive && setShop(result));
    return () => { alive = false; };
  }, [read]);

  async function toggle(product: StockedProduct) {
    setProblem(null);
    const outcome = await call("save_shop_product", { p_id: product.id, p_name: product.name, p_description: product.description,
      p_price_cents: product.price_cents, p_photo_path: product.photo_path, p_active: !product.active });
    if (!outcome.ok) return setProblem(explain(outcome.error_category));
    load();
  }

  if (shop === null) return null;
  const { products } = shop;
  return (
    <>
      <section className="wa-panel" id="shop" aria-labelledby="shop-title">
        <div className="wa-panel__head">
          <h2 className="wa-heading" id="shop-title">Your shop</h2>
          {shop.slug && <Link className="wa-button wa-button--quiet wa-button--small" href={`/shop/?p=${shop.slug}`} target="_blank">
            <ExternalLink aria-hidden className="wa-icon wa-icon--sm" />See it as a customer</Link>}
        </div>
        <p className="wa-hint">Herbs and supplements you prescribe: patients see them with your report, once you approve their form, and buy them on their link. Those you put in your shop link, anyone can buy. You send what they buy.</p>
        {products.length === 0 && editing === null && <p className="wa-text">No products yet.</p>}
        <ul className="wa-shop">
          {products.map((product) => editing !== "new" && editing?.id === product.id ? (
            <li key={product.id}><ProductForm product={product} onDone={() => { setEditing(null); load(); }} /></li>
          ) : (
            <li key={product.id} className={product.active ? "wa-shop__item" : "wa-shop__item wa-shop__item--hidden"}>
              {/* eslint-disable-next-line @next/next/no-img-element -- a static site: no image server for next/image */}
              {product.photo_path ? <img className="wa-shop__photo" src={photoUrl(product.photo_path)!} alt="" /> : <span className="wa-shop__photo" aria-hidden />}
              <div className="wa-shop__text">
                <p className="wa-shop__name">{product.name} <span className="wa-meta">· {euros(product.price_cents)}{!product.active && " · hidden"}{product.active && product.in_open_shop && " · in your shop link"}</span></p>
                {product.description && <p className="wa-meta">{product.description}</p>}
              </div>
              <div className="wa-actions">
                <button type="button" className="wa-button wa-button--secondary wa-button--small" onClick={() => setEditing(product)}>Change</button>
                <button type="button" className="wa-button wa-button--quiet wa-button--small" onClick={() => void toggle(product)}>{product.active ? "Hide" : "Show again"}</button>
              </div>
            </li>
          ))}
        </ul>
        {editing === "new" ? <ProductForm product={null} onDone={() => { setEditing(null); load(); }} /> : (
          <div className="wa-actions">
            <button type="button" className="wa-button wa-button--secondary" onClick={() => setEditing("new")}>
              <Plus aria-hidden className="wa-icon" />Add a product
            </button>
          </div>
        )}
        {problem && <Notice tone="failed" title="That did not work">{problem}</Notice>}
        <ShopLink slug={shop.slug} />
      </section>
      <OrdersToSend orders={shop.orders} onSent={load} />
    </>
  );
}

/** The open shop's address (owner, 25 Nov), like the booking link. */
function ShopLink({ slug }: { slug: string | null }) {
  if (!slug) return <p className="wa-hint">Save your page for patients to get a shop link anyone can buy from.</p>;
  const link = `${typeof window === "undefined" ? "" : window.location.origin}/shop/?p=${slug}`;
  return (
    <div className="wa-field">
      <span className="wa-label" id="shop-link-label">Your shop link</span>
      <div className="wa-invite">
        <input className="wa-input" readOnly value={link} aria-labelledby="shop-link-label" />
        <CopyButton text={link} />
      </div>
      <p className="wa-hint">Anyone with it can buy the products you put in it, without a consultation.</p>
    </div>
  );
}

function OrdersToSend({ orders, onSent }: { orders: Order[]; onSent: () => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  async function sent(order: Order) {
    setProblem(null);
    const outcome = await call("mark_order_sent", { p_order_id: order.id });
    if (!outcome.ok) return setProblem(explain(outcome.error_category));
    onSent();
  }
  return (
    <section className="wa-panel" aria-labelledby="orders-title">
      <h2 className="wa-heading" id="orders-title">Orders to send</h2>
      {orders.length === 0 ? <p className="wa-text">No orders waiting. Paid orders appear here with the address to send them to.</p> : (
        <ul className="wa-shop">
          {orders.map((order) => (
            <li key={order.id} className="wa-shop__item">
              <div className="wa-shop__text">
                <p className="wa-shop__name">{order.consultations?.patients?.name ?? order.consultations?.patient_claim_name ?? order.ship_to?.name ?? "Customer"}{" "}
                  <span className="wa-meta">· {order.consultations ? "" : "from your shop link · "}paid {dateTime(order.paid_at)} · {euros(order.total_cents)}</span></p>
                <p className="wa-text">{lines(order.items)}</p>
                <p className="wa-meta">Send to: {address(order.ship_to) || "no address given"}</p>
                {order.ship_to?.email && <p className="wa-meta">Email: {order.ship_to.email}</p>}
              </div>
              <button type="button" className="wa-button wa-button--secondary wa-button--small" onClick={() => void sent(order)}>
                <Send aria-hidden className="wa-icon wa-icon--sm" />Mark as sent
              </button>
            </li>
          ))}
        </ul>
      )}
      {problem && <Notice tone="failed" title="That did not work">{problem}</Notice>}
    </section>
  );
}

const FIELD: Record<string, string> = {
  name: "Enter the product's name.",
  price: "Enter a price between 0.50 and 1000, for example 12.90.",
  photo: "Choose a photo: JPEG, PNG or WebP, up to 5 MB.",
};

function ProductForm({ product, onDone }: { product: StockedProduct | null; onDone: () => void }) {
  const [name, setName] = useState(product?.name ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [price, setPrice] = useState(fromCents(product?.price_cents ?? null));
  const [photo, setPhoto] = useState<File | null>(null);
  const [open, setOpen] = useState(product?.in_open_shop ?? false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ field: string; message: string } | null>(null);
  const id = product?.id ?? "new";

  async function save(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    const cents = priceCents(price);
    if (!name.trim()) return setProblem({ field: "name", message: FIELD.name });
    if (cents === null) return setProblem({ field: "price", message: FIELD.price });
    setBusy(true);
    const user = (await supabase.auth.getSession()).data.session?.user.id ?? "";
    const path = photo ? await uploadPhoto(user, photo) : product?.photo_path ?? null;
    if (photo && !path) {
      setBusy(false);
      return setProblem({ field: "photo", message: FIELD.photo });
    }
    const outcome = await call("save_shop_product", { p_id: product?.id ?? null, p_name: name, p_description: description,
      p_price_cents: cents, p_photo_path: path, p_active: product?.active ?? true, p_in_open_shop: open });
    setBusy(false);
    if (!outcome.ok) return setProblem({ field: outcome.field ?? "", message: FIELD[outcome.field ?? ""] ?? explain(outcome.error_category) });
    onDone();
  }

  const error = (field: string) => (problem?.field === field ? problem.message : undefined);
  return (
    <form className="wa-form" style={{ gap: 16 }} onSubmit={(event) => void save(event)} aria-label={product ? `Change ${product.name}` : "A new product"}>
      <div className="wa-fields-row">
        <div className="wa-field">
          <label className="wa-label" htmlFor={`product-name-${id}`}>Name</label>
          <input id={`product-name-${id}`} className="wa-input" value={name} maxLength={120} autoFocus
            aria-invalid={Boolean(error("name"))} aria-describedby={`product-name-error-${id}`} onChange={(event) => setName(event.target.value)} />
          <FieldError id={`product-name-error-${id}`} message={error("name")} />
        </div>
        <div className="wa-field">
          <label className="wa-label" htmlFor={`product-price-${id}`}>Price (€)</label>
          <input id={`product-price-${id}`} className="wa-input" value={price} inputMode="decimal" placeholder="12.90"
            aria-invalid={Boolean(error("price"))} aria-describedby={`product-price-error-${id}`} onChange={(event) => setPrice(event.target.value)} />
          <FieldError id={`product-price-error-${id}`} message={error("price")} />
        </div>
      </div>
      <div className="wa-field">
        <label className="wa-label" htmlFor={`product-about-${id}`}>What it is</label>
        <textarea id={`product-about-${id}`} className="wa-textarea" value={description} maxLength={1000}
          placeholder="Ashwagandha root, 60 capsules of 500 mg." onChange={(event) => setDescription(event.target.value)} />
      </div>
      <div className="wa-field">
        <label className="wa-label" htmlFor={`product-photo-${id}`}>Photo{product?.photo_path ? " (choose one to replace it)" : " (optional)"}</label>
        <input id={`product-photo-${id}`} className="wa-input" type="file" accept="image/jpeg,image/png,image/webp"
          aria-invalid={Boolean(error("photo"))} aria-describedby={`product-photo-error-${id}`} onChange={(event) => setPhoto(event.target.files?.[0] ?? null)} />
        <FieldError id={`product-photo-error-${id}`} message={error("photo")} />
      </div>
      <label className="wa-check">
        <input type="checkbox" checked={open} onChange={(event) => setOpen(event.target.checked)} />
        <span className="wa-check__text">
          <span className="wa-check__label">In your shop link</span>
          <span className="wa-hint">Anyone with your shop link can buy it. Leave it off for what you only prescribe.</span>
        </span>
      </label>
      <div className="wa-actions">
        <button type="submit" className="wa-button wa-button--primary" disabled={busy} aria-busy={busy || undefined}>Save product</button>
        <button type="button" className="wa-button wa-button--quiet" disabled={busy} onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
