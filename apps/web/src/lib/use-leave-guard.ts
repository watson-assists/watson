"use client";

import { useEffect } from "react";

/**
 * While `active` (a call is on), leaving asks first: closing or reloading the tab gets the browser's own
 * question, and following a link inside Watson (the logo, Home, Practice) asks `question`. Without it a
 * tap on the logo mid-call ends the call, and the doctor's recording so far is lost.
 */
export function useLeaveGuard(active: boolean, question: string) {
  useEffect(() => {
    if (!active) return;
    const unload = (event: BeforeUnloadEvent) => event.preventDefault();
    // Capture phase: before the framework's own link handling, so a "no" stops it.
    const click = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!link || link.getAttribute("target") === "_blank" || window.confirm(question)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", click, true);
    };
  }, [active, question]);
}
