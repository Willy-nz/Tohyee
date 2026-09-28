"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, Suspense, useEffect, useId, useRef, useState } from "react";
import { ROLE_LABELS, type Role } from "@/lib/auth/roles";
import styles from "./app-shell.module.css";
import {
  useWorkspace,
  type WorkspaceOrganisation,
  WorkspaceProvider,
  type WorkspaceUser,
} from "./workspace";

type MenuLink = { href: string; label: string; minRole?: Role };
type MenuGroup = { heading?: string; links: MenuLink[] };
type Menu = { label: string; href?: string; groups: MenuGroup[] };

/**
 * The accounting menus: Home, Sales, Purchases, Reporting, Accounting, Tax,
 * Contacts. Each opens to its overview, its lists and that area's settings.
 * Server settings aren't here: they open only on the server computer.
 */
const MENUS: Menu[] = [
  { label: "Home", href: "/operations", groups: [] },
  {
    label: "Sales",
    groups: [
      {
        links: [
          { href: "/operations/sales", label: "Sales overview" },
          { href: "/operations/invoices", label: "Invoices" },
          { href: "/operations/invoices?show=awaiting", label: "Awaiting payment" },
          { href: "/operations/credit-notes", label: "Credit notes" },
        ],
      },
      {
        heading: "Create",
        links: [
          { href: "/operations/invoices/new", label: "New invoice", minRole: "bookkeeper" },
          { href: "/operations/credit-notes/new", label: "New credit note", minRole: "bookkeeper" },
        ],
      },
    ],
  },
  {
    label: "Purchases",
    groups: [
      {
        links: [
          { href: "/operations/purchases", label: "Purchases overview" },
          { href: "/operations/bills", label: "Bills" },
          { href: "/operations/bills?show=awaiting", label: "Awaiting payment" },
          { href: "/operations/supplier-credit-notes", label: "Supplier credit notes" },
        ],
      },
      {
        heading: "Create",
        links: [
          { href: "/operations/bills/new", label: "New bill", minRole: "bookkeeper" },
          { href: "/operations/supplier-credit-notes/new", label: "New supplier credit note", minRole: "bookkeeper" },
        ],
      },
    ],
  },
  {
    label: "Reporting",
    groups: [
      {
        links: [
          { href: "/operations/reports?report=pnl", label: "Profit and loss" },
          { href: "/operations/reports?report=bs", label: "Balance sheet" },
          { href: "/operations/reports?report=tb", label: "Trial balance" },
          { href: "/operations/reports?report=stock", label: "Stock valuation" },
        ],
      },
    ],
  },
  {
    label: "Accounting",
    groups: [
      {
        links: [
          { href: "/operations/bank-accounts", label: "Bank accounts" },
          { href: "/operations/bank-rules", label: "Bank rules" },
          { href: "/operations/ledger-journals", label: "Journals" },
          { href: "/operations/accounts", label: "Chart of accounts" },
          { href: "/operations/inventory", label: "Stock" },
          { href: "/operations/fx-revaluation", label: "FX revaluation", minRole: "bookkeeper" },
        ],
      },
      {
        heading: "Settings",
        links: [
          { href: "/operations/settings", label: "Settings and locks", minRole: "admin" },
          { href: "/operations/members", label: "People and roles", minRole: "admin" },
        ],
      },
    ],
  },
  {
    label: "Tax",
    groups: [
      {
        links: [
          { href: "/operations/gst-return", label: "GST return" },
          { href: "/operations/tax", label: "Tax codes" },
        ],
      },
    ],
  },
  {
    label: "Contacts",
    groups: [
      {
        links: [
          { href: "/operations/contacts", label: "All contacts" },
          { href: "/operations/contacts?type=customers", label: "Customers" },
          { href: "/operations/contacts?type=suppliers", label: "Suppliers" },
        ],
      },
    ],
  },
];

/** The paths a menu covers, so its button shows as the current area. */
const AREAS: Record<string, string[]> = {
  Home: ["/operations"],
  Sales: ["/operations/sales", "/operations/invoices", "/operations/credit-notes", "/operations/overpayments"],
  Purchases: ["/operations/purchases", "/operations/bills", "/operations/supplier-credit-notes"],
  Reporting: ["/operations/reports"],
  Accounting: [
    "/operations/bank-accounts",
    "/operations/bank-rules",
    "/operations/ledger-journals",
    "/operations/accounts",
    "/operations/inventory",
    "/operations/fx-revaluation",
    "/operations/settings",
    "/operations/members",
  ],
  Tax: ["/operations/gst-return", "/operations/tax"],
  Contacts: ["/operations/contacts"],
};

function inArea(pathname: string, label: string): boolean {
  return (AREAS[label] ?? []).some((path) =>
    path === "/operations" ? pathname === path : pathname === path || pathname.startsWith(`${path}/`),
  );
}

/** Whether a menu link is the page being shown (its path and any ?query it names). */
function isCurrent(pathname: string, search: URLSearchParams, href: string): boolean {
  const [path, query] = href.split("?");
  if (pathname !== path) return false;
  const wanted = new URLSearchParams(query ?? "");
  if ([...wanted.keys()].length === 0) {
    return !search.get("show") && !search.get("type") && !search.get("report");
  }
  return [...wanted.entries()].every(([key, value]) => search.get(key) === value);
}

function useVisibleMenus(): Menu[] {
  const { can } = useWorkspace();
  return MENUS.map((menu) => ({
    ...menu,
    groups: menu.groups
      .map((group) => ({ ...group, links: group.links.filter((link) => !link.minRole || can(link.minRole)) }))
      .filter((group) => group.links.length > 0),
  }));
}

function DesktopMenus() {
  const pathname = usePathname();
  const search = useSearchParams();
  const menus = useVisibleMenus();
  const [open, setOpen] = useState<string | null>(null);
  const bar = useRef<HTMLElement>(null);
  const idPrefix = useId();

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (bar.current && !bar.current.contains(event.target as Node)) setOpen(null);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(null);
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <nav aria-label="Main" className={styles.menuBar} ref={bar}>
      {menus.map((menu) => {
        const active = inArea(pathname, menu.label);
        if (menu.href) {
          return (
            <Link
              key={menu.label}
              href={menu.href}
              className={`${styles.menuButton} ${active ? styles.menuButtonActive : ""}`}
              aria-current={active ? "page" : undefined}
              onClick={() => setOpen(null)}
            >
              {menu.label}
            </Link>
          );
        }
        const panelId = `${idPrefix}-${menu.label}`;
        const isOpen = open === menu.label;
        return (
          <div key={menu.label} className={styles.menu}>
            <button
              type="button"
              className={`${styles.menuButton} ${active ? styles.menuButtonActive : ""}`}
              aria-expanded={isOpen}
              aria-controls={panelId}
              onClick={() => setOpen(isOpen ? null : menu.label)}
            >
              {menu.label}
              <span className={styles.caret} aria-hidden>
                ▾
              </span>
            </button>
            {isOpen ? (
              <div id={panelId} className={styles.dropdown}>
                {menu.groups.map((group, index) => (
                  <div key={group.heading ?? index} className={styles.dropdownGroup}>
                    {group.heading ? <div className={styles.dropdownHeading}>{group.heading}</div> : null}
                    {group.links.map((link) => (
                      <Link
                        key={link.href}
                        href={link.href}
                        className={`${styles.dropdownLink} ${isCurrent(pathname, search, link.href) ? styles.dropdownLinkActive : ""}`}
                        aria-current={isCurrent(pathname, search, link.href) ? "page" : undefined}
                        onClick={() => setOpen(null)}
                      >
                        {link.label}
                      </Link>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}

/** Phones: a ☰ button opens every section as a full-screen list. */
function PhoneMenu({ onSignOut }: { onSignOut: () => void }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const menus = useVisibleMenus();
  const { user } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // The list opens under the top bar (which wraps to two rows on a phone).
  const [top, setTop] = useState(64);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function close() {
    setOpen(false);
    setExpanded(null);
  }

  return (
    <>
      <button
        type="button"
        className={styles.phoneMenuButton}
        aria-expanded={open}
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={(event) => {
          if (open) {
            close();
            return;
          }
          const bar = event.currentTarget.closest("header");
          setTop(bar ? Math.round(bar.getBoundingClientRect().bottom) : 64);
          setOpen(true);
        }}
      >
        <span aria-hidden>{open ? "✕" : "☰"}</span>
      </button>
      {open ? (
        <div className={styles.phoneMenu} style={{ top }} role="dialog" aria-modal="true" aria-label="Menu">
          <nav aria-label="Main">
            {menus.map((menu) => {
              if (menu.href) {
                return (
                  <Link key={menu.label} href={menu.href} className={styles.phoneSection} onClick={close}>
                    {menu.label}
                  </Link>
                );
              }
              const isExpanded = expanded === menu.label || (expanded === null && inArea(pathname, menu.label));
              return (
                <div key={menu.label}>
                  <button
                    type="button"
                    className={styles.phoneSection}
                    aria-expanded={isExpanded}
                    onClick={() => setExpanded(isExpanded ? "" : menu.label)}
                  >
                    {menu.label}
                    <span aria-hidden>{isExpanded ? "−" : "+"}</span>
                  </button>
                  {isExpanded
                    ? menu.groups.map((group, index) => (
                        <div key={group.heading ?? index}>
                          {group.heading ? <div className={styles.phoneHeading}>{group.heading}</div> : null}
                          {group.links.map((link) => (
                            <Link
                              key={link.href}
                              href={link.href}
                              className={`${styles.phoneLink} ${isCurrent(pathname, search, link.href) ? styles.phoneLinkActive : ""}`}
                              onClick={close}
                            >
                              {link.label}
                            </Link>
                          ))}
                        </div>
                      ))
                    : null}
                </div>
              );
            })}
          </nav>
          <div className={styles.phoneFooter}>
            <Link href="/operations/profile" onClick={close}>
              {user.displayName} · profile and two-step sign-in
            </Link>
            <button type="button" className={styles.linkButton} onClick={onSignOut}>
              Sign out
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function OrganisationPicker() {
  const { organisations, current, selectOrganisation } = useWorkspace();
  if (organisations.length === 0) {
    return <span className={styles.orgMeta}>No organisations yet</span>;
  }
  return (
    <div className={styles.orgPicker}>
      <select
        id="organisation-picker"
        aria-label="Organisation"
        value={current?.id ?? ""}
        onChange={(event) => selectOrganisation(event.target.value)}
      >
        {organisations.map((organisation) => (
          <option key={organisation.id} value={organisation.id}>
            {organisation.displayName}
          </option>
        ))}
      </select>
      {current ? (
        <span className={styles.orgMeta}>
          {ROLE_LABELS[current.role]} · {current.baseCurrency}
        </span>
      ) : null}
    </div>
  );
}

function Shell({ children, warnings }: { children: ReactNode; warnings: string[] }) {
  const router = useRouter();
  const { user } = useWorkspace();

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className={styles.shell}>
      <a href="#main-content" className={styles.skipLink}>
        Skip to content
      </a>
      <header className={styles.topbar}>
        <div className={styles.topRow}>
          <Link href="/operations" className={styles.brand}>
            <span className={styles.brandDot} aria-hidden />
            Tohyee
          </Link>
          <OrganisationPicker />
          <div className={styles.user}>
            <Link href="/operations/profile" className={styles.userName}>
              {user.displayName}
            </Link>
            <button type="button" className={styles.linkButton} onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
          <Suspense fallback={null}>
            <PhoneMenu onSignOut={() => void signOut()} />
          </Suspense>
        </div>
        <Suspense fallback={<nav aria-label="Main" className={styles.menuBar} />}>
          <DesktopMenus />
        </Suspense>
      </header>
      <main id="main-content" className={styles.content} tabIndex={-1}>
        {warnings.map((warning) => (
          <div key={warning} role="alert" className={styles.serverWarning}>
            {warning}
          </div>
        ))}
        {children}
      </main>
    </div>
  );
}

export function AppShell({
  user,
  organisations,
  serverSettingsUrl = null,
  warnings = [],
  children,
}: {
  user: WorkspaceUser;
  organisations: WorkspaceOrganisation[];
  /** Where server settings open on the server computer (passed for server admins). */
  serverSettingsUrl?: string | null;
  /** Server problems shown on every page (only passed for server admins). */
  warnings?: string[];
  children: ReactNode;
}) {
  return (
    <WorkspaceProvider user={user} organisations={organisations} serverSettingsUrl={serverSettingsUrl}>
      <Shell warnings={warnings}>{children}</Shell>
    </WorkspaceProvider>
  );
}
