"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { nextMenuIndex } from "@/lib/ui/menu-keys";
import styles from "./ui.module.css";

export type MoreMenuItem =
  | { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean }
  | { label: string; href: string; newTab?: boolean };

/**
 * A "⋯" button that opens a short list of a screen's less-used actions
 * (decision 1321), so one primary button can stand alone. It follows the
 * WAI-ARIA menu button pattern: Enter, Space or Down opens it on the first
 * item, Up on the last; arrows, Home and End move; Escape or Tab closes it
 * and Escape puts focus back on the button; a click elsewhere closes it.
 */
export function MoreMenu({ label = "More actions", items }: { label?: string; items: MoreMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const menuId = useId();

  const itemElements = () => Array.from(list.current?.querySelectorAll<HTMLElement>("[role='menuitem']:not([aria-disabled='true'])") ?? []);
  const focusItem = (index: number) => itemElements()[index]?.focus();

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  function openAt(index: "first" | "last") {
    setOpen(true);
    requestAnimationFrame(() => focusItem(index === "first" ? 0 : itemElements().length - 1));
  }

  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) button.current?.focus();
  }

  if (items.length === 0) return null;
  return (
    <div className={styles.moreMenu}>
      <button
        ref={button}
        type="button"
        className={`${styles.button} ${styles.secondary} ${styles.moreMenuButton}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : openAt("first"))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openAt(event.key === "ArrowDown" ? "first" : "last");
          }
        }}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open ? (
        <ul
          ref={list}
          id={menuId}
          role="menu"
          aria-label={label}
          className={styles.moreMenuList}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close(true);
              return;
            }
            if (event.key === "Tab") {
              close(false);
              return;
            }
            const elements = itemElements();
            const next = nextMenuIndex(elements.indexOf(document.activeElement as HTMLElement), event.key, elements.length);
            if (next !== null) {
              event.preventDefault();
              focusItem(next);
            }
          }}
        >
          {items.map((item) => (
            <li key={item.label} role="none">
              {"href" in item ? (
                <Link
                  role="menuitem"
                  tabIndex={-1}
                  href={item.href}
                  className={styles.moreMenuItem}
                  {...(item.newTab ? { target: "_blank", rel: "noreferrer" } : {})}
                  onClick={() => close(false)}
                >
                  {item.label}
                </Link>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  aria-disabled={item.disabled ? true : undefined}
                  className={`${styles.moreMenuItem} ${item.danger ? styles.moreMenuDanger : ""}`}
                  onClick={() => {
                    if (item.disabled) return;
                    close(false);
                    item.onSelect();
                  }}
                >
                  {item.label}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
