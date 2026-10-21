"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Warns before leaving a page with changes that aren't saved (#387).
 *
 * Closing the tab, reloading or typing another address get the browser's own
 * "leave site?" question. Clicking a link inside Tohyee (the top bar, a
 * breadcrumb) is stopped before the app follows it, and goes ahead only if
 * `ask` says yes. The browser's Back button inside the app isn't covered:
 * the app router gives no way to hold it.
 */
export function useLeaveWarning(unsaved: boolean, ask: () => Promise<boolean>): void {
  const router = useRouter();
  const state = useRef({ unsaved, ask });
  useEffect(() => {
    state.current = { unsaved, ask };
  });

  useEffect(() => {
    if (!unsaved) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers show the question only with returnValue set.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [unsaved]);

  useEffect(() => {
    const click = (event: MouseEvent) => {
      if (!state.current.unsaved || event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.("a[href]");
      if (!(link instanceof HTMLAnchorElement)) return;
      if (link.target && link.target !== "_self") return;
      if (link.hasAttribute("download")) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      // Same page, another #section: nothing is lost.
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      event.preventDefault();
      event.stopPropagation();
      void state.current.ask().then((leave) => {
        if (leave) router.push(`${url.pathname}${url.search}${url.hash}`);
      });
    };
    // Capture, so this runs before the app's own link handling.
    document.addEventListener("click", click, true);
    return () => document.removeEventListener("click", click, true);
  }, [router]);
}
