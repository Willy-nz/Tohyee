"use client";

import { type CSSProperties, type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { placeInfoTip, type InfoTipPlacement } from "@/lib/ui/info-tip";
import styles from "./info-tip.module.css";

/**
 * A small (i) button that shows more information (decision 1210). Keep a short
 * line visible and put the rest in here, so long help doesn't fill the page.
 *
 * - Click or tap opens and closes it (phones have no hover); Enter and Space
 *   work because it's a real button.
 * - Escape closes it and puts focus back on the button; so does tapping or
 *   tabbing anywhere else.
 * - It's a disclosure: the button has aria-expanded and aria-controls, and the
 *   text follows the button, so a screen reader reads it next.
 * - It stays on screen at 390px wide, and printing shows the full text.
 *
 * It renders only inline elements, so it can sit inside a <p>. Use
 * <InfoPara> for separate paragraphs inside it.
 */
export function InfoTip({ label, children }: { label: string; children?: ReactNode }) {
  const id = useId();
  const panelId = `${id}-info`;
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<InfoTipPlacement | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  const place = useCallback(() => {
    if (!button.current) return;
    const box = button.current.getBoundingClientRect();
    setPlacement(placeInfoTip(box, { width: window.innerWidth, height: window.innerHeight }));
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }
    }
    function onFocus(event: FocusEvent) {
      if (wrap.current && event.target instanceof Node && !wrap.current.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  const style: CSSProperties | undefined =
    open && placement
      ? { left: placement.left, top: placement.top, width: placement.width, maxHeight: placement.maxHeight }
      : undefined;

  return (
    <span ref={wrap} className={styles.wrap}>
      <button
        ref={button}
        type="button"
        className={styles.button}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((was) => !was)}
        data-info-tip=""
      >
        <InfoIcon />
        <span className={styles.srOnly}>More about {label}</span>
      </button>
      <span
        id={panelId}
        className={[styles.panel, open ? styles.open : "", open && placement?.side === "above" ? styles.above : ""].filter(Boolean).join(" ")}
        style={style}
      >
        <span className={styles.label}>{label}</span>
        {children}
      </span>
    </span>
  );
}

/** A paragraph inside an <InfoTip> (a block-level span, so it's valid inside a <p>). */
export function InfoPara({ children }: { children?: ReactNode }) {
  return <span className="info-para">{children}</span>;
}

function InfoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden focusable="false">
      <circle cx="8" cy="4.5" r="1.1" fill="currentColor" />
      <path d="M8 7.2v5.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
