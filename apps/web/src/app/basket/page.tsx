"use client";

import { ChevronLeft, Lock, X } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { PatientShell } from "@/components/patient-shell";
import { Notice } from "@/components/status";
import { call } from "@/lib/api";
import { emptyBasket, MOST, setCount, useBasket, type Basket } from "@/lib/basket";
import { euros } from "@/lib/fee";
import { payment } from "@/lib/payment";
import { photoUrl, type Catalog, type ShopItem } from "@/lib/shop";

// The shop's basket and checkout (owner, 25 Nov): change how many, take something out, and pay on
// Stripe's page with the address to send it to. Back from Stripe, the payment is confirmed here.

export default function BasketPage() {
  return (
    <PatientShell>
      <Suspense fallback={<p className="wa-meta" role="status">Opening your basket…</p>}><BasketView /></Suspense>
    </PatientShell>
  );
}

function BasketView() {
  const params = useSearchParams();
  const returning = params.get("session_id");
  const basket = useBasket();
  const [products, setProducts] = useState<Map<string, ShopItem> | "failed" | null>(null);
  const [paid, setPaid] = useState<boolean | null>(null);

  useEffect(() => {
    call<Catalog>("shop_catalog").then((answer) => setProducts(answer.ok ? new Map(answer.products.map((p) => [p.id, p])) : "failed"));
  }, []);
  useEffect(() => {
    // Back from Stripe: confirm the payment here as well as in Stripe's webhook, then start afresh.
    if (!returning) return;
    payment({ basket_session: returning }).then((answer) => {
      setPaid(Boolean(answer?.paid));
      if (answer?.paid) emptyBasket();
    });
  }, [returning]);

  if (products === null || (returning && paid === null)) {
    return <p className="wa-meta" role="status">{returning ? "Checking your payment…" : "Opening your basket…"}</p>;
  }
  if (products === "failed") return <Notice tone="failed" title="Your basket could not be loaded">Check your connection and reload the page.</Notice>;
  return (
    <div style={{ display: "grid", gap: 24, maxWidth: 760 }}>
      <Link className="wa-crumb" href="/shop/"><ChevronLeft aria-hidden className="wa-icon wa-icon--sm" />Back to the shop</Link>
      <h1 className="wa-title">Your basket</h1>
      {paid === true && <Notice title="Paid. Thank you.">Each practitioner sends what you bought from them. Stripe emails you a receipt.</Notice>}
      {paid === false && <Notice tone="attention" title="Your payment is not confirmed yet">If you paid, reload this page in a moment.</Notice>}
      {params.get("cancelled") === "1" && <Notice title="The payment was not completed">Nothing was charged. Your basket is as you left it.</Notice>}
      <Lines basket={basket} products={products} />
    </div>
  );
}

function Lines({ basket, products }: { basket: Basket; products: Map<string, ShopItem> }) {
  const [paying, setPaying] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ids = Object.keys(basket);
  const gone = ids.filter((id) => !products.has(id));
  const lines = ids.filter((id) => products.has(id)).map((id) => ({ item: products.get(id)!, count: basket[id] }));
  const total = lines.reduce((sum, { item, count }) => sum + count * item.price_cents, 0);

  async function pay() {
    setPaying(true);
    setProblem(null);
    const answer = await payment({ basket: lines.map(({ item, count }) => ({ product_id: item.id, quantity: count })) });
    if (answer?.url) return window.location.assign(answer.url);
    setPaying(false);
    setProblem(answer?.error === "VALIDATION"
      ? "Something in your basket is no longer for sale. Reload the page and try again."
      : "Paying is not available right now. Try again in a moment.");
  }

  if (ids.length === 0) {
    return <section className="wa-panel"><p className="wa-text">Your basket is empty.</p>
      <div className="wa-actions"><Link className="wa-button wa-button--primary" href="/shop/">Go to the shop</Link></div></section>;
  }
  return (
    <section className="wa-panel" aria-label="What you are buying">
      {gone.length > 0 && (
        <Notice tone="attention" title={gone.length === 1 ? "One product is no longer for sale" : `${gone.length} products are no longer for sale`}
          actions={<button type="button" className="wa-button wa-button--secondary" onClick={() => gone.forEach((id) => setCount(id, 0))}>Take them out</button>}>
          They will not be in your order.
        </Notice>
      )}
      <ul className="wa-shop">
        {lines.map(({ item, count }) => (
          <li key={item.id} className="wa-shop__item">
            {/* eslint-disable-next-line @next/next/no-img-element -- a static site: no image server for next/image */}
            {item.photo_path ? <img className="wa-shop__photo" src={photoUrl(item.photo_path)!} alt="" /> : <span className="wa-shop__photo" aria-hidden />}
            <div className="wa-shop__text">
              <p className="wa-shop__name">{item.name}</p>
              <p className="wa-meta">From {item.practice} · {euros(item.price_cents)} each</p>
              <p className="wa-text">{euros(count * item.price_cents)}</p>
            </div>
            <div className="wa-actions">
              <div className="wa-select">
                <select aria-label={`How many ${item.name}`} value={count} onChange={(event) => setCount(item.id, Number(event.target.value))}>
                  {Array.from({ length: MOST }, (_, n) => <option key={n + 1} value={n + 1}>{n + 1}</option>)}
                </select>
              </div>
              <button type="button" className="wa-button wa-button--quiet" aria-label={`Remove ${item.name}`} onClick={() => setCount(item.id, 0)}>
                <X aria-hidden className="wa-icon" />Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
      <p className="wa-heading" style={{ textAlign: "right" }}>Total {euros(total)}</p>
      <div className="wa-actions" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="wa-button wa-button--primary" disabled={paying || lines.length === 0} aria-busy={paying || undefined} onClick={() => void pay()}>
          <Lock aria-hidden className="wa-icon" />{paying ? "Opening Stripe…" : `Pay ${euros(total)}`}
        </button>
      </div>
      <p className="wa-hint">You pay on Stripe&apos;s secure page and give the address to send it to. Watson never sees your card.</p>
      {problem && <Notice tone="failed" title="Could not start the payment">{problem}</Notice>}
    </section>
  );
}
