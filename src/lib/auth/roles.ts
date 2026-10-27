/**
 * Organisation roles, lowest to highest:
 *  farm_worker  farm field work only (#447, decision 904): reads and records
 *               field work (cover readings, grazings, feed, soil samples) on
 *               the farms they're assigned (decision 744), and nothing of the
 *               books. Ranked below everything, so every other route refuses
 *               them; the field-work routes let them in through
 *               `withFarmWork` (`@/lib/api/http`).
 *  sales_rep, sales_manager  the CRM only (decision 491, #216): no books,
 *                payroll, analytics or settings. A rep sees every company
 *                and person but only their own deals and tasks; a manager
 *                also sees their teams'. Ranked below everything else so
 *                every other route refuses them; the CRM routes let them in
 *                through `withCrm` (`@/lib/crm/access`).
 *  report_viewer  only the Analytics dashboards shared with them, e.g. a
 *                 client (decision 360); nothing of the books
 *  viewer      read everything (reports, journals, stock, contacts)
 *  bookkeeper  + post journals, corrections, stock movements, FX revaluations;
 *                add, edit and archive contacts
 *  admin       + chart of accounts, tax codes, period locks, members, settings
 *  owner       + manage other owners
 *
 * Server admin is a separate, server-wide flag. It lets someone create
 * organisations and users, but does not by itself grant access to any
 * organisation's books.
 */
export const ROLES = ["farm_worker", "sales_rep", "sales_manager", "report_viewer", "viewer", "bookkeeper", "admin", "owner"] as const;

export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = {
  farm_worker: -3,
  sales_rep: -2,
  sales_manager: -2,
  report_viewer: -1,
  viewer: 0,
  bookkeeper: 1,
  admin: 2,
  owner: 3,
};

export function roleAtLeast(role: Role, minimum: Role): boolean {
  return RANK[role] >= RANK[minimum];
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * Whether a role may do farm field work at a level (decision 904): farm staff
 * read and record; otherwise viewers read and bookkeepers record, as before.
 * Which farms is a separate rule (decision 744, `@/lib/farming/access`).
 */
export function farmWorkAllows(role: Role, need: "read" | "record"): boolean {
  if (role === "farm_worker") return true;
  return roleAtLeast(role, need === "read" ? "viewer" : "bookkeeper");
}

/** The CRM-only roles (decision 491). */
export const SALES_ROLES = ["sales_rep", "sales_manager"] as const;

export function isSalesRole(role: Role): role is (typeof SALES_ROLES)[number] {
  return role === "sales_rep" || role === "sales_manager";
}

/**
 * Whether a role may use the CRM at a level (decision 491): sales roles read
 * and change CRM records, viewers read, bookkeepers change, admins set it up.
 */
export function crmAllows(role: Role, need: "read" | "write" | "admin"): boolean {
  if (need === "admin") return roleAtLeast(role, "admin");
  if (isSalesRole(role)) return true;
  return roleAtLeast(role, need === "write" ? "bookkeeper" : "viewer");
}

export const ROLE_LABELS: Record<Role, string> = {
  farm_worker: "Farm staff",
  sales_rep: "Sales rep",
  sales_manager: "Sales manager",
  report_viewer: "Report viewer",
  viewer: "Viewer",
  bookkeeper: "Bookkeeper",
  admin: "Admin",
  owner: "Owner",
};
