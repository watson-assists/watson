"use client";

import { ShoppingBasket } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { itemCount, useBasket } from "@/lib/basket";
import { useSession } from "@/lib/session";

/** Frame for the pages patients use without an account: the front page, booking, the shop and privacy. */
export function PatientShell({ children }: { children: ReactNode }) {
  const session = useSession();
  const inBasket = itemCount(useBasket());
  return (
    <>
      <header className="wa-header">
        <div className="wa-header__inner">
          <Link href="/" className="wa-wordmark" aria-label="Watson, find a practitioner">Watson</Link>
          <nav className="wa-public-shop" aria-label="Shop">
            <Link href="/shop/" className="wa-crumb">Shop</Link>
            {inBasket > 0 && <Link href="/basket/" className="wa-crumb"><ShoppingBasket aria-hidden className="wa-icon wa-icon--sm" />Basket ({inBasket})</Link>}
          </nav>
          {session.status === "signed-in"
            ? <Link href={session.roles?.includes("patient") ? "/patient/" : "/consultations/"} className="wa-crumb">
              {session.roles?.includes("patient") ? "Your account" : "Your consultations"}
            </Link>
            : <nav className="wa-public-signin" aria-label="Sign in">
              <Link href="/patient/sign-in/" className="wa-crumb">Patient sign-in</Link>
              <Link href="/sign-in/" className="wa-crumb">Practitioner sign-in</Link>
            </nav>}
        </div>
      </header>
      <main className="wa-page">{children}</main>
      <footer className="wa-page" style={{ paddingTop: 0 }}>
        <p className="wa-meta"><Link href="/privacy/">Privacy</Link></p>
      </footer>
    </>
  );
}
