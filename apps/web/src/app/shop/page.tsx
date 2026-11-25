"use client";

import { Lock } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { PatientShell } from "@/components/patient-shell";
import { Notice } from "@/components/status";
import { call } from "@/lib/api";
import { initials } from "@/lib/booking";
import { euros } from "@/lib/fee";
import { payment } from "@/lib/payment";
import { photoUrl, type Product } from "@/lib/shop";

// A practice's open shop (owner, 25 Nov: "the link directly to the store"): /shop/?p=<their page>.
// Anyone with the link buys what the practice put in it, without a consultation; it sends it to them.

type OpenProduct = Pick<Product, "id" | "name" | "description" | "price_cents" | "photo_path">;
type OpenShop = { practice: string; products: OpenProduct[] };
const MOST = 10; // of one product in one order, as the database allows

export default function ShopPage() {
  return (
    <PatientShell>
      <Suspense fallback={<p className="wa-meta" role="status">Opening the shop…</p>}><Shop /></Suspense>
    </PatientShell>
  );
}

function Shop() {
  const params = useSearchParams();
  const slug = params.get("p") ?? "";
  const returning = params.get("session_id");
  const [shop, setShop] = useState<OpenShop | "missing" | null>(null);
  const [paid, setPaid] = useState<boolean | null>(null);

  useEffect(() => {
    call<OpenShop>("open_shop", { p_slug: slug }).then((answer) => setShop(answer.ok ? answer : "missing"));
  }, [slug]);
  useEffect(() => {
    // Back from Stripe: confirm the payment here as well as in Stripe's webhook.
    if (returning) payment({ shop: slug, session_id: returning }).then((answer) => setPaid(Boolean(answer?.paid)));
  }, [slug, returning]);
  const name = shop && shop !== "missing" ? shop.practice : null;
  useEffect(() => {
    if (name) document.title = `${name} · Shop · Watson`;
  }, [name]);

  if (shop === "missing") {
    return <Notice title="This shop does not exist" actions={<Link className="wa-button wa-button--secondary" href="/">Find a practitioner</Link>}>
      Check the link you were given.</Notice>;
  }
  if (shop === null || (returning && paid === null)) {
    return <p className="wa-meta" role="status">{returning ? "Checking your payment…" : "Opening the shop…"}</p>;
  }
  return (
    <div style={{ display: "grid", gap: 24, maxWidth: 760 }}>
      <div className="wa-person__top" style={{ gridTemplateColumns: "80px minmax(0, 1fr)" }}>
        <span className="wa-monogram wa-monogram--large" aria-hidden>{initials(shop.practice)}</span>
        <div style={{ display: "grid", gap: 4 }}>
          <h1 className="wa-title">{shop.practice}</h1>
          <p className="wa-person__what">Shop</p>
        </div>
      </div>
      {paid === true && <Notice title="Paid. Thank you.">{shop.practice} sends it to you. Stripe emails you a receipt.</Notice>}
      {paid === false && <Notice tone="attention" title="Your payment is not confirmed yet">If you paid, reload this page in a moment.</Notice>}
      {params.get("cancelled") === "1" && <Notice title="The payment was not completed">Nothing was charged. You can try again.</Notice>}
      <Basket slug={slug} shop={shop} />
    </div>
  );
}

function Basket({ slug, shop }: { slug: string; shop: OpenShop }) {
  const [count, setCount] = useState<Record<string, number>>({});
  const [paying, setPaying] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const chosen = shop.products.filter((product) => (count[product.id] ?? 0) > 0);
  const total = chosen.reduce((sum, product) => sum + count[product.id] * product.price_cents, 0);

  async function buy() {
    setPaying(true);
    setProblem(null);
    const answer = await payment({ shop: slug, items: chosen.map((product) => ({ product_id: product.id, quantity: count[product.id] })) });
    if (answer?.url) return window.location.assign(answer.url);
    setPaying(false);
    setProblem(answer?.error === "VALIDATION"
      ? "Something you chose is no longer for sale. Reload the page and choose again."
      : "Buying is not available right now. Try again in a moment.");
  }

  return (
    <section className="wa-panel" aria-labelledby="products-title">
      <h2 className="wa-heading" id="products-title">Products</h2>
      {shop.products.length === 0 ? <p className="wa-text">Nothing for sale here yet.</p> : (
        <>
          <ul className="wa-shop">
            {shop.products.map((product) => (
              <li key={product.id} className="wa-shop__item">
                {/* eslint-disable-next-line @next/next/no-img-element -- a static site: no image server for next/image */}
                {product.photo_path ? <img className="wa-shop__photo" src={photoUrl(product.photo_path)!} alt="" /> : <span className="wa-shop__photo" aria-hidden />}
                <div className="wa-shop__text">
                  <p className="wa-shop__name">{product.name}</p>
                  {product.description && <p className="wa-meta">{product.description}</p>}
                  <p className="wa-meta">{euros(product.price_cents)} each</p>
                </div>
                <div className="wa-field">
                  <label className="wa-label" htmlFor={`how-many-${product.id}`}>How many</label>
                  <div className="wa-select">
                    <select id={`how-many-${product.id}`} value={count[product.id] ?? 0}
                      onChange={(event) => setCount((now) => ({ ...now, [product.id]: Number(event.target.value) }))}>
                      {Array.from({ length: MOST + 1 }, (_, n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <div className="wa-actions">
            <button type="button" className="wa-button wa-button--primary" disabled={paying || total === 0} aria-busy={paying || undefined} onClick={() => void buy()}>
              <Lock aria-hidden className="wa-icon" />{paying ? "Opening Stripe…" : total ? `Buy for ${euros(total)}` : "Choose how many"}
            </button>
          </div>
          <p className="wa-hint">You pay on Stripe&apos;s secure page and give the address to send it to. Watson never sees your card.</p>
        </>
      )}
      {problem && <Notice tone="failed" title="Could not start the payment">{problem}</Notice>}
    </section>
  );
}
