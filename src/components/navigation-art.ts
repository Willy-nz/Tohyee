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
  ["/operations/rd", "tax"], ["/operations/settings", "settings"],
  ["/operations/reports", "reports"], ["/operations/budgets", "analytics"],
  ["/operations/items", "inventory"], ["/operations/inventory", "inventory"],
  ["/operations/stock", "inventory"], ["/operations/fixed-assets", "inventory"],
  ["/operations/contacts", "crm"], ["/operations/ai", "ai"],
  ["/operations/bank-accounts", "banking"], ["/operations/bank-rules", "banking"],
  ["/operations/exchange-rates", "banking"], ["/operations/fx-revaluation", "banking"],
  ["/operations/customer-payments", "banking"], ["/operations/supplier-payments", "banking"],
  ["/operations/repeating-invoices", "calendar"], ["/operations/repeating-bills", "calendar"],
  ["/operations/purchases", "purchases"], ["/operations/purchase-orders", "purchases"],
  ["/operations/bills", "purchases"], ["/operations/expense-claims", "purchases"],
  ["/operations/supplier-credit-notes", "purchases"],
  ["/operations/sales", "sales"], ["/operations/sales-orders", "sales"],
  ["/operations/invoices", "sales"], ["/operations/quotes", "sales"], ["/operations/credit-notes", "sales"],
  ["/crm/mail", "mail"], ["/crm/email-templates", "mail"], ["/crm/tasks", "calendar"],
  ["/crm/forecasts", "analytics"], ["/crm/dashboard", "analytics"], ["/crm", "crm"],
  ["/analytics/sources", "documents"], ["/analytics/shaping", "settings"], ["/analytics", "analytics"],
  ["/server/analytics", "analytics"], ["/server/bank-files", "banking"],
  ["/server/users", "crm"], ["/server/organisations", "accounting"],
  ["/server/email", "mail"], ["/server/backups", "documents"], ["/server", "settings"],
  ["/operations", "accounting"],
];

export function iconForDestination(href: string | null): IllustratedIconName | undefined {
  if (!href?.startsWith("/") || href.startsWith("//")) return undefined;
  const path = href.split(/[?#]/)[0].replace(/\/+$/, "");
  return ROUTES.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`))?.[1];
}

const SECTIONS: Record<string, IllustratedIconName> = {
  Sales: "sales", Purchases: "purchases", Banking: "banking",
  Payroll: "payroll", Reports: "reports", Accounting: "accounting", Tax: "tax",
  Settings: "settings", Today: "calendar", Map: "maps", Log: "photo", Safety: "safety",
  Effluent: "effluent", More: "farm", CRM: "crm", Analytics: "analytics",
};
export function iconForSection(label: string): IllustratedIconName | undefined {
  return SECTIONS[label];
}
