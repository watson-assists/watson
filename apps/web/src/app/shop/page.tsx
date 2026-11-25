"use client";

import { Check, ChevronLeft, ShoppingBasket } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { PatientShell } from "@/components/patient-shell";
import { Notice } from "@/components/status";
import { call } from "@/lib/api";
import { itemCount, MOST, setCount, useBasket } from "@/lib/basket";
import { euros } from "@/lib/fee";
import { photoUrl, type Catalog, type ShopItem } from "@/lib/shop";

// Watson's shop (owner, 25 Nov: "allowing a user to go to the shop directly ... with the ability to
// add to cart and checkout"): every practice's products in it; /shop/?p=<page> shows one practice's.
// Anyone can buy, without an account or a consultation. The basket is /basket/.

export default function ShopPage() {
  return (
    <PatientShell>
      <Suspense fallback={<p className="wa-meta" role="status">Opening the shop…</p>}><Shop /></Suspense>
    </PatientShell>
  );
}

function Shop() {
  const slug = useSearchParams().get("p");
  const [catalog, setCatalog] = useState<Catalog | "missing" | "failed" | null>(null);
  const basket = useBasket();
  const count = itemCount(basket);

  useEffect(() => {
    call<Catalog>("shop_catalog", slug ? { p_slug: slug } : {}).then((answer) =>
      setCatalog(answer.ok ? answer : answer.error_category === "NOT_FOUND" ? "missing" : "failed"));
  }, [slug]);
  const practice = catalog && typeof catalog === "object" ? catalog.practice : null;
  useEffect(() => {
    document.title = practice ? `${practice} · Shop · Watson` : "Shop · Watson";
  }, [practice]);

  if (catalog === "missing") {
    return <Notice title="This shop does not exist" actions={<Link className="wa-button wa-button--secondary" href="/shop/">See all products</Link>}>
      Check the link you were given.</Notice>;
  }
  if (catalog === "failed") return <Notice tone="failed" title="The shop could not be loaded">Check your connection and reload the page.</Notice>;
  if (catalog === null) return <p className="wa-meta" role="status">Opening the shop…</p>;
  return (
    <div style={{ display: "grid", gap: 24 }}>
      {practice && <Link className="wa-crumb" href="/shop/"><ChevronLeft aria-hidden className="wa-icon wa-icon--sm" />All products</Link>}
      <div className="wa-pagehead">
        <div className="wa-pagehead__text">
          <h1 className="wa-title">{practice ? `Shop · ${practice}` : "Shop"}</h1>
          <p className="wa-person__what">Herbs, supplements and remedies from Watson&apos;s practitioners, sent to your door.</p>
        </div>
        {count > 0 && (
          <Link className="wa-button wa-button--primary" href="/basket/">
            <ShoppingBasket aria-hidden className="wa-icon" />Go to basket ({count})
          </Link>
        )}
      </div>
      {catalog.products.length === 0 ? <p className="wa-text">Nothing for sale here yet.</p> : (
        <div className="wa-people">
          {catalog.products.map((item) => <ProductCard key={item.id} item={item} inBasket={basket[item.id] ?? 0} showPractice={!practice} />)}
        </div>
      )}
    </div>
  );
}

function ProductCard({ item, inBasket, showPractice }: { item: ShopItem; inBasket: number; showPractice: boolean }) {
  return (
    <article className="wa-person" aria-labelledby={`product-${item.id}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a static site: no image server for next/image */}
      {item.photo_path && <img className="wa-product__photo" src={photoUrl(item.photo_path)!} alt="" />}
      <div style={{ display: "grid", gap: 4 }}>
        <h2 className="wa-person__name" id={`product-${item.id}`}>{item.name}</h2>
        {showPractice && <p className="wa-meta">From <Link href={`/shop/?p=${item.slug}`}>{item.practice}</Link></p>}
      </div>
      {item.description && <p className="wa-text" style={{ margin: 0 }}>{item.description}</p>}
      <p className="wa-person__name" style={{ margin: 0 }}>{euros(item.price_cents)}</p>
      <div className="wa-actions">
        <button type="button" className="wa-button wa-button--secondary" disabled={inBasket >= MOST}
          aria-label={`Add ${item.name} to basket`} onClick={() => setCount(item.id, inBasket + 1)}>
          <ShoppingBasket aria-hidden className="wa-icon" />{inBasket ? "Add one more" : "Add to basket"}
        </button>
        {inBasket > 0 && <span className="wa-meta" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <Check aria-hidden className="wa-icon wa-icon--sm" />{inBasket} in your basket</span>}
      </div>
    </article>
  );
}
