"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, Suspense, useEffect, useId, useRef, useState } from "react";
import { type AppKey, AppSwitcher } from "@/components/app-switcher";
import { type Modules, useModules } from "@/components/modules";
import { ROLE_LABELS, type Role } from "@/lib/auth/roles";
import styles from "./app-shell.module.css";
import {
  useWorkspace,
  type WorkspaceOrganisation,
  WorkspaceProvider,
  type WorkspaceUser,
} from "./workspace";

/** An optional module a menu or link belongs to (example MOD1); shown only while it's on. */
type ModuleKey = "crm" | "reporting" | "notForProfit";
type MenuLink = { href: string; label: string; minRole?: Role; module?: ModuleKey };
type MenuGroup = { heading?: string; links: MenuLink[] };
/** `area`: the paths that show the menu as current (default: AREAS by its label). */
type Menu = { label: string; href?: string; groups: MenuGroup[]; module?: ModuleKey; area?: string[]; minRole?: Role };

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
          { href: "/operations/customer-payments", label: "Payments for several invoices" },
          { href: "/operations/credit-notes", label: "Credit notes" },
          { href: "/operations/quotes", label: "Quotes" },
          { href: "/operations/sales-orders", label: "Sales orders" },
          { href: "/operations/repeating-invoices", label: "Repeating invoices" },
          { href: "/operations/items", label: "Products and services" },
          { href: "/operations/overpayments", label: "Overpayments" },
        ],
      },
      {
        heading: "Create",
        links: [
          { href: "/operations/invoices/new", label: "New invoice", minRole: "bookkeeper" },
          { href: "/operations/quotes/new", label: "New quote", minRole: "bookkeeper" },
          { href: "/operations/sales-orders/new", label: "New sales order", minRole: "bookkeeper" },
          { href: "/operations/credit-notes/new", label: "New credit note", minRole: "bookkeeper" },
          { href: "/operations/customer-payments/new", label: "Receive a payment", minRole: "bookkeeper" },
        ],
      },
      {
        heading: "Projects",
        links: [
          { href: "/operations/projects", label: "Projects" },
          { href: "/operations/projects/new", label: "New project", minRole: "bookkeeper" },
          { href: "/operations/projects/staff-rates", label: "Staff cost rates" },
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
          { href: "/operations/purchase-orders", label: "Purchase orders" },
          { href: "/operations/repeating-bills", label: "Repeating bills" },
          { href: "/operations/supplier-credit-notes", label: "Supplier credit notes" },
          { href: "/operations/supplier-payments", label: "Payments for several bills" },
          { href: "/operations/expense-claims", label: "Expense claims" },
        ],
      },
      {
        heading: "Create",
        links: [
          { href: "/operations/bills/new", label: "New bill", minRole: "bookkeeper" },
          { href: "/operations/purchase-orders/new", label: "New purchase order", minRole: "bookkeeper" },
          { href: "/operations/supplier-credit-notes/new", label: "New supplier credit note", minRole: "bookkeeper" },
          { href: "/operations/supplier-payments/new", label: "Pay bills", minRole: "bookkeeper" },
          { href: "/operations/expense-claims/new", label: "New expense claim", minRole: "bookkeeper" },
        ],
      },
    ],
  },
  {
    label: "Payroll",
    groups: [
      {
        links: [
          { href: "/operations/payroll/pay-runs", label: "Pay runs", minRole: "bookkeeper" },
          { href: "/operations/payroll/timesheets", label: "Timesheets", minRole: "viewer" },
          { href: "/operations/payroll/leave-requests", label: "Leave requests", minRole: "viewer" },
          { href: "/operations/payroll/leave", label: "Leave", minRole: "bookkeeper" },
          { href: "/operations/payroll/ird-payments", label: "IRD payments", minRole: "bookkeeper" },
          { href: "/operations/payroll/reports", label: "Reports", minRole: "bookkeeper" },
          { href: "/operations/payroll/workforce-budget", label: "Workforce budget", minRole: "bookkeeper" },
          { href: "/operations/payroll/employees", label: "Employees", minRole: "bookkeeper" },
          { href: "/operations/payroll/groups", label: "Pay groups and employee groups", minRole: "bookkeeper" },
          { href: "/operations/payroll/pay-items", label: "Pay items", minRole: "bookkeeper" },
          { href: "/operations/settings/bank-files", label: "Bank file settings", minRole: "bookkeeper" },
          { href: "/operations/settings/payroll-access", label: "Payroll access", minRole: "admin" },
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
          { href: "/operations/reports?report=aged", label: "Aged receivables" },
          { href: "/operations/reports?report=payables", label: "Aged payables" },
          { href: "/operations/reports?report=transactions", label: "Account transactions" },
          { href: "/operations/reports?report=bankrec", label: "Bank reconciliation" },
          { href: "/operations/reports?report=journals", label: "Journal report" },
          { href: "/operations/reports?report=sales", label: "Sales by salesperson", module: "reporting" },
          { href: "/operations/reports?report=budget", label: "Budget vs actual" },
          { href: "/operations/fixed-assets/register", label: "Fixed asset register" },
          { href: "/operations/project-reports/profitability", label: "Project profitability" },
          { href: "/operations/project-reports/time", label: "Time report" },
          { href: "/operations/budgets", label: "Budgets" },
        ],
      },
      {
        heading: "Custom reports",
        links: [
          { href: "/operations/reports?view=custom", label: "New custom report", minRole: "bookkeeper" },
          { href: "/operations/reports?view=drafts", label: "Drafts" },
          { href: "/operations/reports?view=published", label: "Published" },
          { href: "/operations/reports?view=archived", label: "Archived" },
        ],
      },
      {
        heading: "Not-for-profit",
        links: [
          { href: "/operations/settings/tracking", label: "Set up fund tracking", minRole: "admin", module: "notForProfit" },
          { href: "/operations/reports?report=pnl", label: "Fund activity", module: "notForProfit" },
          { href: "/operations/budgets", label: "Budgets by fund", module: "notForProfit" },
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
          // Also under Sales; Jess looked for items here (2 Oct 2026).
          { href: "/operations/items", label: "Products and services" },
          { href: "/operations/inventory", label: "Stock" },
          { href: "/operations/fixed-assets", label: "Fixed assets" },
          { href: "/operations/fixed-assets/depreciation", label: "Depreciation" },
          { href: "/operations/exchange-rates", label: "Exchange rates" },
          { href: "/operations/fx-revaluation", label: "FX revaluation", minRole: "bookkeeper" },
          { href: "/operations/period-close", label: "Period close" },
        ],
      },
      {
        heading: "Settings",
        links: [
          { href: "/operations/settings", label: "Settings", minRole: "admin" },
          { href: "/operations/settings/tracking", label: "Tracking categories", minRole: "admin", module: "reporting" },
          { href: "/operations/settings/custom-fields", label: "Custom fields", minRole: "admin", module: "reporting" },
          { href: "/crm/record-types", label: "CRM record types", minRole: "admin", module: "crm" },
          { href: "/crm/stages", label: "CRM opportunity stages", minRole: "admin", module: "crm" },
          { href: "/operations/settings/salespeople", label: "Salespeople", minRole: "admin", module: "reporting" },
          { href: "/operations/settings/customers", label: "Payment terms and customers", minRole: "admin" },
          { href: "/operations/settings/import", label: "Import and export", minRole: "admin" },
          { href: "/operations/settings/email", label: "Email", minRole: "admin" },
          { href: "/operations/settings/sales-platforms", label: "Sales platforms" },
          { href: "/operations/settings/payroll-access", label: "Payroll access", minRole: "admin" },
          { href: "/operations/settings/bank-files", label: "Bank files", minRole: "bookkeeper" },
          { href: "/operations/fixed-assets/types", label: "Fixed asset types", minRole: "admin" },
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
          { href: "/operations/gst-audit", label: "GST audit report" },
          { href: "/operations/tax", label: "Tax codes" },
        ],
      },
      {
        heading: "R&D Tax Incentive",
        links: [
          { href: "/operations/rd", label: "R&D activities" },
          { href: "/operations/rd/costs", label: "Tagged R&D costs" },
          { href: "/operations/rd/claim", label: "R&D claim report" },
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
          { href: "/operations/customer-statements", label: "Customer statements" },
        ],
      },
    ],
  },
];

/** The CRM's tabs (its own app, under /crm); shown only while the CRM is on (MOD1). */
const CRM_MENUS: Menu[] = [
  { label: "Home", href: "/crm", area: ["/crm"] },
  { label: "Companies", href: "/crm/companies", area: ["/crm/companies"] },
  { label: "People", href: "/crm/people", area: ["/crm/people"] },
  { label: "Pipeline", href: "/crm/pipeline", area: ["/crm/pipeline", "/crm/opportunities"] },
  { label: "Forecasts", href: "/crm/forecasts", area: ["/crm/forecasts"] },
  { label: "Tasks", href: "/crm/tasks", area: ["/crm/tasks"] },
  { label: "Email and calendar", href: "/crm/mail", area: ["/crm/mail"] },
  { label: "Record types", href: "/crm/record-types", area: ["/crm/record-types"], minRole: "admin" as const },
  { label: "Stages", href: "/crm/stages", area: ["/crm/stages"], minRole: "admin" as const },
].map((menu) => ({ ...menu, groups: [], module: "crm" as const }));

/** The paths a menu covers, so its button shows as the current area. */
const AREAS: Record<string, string[]> = {
  Home: ["/operations"],
  Sales: [
    "/operations/sales",
    "/operations/items",
    "/operations/invoices",
    "/operations/credit-notes",
    "/operations/quotes",
    "/operations/sales-orders",
    "/operations/repeating-invoices",
    "/operations/overpayments",
    "/operations/customer-payments",
    "/operations/projects",
  ],
  Purchases: ["/operations/purchases", "/operations/bills", "/operations/purchase-orders", "/operations/repeating-bills", "/operations/supplier-credit-notes", "/operations/supplier-payments", "/operations/expense-claims"],
  Reporting: ["/operations/reports", "/operations/budgets", "/operations/project-reports"],
  Accounting: [
    "/operations/bank-accounts",
    "/operations/bank-rules",
    "/operations/ledger-journals",
    "/operations/accounts",
    "/operations/inventory",
    "/operations/fixed-assets",
    "/operations/exchange-rates",
    "/operations/fx-revaluation",
    "/operations/period-close",
    "/operations/settings",
    "/operations/members",
  ],
  Tax: ["/operations/gst-return", "/operations/gst-audit", "/operations/tax", "/operations/rd"],
  Contacts: ["/operations/contacts", "/operations/customer-statements"],
};

function inArea(pathname: string, menu: Menu): boolean {
  return (menu.area ?? AREAS[menu.label] ?? []).some((path) =>
    path === "/operations" || path === "/crm" ? pathname === path : pathname === path || pathname.startsWith(`${path}/`),
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

function useVisibleMenus(app: AppKey, modules: Modules | null): Menu[] {
  const { can } = useWorkspace();
  const moduleOn = (key: ModuleKey | undefined) => !key || Boolean(modules?.[key]);
  return (app === "crm" ? CRM_MENUS : MENUS).filter((menu) => moduleOn(menu.module) && (!menu.minRole || can(menu.minRole))).map((menu) => ({
    ...menu,
    groups: menu.groups
      .map((group) => ({ ...group, links: group.links.filter((link) => (!link.minRole || can(link.minRole)) && moduleOn(link.module)) }))
      .filter((group) => group.links.length > 0),
  }));
}

function DesktopMenus({ menus }: { menus: Menu[] }) {
  const pathname = usePathname();
  const search = useSearchParams();
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
        const active = inArea(pathname, menu);
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
function PhoneMenu({ menus, onSignOut }: { menus: Menu[]; onSignOut: () => void }) {
  const pathname = usePathname();
  const search = useSearchParams();
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
                  <Link
                    key={menu.label}
                    href={menu.href}
                    className={styles.phoneSection}
                    aria-current={inArea(pathname, menu) ? "page" : undefined}
                    onClick={close}
                  >
                    {menu.label}
                  </Link>
                );
              }
              const isExpanded = expanded === menu.label || (expanded === null && inArea(pathname, menu));
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

function Shell({ app, children, warnings }: { app: AppKey; children: ReactNode; warnings: string[] }) {
  const router = useRouter();
  const { user, current } = useWorkspace();
  const modules = useModules(current?.id ?? null);
  const menus = useVisibleMenus(app, modules);

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className={styles.shell}>
      <a href="#main-content" className={styles.skipLink} data-print="hide">
        Skip to content
      </a>
      <header className={styles.topbar} data-print="hide">
        <div className={styles.topRow}>
          <Link href="/operations" className={styles.brand}>
            <span className={styles.brandDot} aria-hidden />
            Tohyee
          </Link>
          <AppSwitcher current={app} modules={modules} />
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
            <PhoneMenu menus={menus} onSignOut={() => void signOut()} />
          </Suspense>
        </div>
        <Suspense fallback={<nav aria-label="Main" className={styles.menuBar} />}>
          <DesktopMenus menus={menus} />
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
  app = "accounting",
  user,
  organisations,
  serverSettingsUrl = null,
  warnings = [],
  children,
}: {
  /** Which app's top bar and menus to show. */
  app?: AppKey;
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
      <Shell app={app} warnings={warnings}>
        {children}
      </Shell>
    </WorkspaceProvider>
  );
}
