/**
 * Organisation roles, lowest to highest:
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
export const ROLES = ["viewer", "bookkeeper", "admin", "owner"] as const;

export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = {
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

export const ROLE_LABELS: Record<Role, string> = {
  viewer: "Viewer",
  bookkeeper: "Bookkeeper",
  admin: "Admin",
  owner: "Owner",
};
