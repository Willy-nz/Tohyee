import type { IllustratedIconName } from "./illustrated-icon";

// More specific routes must win over their module's fallback. This only chooses
// decorative artwork; navigation visibility/permissions still come from navigation.ts.
const ROUTES: Array<[string, IllustratedIconName]> = [
  ["/operations/farm/effluent", "effluent"], ["/operations/farm/safety", "safety"],
  ["/operations/farm/map", "maps"], ["/operations/farm/tractor", "location"],
  ["/operations/farm/offline", "offline"], ["/operations/farm/security", "camera"], ["/operations/farm/log", "photo"],
  ["/operations/farming/safety", "safety"], ["/operations/farming/calendar", "calendar"], ["/operations/farming/tasks", "checklist"],
  ["/operations/farming/notebook", "documents"], ["/operations/farming/compare", "analytics"],
  ["/operations/farming/benchmarks", "analytics"], ["/operations/farming/import", "maps"],
  ["/operations/farming/soil", "flask"], ["/operations/farming/co-op-shares", "coins"], ["/operations/farming/apps", "apps"],
  ["/operations/farming/pasture", "farm"], ["/operations/farming/fertiliser", "farm"],
  // Farms and paddocks is drawn as a map; every other farming page is named above.
  ["/operations/farming", "maps"], ["/operations/farm", "farm"],
  ["/operations/livestock/account-sales", "sales"], ["/operations/livestock/valuation", "price"],
  ["/operations/livestock", "livestock"],
  ["/operations/payroll/ird-payments", "coins"], ["/operations/payroll/rosters", "calendar"],
  ["/operations/payroll/my-shifts", "calendar"], ["/operations/payroll/clock-ins", "clock"],
  ["/operations/payroll/timesheets", "clock"], ["/operations/payroll/leave-requests", "leave"],
  ["/operations/payroll/leave", "leave"], ["/operations/payroll/employees", "team"],
  ["/operations/payroll/groups", "team"], ["/operations/payroll/reports", "reports"],
  ["/operations/payroll/workforce-budget", "analytics"], ["/operations/payroll/pay-items", "price"],
  ["/operations/payroll", "payroll"],
  ["/operations/jobs/calendar", "calendar"], ["/operations/jobs/my-visits", "maps"], ["/operations/jobs", "jobs"],
  ["/operations/projects/staff-rates", "price"], ["/operations/projects", "jobs"],
  // Tax: each page its own picture; the calculator stays on the Tax menu itself (decision 1260).
  ["/operations/gst-return", "tax-return"], ["/operations/gst-audit", "inspect"], ["/operations/tax", "tax-code"],
  ["/operations/income-tax", "coins"], ["/operations/rd/costs", "tagged-receipt"], ["/operations/rd/claim", "rd-claim"],
  ["/operations/rd", "flask"],
  // Settings sub-pages get a picture of what they're about; the cog is kept for
  // the Settings hub and genuinely general settings (modules, custom fields, tracking).
  ["/operations/settings/sales-platforms", "shop"], ["/operations/settings/online-payments", "card"],
  ["/operations/settings/email", "mail"], ["/operations/settings/bank-files", "banking"],
  ["/operations/settings/import", "documents"], ["/operations/settings/powerpoint", "reports"],
  ["/operations/settings/payroll-access", "payroll"], ["/operations/settings/customers", "crm"],
  ["/operations/settings/salespeople", "team"], ["/operations/settings/approval-rules", "approval"],
  ["/operations/settings/kilometre-rates", "vehicle"],
  ["/operations/settings", "settings"], ["/operations/members", "team"], ["/operations/modules", "settings"],
  // Reports: a picture for the kind of report; "?report=" picks it (the financial statements keep the chart).
  ["/operations/reports?report=bs", "scales"], ["/operations/reports?report=equity", "scales"],
  ["/operations/reports?report=tb", "inspect"], ["/operations/reports?report=transactions", "inspect"],
  ["/operations/reports?report=cashflow", "coins"], ["/operations/reports/cash-flow-forecast", "coins"],
  ["/operations/reports?report=journals", "accounting"], ["/operations/reports/consolidation", "accounting"],
  ["/operations/reports?report=bankrec", "banking"], ["/operations/reports?report=aged", "awaiting"],
  ["/operations/reports?report=payables", "awaiting"], ["/operations/reports?report=budget", "analytics"],
  ["/operations/reports?report=stock", "inventory"], ["/operations/reports?report=sales", "sales"],
  ["/operations/reports?view=custom", "form"], ["/operations/reports?view=drafts", "form"],
  ["/operations/reports?view=archived", "documents"],
  ["/operations/project-reports/profitability", "jobs"], ["/operations/project-reports/time", "clock"],
  ["/operations/reports", "reports"], ["/operations/project-reports", "reports"], ["/operations/budgets", "analytics"],
  ["/operations/items", "inventory"], ["/operations/inventory", "inventory"],
  ["/operations/stock", "inventory"], ["/operations/fixed-assets", "vehicle"],
  ["/operations/period-close", "calendar"], ["/operations/accounts", "checklist"],
  ["/operations/contacts", "crm"], ["/operations/ai", "ai"],
  ["/operations/bank-accounts", "banking"], ["/operations/bank-rules", "funnel"],
  ["/operations/exchange-rates", "currency"], ["/operations/fx-revaluation", "currency"],
  ["/operations/customer-payments", "coins"], ["/operations/overpayments", "coins"], ["/operations/supplier-payments", "coins"],
  ["/operations/repeating-invoices", "calendar"], ["/operations/repeating-bills", "calendar"],
  ["/operations/invoices?show=awaiting", "awaiting"], ["/operations/bills?show=awaiting", "awaiting"],
  ["/operations/purchases/approvals", "approval"], ["/operations/bills/inbox", "mail"],
  ["/operations/purchases", "purchases"], ["/operations/purchase-orders", "checklist"],
  ["/operations/bills", "receipt"], ["/operations/expense-claims", "receipt"],
  ["/operations/supplier-credit-notes", "credit-note"],
  ["/operations/sales", "sales"], ["/operations/sales-orders", "checklist"],
  ["/operations/invoices", "sales"], ["/operations/customer-statements", "reports"], ["/operations/quotes", "price"], ["/operations/credit-notes", "credit-note"],
  ["/crm/mail", "mail"], ["/crm/email-templates", "mail"], ["/crm/tasks", "calendar"],
  ["/crm/sequences", "pipeline"], ["/crm/follow-ups", "clock"],
  ["/crm/forecasts", "analytics"],
  ["/crm/teams", "team"], ["/crm/reassign", "reassign"], ["/crm/duplicates", "duplicates"],
  ["/crm/record-types", "form"], ["/crm/stages", "pipeline"], ["/crm/dashboard", "analytics"], ["/crm", "crm"],
  ["/analytics/sources", "documents"], ["/analytics/shaping", "funnel"], ["/analytics", "analytics"],
  ["/server/analytics", "analytics"], ["/server/bank-files", "banking"],
  ["/server/users", "team"], ["/server/sign-ins", "key"], ["/server/google-sign-in", "key"],
  ["/server/remote-access", "key"], ["/server/organisations", "accounting"],
  ["/server/email", "mail"], ["/server/backups", "documents"], ["/server", "settings"],
  ["/operations", "accounting"],
];

function matches(route: string, path: string, search: URLSearchParams): boolean {
  const [prefix, query] = route.split("?");
  // A route naming a query ("?report=bs") is that one page only, never the pages under it.
  if (query !== undefined) return path === prefix && [...new URLSearchParams(query)].every(([key, value]) => search.get(key) === value);
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function iconForDestination(href: string | null): IllustratedIconName | undefined {
  if (!href?.startsWith("/") || href.startsWith("//")) return undefined;
  const [beforeHash] = href.split("#");
  const [rawPath, query = ""] = beforeHash.split("?");
  const path = rawPath.replace(/\/+$/, "");
  const search = new URLSearchParams(query);
  return ROUTES.find(([route]) => matches(route, path, search))?.[1];
}

/**
 * A top-level menu's artwork comes from where it leads (its own link, or its
 * first destination), never from its label: "Sales", "Settings" and "More"
 * mean different things in Accounting, CRM and Farm. A menu may name its own
 * `art` when its first link would mislead (CRM Settings opens on Teams).
 */
export function iconForMenu(menu: { href?: string; art?: IllustratedIconName; groups?: Array<{ links: Array<{ href: string }> }> }): IllustratedIconName | undefined {
  if (menu.art) return menu.art;
  return iconForDestination(menu.href ?? menu.groups?.flatMap((group) => group.links)[0]?.href ?? null);
}
