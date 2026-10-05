import type { Modules } from "@/components/modules";
import type { Role } from "@/lib/auth/roles";

/** An optional module a menu or link belongs to (example MOD1); shown only while it's on. */
export type ModuleKey = "crm" | "reporting" | "notForProfit" | "analytics";
export type MenuLink = { href: string; label: string; minRole?: Role; module?: ModuleKey };
export type MenuGroup = { heading: string; links: MenuLink[] };
/** `area`: the paths that show the menu as current (default: AREAS by its label). */
export type Menu = { label: string; href?: string; groups: MenuGroup[]; module?: ModuleKey; area?: string[]; minRole?: Role };

/**
 * The accounting menus: Home, Sales, Purchases, Banking, Payroll, Reports,
 * Accountant. Each opens to a panel of a few labelled groups.
 * Making something new lives in the "+ New" menu (NEW_ACTIONS), not here.
 * Server settings aren't here: they open only on the server computer.
 */
export const MENUS: Menu[] = [
  { label: "Home", href: "/operations", groups: [] },
  {
    label: "Sales",
    groups: [
      {
        heading: "Documents",
        links: [
          { href: "/operations/sales", label: "Sales overview" },
          { href: "/operations/invoices", label: "Invoices" },
          { href: "/operations/invoices?show=awaiting", label: "Awaiting payment" },
          { href: "/operations/quotes", label: "Quotes" },
          { href: "/operations/sales-orders", label: "Sales orders" },
          { href: "/operations/credit-notes", label: "Credit notes" },
          { href: "/operations/repeating-invoices", label: "Repeating invoices" },
        ],
      },
      {
        heading: "Money in",
        links: [
          { href: "/operations/customer-payments", label: "Payments for several invoices" },
          { href: "/operations/overpayments", label: "Overpayments" },
        ],
      },
      {
        heading: "Customers and items",
        links: [
          { href: "/operations/contacts?type=customers", label: "Customers" },
          { href: "/operations/contacts", label: "All contacts" },
          { href: "/operations/customer-statements", label: "Customer statements" },
          { href: "/operations/projects", label: "Projects" },
          { href: "/operations/projects/staff-rates", label: "Staff cost rates" },
          { href: "/operations/items", label: "Products and services" },
        ],
      },
    ],
  },
  {
    label: "Purchases",
    groups: [
      {
        heading: "Documents",
        links: [
          { href: "/operations/purchases", label: "Purchases overview" },
          { href: "/operations/bills", label: "Bills" },
          { href: "/operations/bills/inbox", label: "Bills inbox" },
          { href: "/operations/bills?show=awaiting", label: "Awaiting payment" },
          { href: "/operations/purchase-orders", label: "Purchase orders" },
          { href: "/operations/supplier-credit-notes", label: "Supplier credit notes" },
          { href: "/operations/repeating-bills", label: "Repeating bills" },
          { href: "/operations/purchases/approvals", label: "Approvals" },
        ],
      },
      {
        heading: "Suppliers and money out",
        links: [
          { href: "/operations/contacts?type=suppliers", label: "Suppliers" },
          { href: "/operations/supplier-payments", label: "Payments for several bills" },
          { href: "/operations/expense-claims", label: "Expense claims" },
        ],
      },
    ],
  },
  {
    label: "Banking",
    groups: [
      {
        heading: "Banking",
        links: [
          { href: "/operations/bank-accounts", label: "Bank accounts" },
          { href: "/operations/bank-rules", label: "Bank rules" },
          { href: "/operations/exchange-rates", label: "Exchange rates" },
        ],
      },
      {
        heading: "FX",
        links: [
          { href: "/operations/fx-revaluation", label: "FX revaluation", minRole: "bookkeeper" },
        ],
      },
    ],
  },
  {
    label: "Payroll",
    groups: [
      {
        heading: "Pay",
        links: [
          { href: "/operations/payroll/pay-runs", label: "Pay runs", minRole: "bookkeeper" },
          { href: "/operations/payroll/timesheets", label: "Timesheets", minRole: "viewer" },
          { href: "/operations/payroll/leave-requests", label: "Leave requests", minRole: "viewer" },
          { href: "/operations/payroll/leave", label: "Leave", minRole: "bookkeeper" },
          { href: "/operations/payroll/ird-payments", label: "IRD payments", minRole: "bookkeeper" },
        ],
      },
      {
        heading: "People and reports",
        links: [
          { href: "/operations/payroll/employees", label: "Employees", minRole: "bookkeeper" },
          { href: "/operations/payroll/reports", label: "Reports", minRole: "bookkeeper" },
          { href: "/operations/payroll/workforce-budget", label: "Workforce budget", minRole: "bookkeeper" },
        ],
      },
      {
        heading: "Settings",
        links: [
          { href: "/operations/payroll/groups", label: "Pay groups and employee groups", minRole: "bookkeeper" },
          { href: "/operations/payroll/pay-items", label: "Pay items", minRole: "bookkeeper" },
          { href: "/operations/settings/bank-files", label: "Bank file settings", minRole: "bookkeeper" },
          { href: "/operations/settings/payroll-access", label: "Payroll access", minRole: "admin" },
        ],
      },
    ],
  },
  {
    label: "Reports",
    groups: [
      {
        heading: "Financial statements",
        links: [
          { href: "/operations/reports?report=pnl", label: "Profit and loss" },
          { href: "/operations/reports?report=bs", label: "Balance sheet" },
          { href: "/operations/reports?report=tb", label: "Trial balance" },
          { href: "/operations/reports?report=transactions", label: "Account transactions" },
          { href: "/operations/reports?report=journals", label: "Journal report" },
          { href: "/operations/reports?report=bankrec", label: "Bank reconciliation" },
          { href: "/operations/reports?report=aged", label: "Aged receivables" },
          { href: "/operations/reports?report=payables", label: "Aged payables" },
        ],
      },
      {
        heading: "Business",
        links: [
          { href: "/operations/reports?report=stock", label: "Stock valuation" },
          { href: "/operations/reports?report=sales", label: "Sales by salesperson", module: "reporting" },
          { href: "/operations/budgets", label: "Budgets" },
          { href: "/operations/reports?report=budget", label: "Budget vs actual" },
          { href: "/operations/reports/cash-flow-forecast", label: "Cash flow forecast" },
          { href: "/operations/fixed-assets/register", label: "Fixed asset register" },
          { href: "/operations/project-reports/profitability", label: "Project profitability" },
          { href: "/operations/project-reports/time", label: "Time report" },
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
    label: "Accountant",
    groups: [
      {
        heading: "Ledger",
        links: [
          { href: "/operations/ledger-journals", label: "Journals" },
          { href: "/operations/accounts", label: "Chart of accounts" },
          { href: "/operations/period-close", label: "Period close" },
          // Also under Sales; Jess looked for items here (2 Oct 2026).
          { href: "/operations/items", label: "Products and services" },
          { href: "/operations/inventory", label: "Stock" },
        ],
      },
      {
        heading: "Assets",
        links: [
          { href: "/operations/fixed-assets", label: "Fixed assets" },
          { href: "/operations/fixed-assets/depreciation", label: "Depreciation" },
        ],
      },
      {
        heading: "Tax and R&D",
        links: [
          { href: "/operations/gst-return", label: "GST return" },
          { href: "/operations/gst-audit", label: "GST audit report" },
          { href: "/operations/tax", label: "Tax codes" },
          { href: "/operations/rd", label: "R&D activities" },
          { href: "/operations/rd/costs", label: "Tagged R&D costs" },
          { href: "/operations/rd/claim", label: "R&D claim report" },
        ],
      },
      {
        heading: "Settings",
        links: [
          { href: "/operations/settings", label: "Organisation settings", minRole: "admin" },
          { href: "/operations/members", label: "People and roles", minRole: "admin" },
          { href: "/operations/settings/customers", label: "Payment terms and customers", minRole: "admin" },
          { href: "/operations/settings/email", label: "Email", minRole: "admin" },
          { href: "/operations/settings/import", label: "Import and export", minRole: "admin" },
          { href: "/operations/settings/tracking", label: "Tracking categories", minRole: "admin", module: "reporting" },
          { href: "/operations/settings/custom-fields", label: "Custom fields", minRole: "admin", module: "reporting" },
          { href: "/operations/settings/salespeople", label: "Salespeople", minRole: "admin", module: "reporting" },
          { href: "/operations/settings/sales-platforms", label: "Sales platforms" },
          { href: "/operations/fixed-assets/types", label: "Fixed asset types", minRole: "admin" },
          { href: "/operations/settings/bank-files", label: "Bank files", minRole: "bookkeeper" },
          { href: "/operations/settings/kilometre-rates", label: "Kilometre rates" },
          { href: "/operations/settings/online-payments", label: "Online payments" },
          { href: "/operations/settings/approval-rules", label: "Approval rules" },
          { href: "/operations/settings/payroll-access", label: "Payroll access", minRole: "admin" },
          { href: "/crm/record-types", label: "CRM record types", minRole: "admin", module: "crm" },
          { href: "/crm/stages", label: "CRM opportunity stages", minRole: "admin", module: "crm" },
        ],
      },
    ],
  },
];

/** Everything someone can start from the "+ New" button (moved out of the Sales and Purchases menus). */
export const NEW_ACTIONS: MenuGroup[] = [
  {
    heading: "Sales",
    links: [
      { href: "/operations/invoices/new", label: "New invoice", minRole: "bookkeeper" },
      { href: "/operations/quotes/new", label: "New quote", minRole: "bookkeeper" },
      { href: "/operations/sales-orders/new", label: "New sales order", minRole: "bookkeeper" },
      { href: "/operations/credit-notes/new", label: "New credit note", minRole: "bookkeeper" },
      { href: "/operations/customer-payments/new", label: "Receive a payment", minRole: "bookkeeper" },
      { href: "/operations/projects/new", label: "New project", minRole: "bookkeeper" },
    ],
  },
  {
    heading: "Purchases",
    links: [
      { href: "/operations/bills/new", label: "New bill", minRole: "bookkeeper" },
      { href: "/operations/purchase-orders/new", label: "New purchase order", minRole: "bookkeeper" },
      { href: "/operations/supplier-credit-notes/new", label: "New supplier credit note", minRole: "bookkeeper" },
      { href: "/operations/supplier-payments/new", label: "Pay bills", minRole: "bookkeeper" },
      { href: "/operations/expense-claims/new", label: "New expense claim", minRole: "bookkeeper" },
    ],
  },
];

/** The CRM's tabs (its own app, under /crm); shown only while the CRM is on (MOD1). */
export const CRM_MENUS: Menu[] = [
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

/** Analytics' tabs (its own app, under /analytics); shown only while Analytics is on (decision 353). */
export const ANALYTICS_MENUS: Menu[] = [
  { label: "Dashboards", href: "/analytics", area: ["/analytics", "/analytics/dashboards"] },
  { label: "Data sources", href: "/analytics/sources", area: ["/analytics/sources"], minRole: "viewer" as const },
  { label: "Shaping", href: "/analytics/shaping", area: ["/analytics/shaping"], minRole: "viewer" as const },
].map((menu) => ({ ...menu, groups: [], module: "analytics" as const }));

/** The AI assistant's page; shown to everyone (the page itself checks what they may do). */
export const AI_LINK: MenuLink = { href: "/operations/ai", label: "AI" };

/** The paths a menu covers, so its button shows as the current area. */
export const AREAS: Record<string, string[]> = {
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
  Payroll: ["/operations/payroll"],
  Banking: ["/operations/bank-accounts", "/operations/bank-rules", "/operations/exchange-rates", "/operations/fx-revaluation"],
  Reports: ["/operations/reports", "/operations/budgets", "/operations/project-reports"],
  Accountant: [
    "/operations/accounts",
    "/operations/ledger-journals",
    "/operations/inventory",
    "/operations/fixed-assets",
    "/operations/period-close",
    "/operations/bank-accounts",
    "/operations/gst-return",
    "/operations/gst-audit",
    "/operations/tax",
    "/operations/rd",
    "/operations/settings",
    "/operations/members",
  ],
};

export function inArea(pathname: string, menu: Menu): boolean {
  return (menu.area ?? AREAS[menu.label] ?? []).some((path) =>
    path === "/operations" || path === "/crm" || path === "/analytics" ? pathname === path : pathname === path || pathname.startsWith(`${path}/`),
  );
}

/** Whether a menu link is the page being shown (its path and any ?query it names). */
export function isCurrent(pathname: string, search: URLSearchParams, href: string): boolean {
  const [path, query] = href.split("?");
  if (pathname !== path) return false;
  const wanted = new URLSearchParams(query ?? "");
  if ([...wanted.keys()].length === 0) {
    return !search.get("show") && !search.get("type") && !search.get("report");
  }
  return [...wanted.entries()].every(([key, value]) => search.get(key) === value);
}

type Access = { can(role: Role): boolean; modules: Modules | null };

function linkVisible(link: MenuLink, { can, modules }: Access): boolean {
  return (!link.minRole || can(link.minRole)) && (!link.module || Boolean(modules?.[link.module]));
}

function filterGroups(groups: MenuGroup[], access: Access): MenuGroup[] {
  return groups
    .map((group) => ({ ...group, links: group.links.filter((link) => linkVisible(link, access)) }))
    .filter((group) => group.links.length > 0);
}

/** The menus someone may see in an app: their role and the organisation's modules decide. */
export function visibleMenus(app: "accounting" | "crm" | "analytics", access: Access): Menu[] {
  return (app === "crm" ? CRM_MENUS : app === "analytics" ? ANALYTICS_MENUS : MENUS)
    .filter((menu) => (!menu.module || Boolean(access.modules?.[menu.module])) && (!menu.minRole || access.can(menu.minRole)))
    .map((menu) => ({ ...menu, groups: filterGroups(menu.groups, access) }));
}

/** The "+ New" actions someone may start (bookkeepers and up, today). */
export function visibleNewActions(access: Access): MenuGroup[] {
  return filterGroups(NEW_ACTIONS, access);
}

/** One row in the command palette: where it goes and what it's called. */
export type Destination = { href: string; label: string; group: string };

/** Every place the menus and "+ New" offer, for the command palette (exact duplicates dropped). */
export function destinations(menus: Menu[], newActions: MenuGroup[], extra: Destination[] = []): Destination[] {
  const all: Destination[] = [];
  for (const group of newActions) {
    for (const link of group.links) all.push({ href: link.href, label: link.label, group: `New › ${group.heading}` });
  }
  for (const menu of menus) {
    if (menu.href) all.push({ href: menu.href, label: menu.label, group: menu.label });
    for (const group of menu.groups) {
      for (const link of group.links) {
        all.push({ href: link.href, label: link.label, group: group.heading === menu.label ? menu.label : `${menu.label} › ${group.heading}` });
      }
    }
  }
  all.push(...extra);
  const seen = new Set<string>();
  return all.filter((item) => {
    const key = `${item.href}|${item.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Loose matching for the command palette: every word typed must appear in
 * the label or its group, ignoring case. Label matches sort first, then
 * those starting with what was typed.
 */
export function searchDestinations(items: Destination[], query: string): Destination[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items;
  const scored = items
    .map((item, index) => {
      const label = item.label.toLowerCase();
      const haystack = `${label} ${item.group.toLowerCase()}`;
      if (!words.every((word) => haystack.includes(word))) return null;
      let score = 0;
      if (label.startsWith(words[0])) score -= 20;
      else if (words.every((word) => label.includes(word))) score -= 10;
      return { item, score, index };
    })
    .filter((entry): entry is { item: Destination; score: number; index: number } => entry !== null);
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored.map((entry) => entry.item);
}
