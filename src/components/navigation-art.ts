import type { IllustratedIconName } from "./illustrated-icon";

// More specific routes must win over their module's fallback. This only chooses
// decorative artwork; navigation visibility/permissions still come from navigation.ts.
const ROUTES: Array<[string, IllustratedIconName]> = [
  ["/operations/farm/effluent", "effluent"], ["/operations/farm/safety", "safety"],
  ["/operations/farm/map", "maps"], ["/operations/farm/tractor", "location"],
  ["/operations/farm/offline", "offline"], ["/operations/farm/log", "photo"],
  ["/operations/farming/safety", "safety"], ["/operations/farming/calendar", "calendar"],
  ["/operations/farming/notebook", "documents"], ["/operations/farming/compare", "analytics"],
  ["/operations/farming/benchmarks", "analytics"], ["/operations/farming/import", "maps"],
  ["/operations/farming", "farm"], ["/operations/farm", "farm"],
  ["/operations/livestock", "livestock"], ["/operations/payroll", "payroll"],
  ["/operations/jobs/calendar", "calendar"], ["/operations/jobs", "jobs"], ["/operations/projects", "jobs"],
  ["/operations/tax", "tax"], ["/operations/gst-return", "tax"], ["/operations/gst-audit", "tax"],
  ["/operations/rd", "tax"], ["/operations/income-tax", "tax"],
  // Settings sub-pages get a picture of what they're about; the cog is kept for
  // the Settings hub and genuinely general settings (modules, custom fields, tracking).
  ["/operations/settings/sales-platforms", "shop"], ["/operations/settings/online-payments", "card"],
  ["/operations/settings/email", "mail"], ["/operations/settings/bank-files", "banking"],
  ["/operations/settings/import", "documents"], ["/operations/settings/powerpoint", "reports"],
  ["/operations/settings/payroll-access", "payroll"], ["/operations/settings/customers", "crm"],
  ["/operations/settings/salespeople", "team"], ["/operations/settings/approval-rules", "purchases"],
  ["/operations/settings/kilometre-rates", "maps"],
  ["/operations/settings", "settings"], ["/operations/members", "team"], ["/operations/modules", "settings"],
  ["/operations/reports", "reports"], ["/operations/project-reports", "reports"], ["/operations/budgets", "analytics"],
  ["/operations/items", "inventory"], ["/operations/inventory", "inventory"],
  ["/operations/stock", "inventory"], ["/operations/fixed-assets", "inventory"],
  ["/operations/contacts", "crm"], ["/operations/ai", "ai"],
  ["/operations/bank-accounts", "banking"], ["/operations/bank-rules", "banking"],
  ["/operations/exchange-rates", "banking"], ["/operations/fx-revaluation", "banking"],
  ["/operations/customer-payments", "banking"], ["/operations/overpayments", "banking"], ["/operations/supplier-payments", "banking"],
  ["/operations/repeating-invoices", "calendar"], ["/operations/repeating-bills", "calendar"],
  ["/operations/purchases", "purchases"], ["/operations/purchase-orders", "purchases"],
  ["/operations/bills", "purchases"], ["/operations/expense-claims", "purchases"],
  ["/operations/supplier-credit-notes", "purchases"],
  ["/operations/sales", "sales"], ["/operations/sales-orders", "sales"],
  ["/operations/invoices", "sales"], ["/operations/customer-statements", "sales"], ["/operations/quotes", "sales"], ["/operations/credit-notes", "sales"],
  ["/crm/mail", "mail"], ["/crm/email-templates", "mail"], ["/crm/tasks", "calendar"],
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

export function iconForDestination(href: string | null): IllustratedIconName | undefined {
  if (!href?.startsWith("/") || href.startsWith("//")) return undefined;
  const path = href.split(/[?#]/)[0].replace(/\/+$/, "");
  return ROUTES.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`))?.[1];
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
