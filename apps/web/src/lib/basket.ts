// The shop's basket (owner, 25 Nov: "add to cart and checkout"): kept in this browser until it is
// paid, so it stays while the buyer moves between pages and tabs. It holds only product ids and how
// many; the database checks every product and price at checkout.
import { useSyncExternalStore } from "react";

/** Product id → how many. */
export type Basket = Record<string, number>;
export const MOST = 10; // of one product, as the database allows
const KEY = "watson.basket";
const CHANGED = "watson-basket";
const EMPTY: Basket = {};

let raw: string | null = null;
let snapshot: Basket = EMPTY;

function parse(text: string | null): Basket {
  try {
    const found: unknown = JSON.parse(text ?? "{}");
    if (!found || typeof found !== "object") return EMPTY;
    return Object.fromEntries(Object.entries(found).filter(([, n]) => Number.isInteger(n) && n >= 1 && n <= MOST));
  } catch {
    return EMPTY;
  }
}

/** The basket now: the same object until it changes, as React asks. */
function current(): Basket {
  try {
    const now = localStorage.getItem(KEY);
    if (now !== raw) [raw, snapshot] = [now, parse(now)];
  } catch {
    // Storage refused (a private window): the basket lives in this page only.
  }
  return snapshot;
}

function write(basket: Basket) {
  raw = JSON.stringify(basket);
  snapshot = basket;
  try {
    localStorage.setItem(KEY, raw);
  } catch {
    // Kept in memory instead.
  }
  window.dispatchEvent(new Event(CHANGED));
}

function subscribe(changed: () => void) {
  window.addEventListener(CHANGED, changed);
  window.addEventListener("storage", changed); // another tab
  return () => {
    window.removeEventListener(CHANGED, changed);
    window.removeEventListener("storage", changed);
  };
}

export function useBasket(): Basket {
  return useSyncExternalStore(subscribe, current, () => EMPTY);
}

/** Sets how many of a product; 0 takes it out. */
export function setCount(productId: string, count: number) {
  const next = { ...current() };
  if (count > 0) next[productId] = Math.min(MOST, count);
  else delete next[productId];
  write(next);
}

export function emptyBasket() {
  write({});
}

export const itemCount = (basket: Basket) => Object.values(basket).reduce((sum, n) => sum + n, 0);
