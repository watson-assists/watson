"use client";

import type { User } from "@supabase/supabase-js";
import { CalendarDays, House } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { loginName } from "@/lib/session";
import { supabase } from "@/lib/supabase";

// Each place in the menu, and the pages that belong to it: everything reached from Home is under Home.
const NAV = [
  { href: "/consultations/", label: "Home", Icon: House, within: ["/consultation", "/form/", "/room/", "/print/"] },
  { href: "/calendar/", label: "Practice", Icon: CalendarDays, within: ["/calendar/"] },
];

/** Frame for every signed-in screen: the way around, who is signed in, and a way out. */
export function AppShell({ user, children }: { user: User; children: ReactNode }) {
  const path = usePathname();
  return (
    <>
      <header className="wa-header">
        <div className="wa-header__inner">
          <Link href="/consultations/" className="wa-wordmark" aria-label="Watson, home">Watson</Link>
          <nav className="wa-nav" aria-label="Main">
            {NAV.map(({ href, label, Icon, within }) => (
              <Link key={href} href={href} aria-current={path === href ? "page" : within.some((start) => path.startsWith(start)) ? "true" : undefined}>
                <Icon aria-hidden className="wa-icon wa-icon--sm" />{label}
              </Link>
            ))}
          </nav>
          <div className="wa-account">
            <span className="wa-account__email">Signed in as <strong>{loginName(user.email)}</strong></span>
            <button type="button" className="wa-button wa-button--secondary wa-button--small"
              onClick={() => supabase.auth.signOut()}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="wa-page">{children}</main>
    </>
  );
}
