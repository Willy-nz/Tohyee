import { type Role, roleAtLeast } from "@/lib/auth/roles";

/*
 * What a farm app key may do (examples FA1, FA2, decision 561). Browser-safe.
 * Reading needs any role that sees Farming (viewer or higher); recording
 * needs the bookkeeper role or higher, when the key is made and each time
 * it's used.
 */

export const FARM_APP_SCOPES = ["read_farm", "read_soil", "read_pasture", "record_soil_samples", "record_pasture"] as const;
export type FarmAppScope = (typeof FARM_APP_SCOPES)[number];

export const FARM_APP_SCOPE_LABELS: Record<FarmAppScope, string> = {
  read_farm: "Read farms, paddocks and their shapes",
  read_soil: "Read soil tests and samples",
  read_pasture: "Read pasture cover and readings",
  record_soil_samples: "Record soil samples taken in the field",
  record_pasture: "Record pasture cover readings",
};

export const RECORDING_SCOPES: readonly FarmAppScope[] = ["record_soil_samples", "record_pasture"];

export const isFarmAppScope = (value: unknown): value is FarmAppScope => typeof value === "string" && (FARM_APP_SCOPES as readonly string[]).includes(value);

/** The scopes a person with this role may give a key, or use through one. */
export function scopesAllowed(role: Role): FarmAppScope[] {
  if (!roleAtLeast(role, "viewer")) return [];
  return roleAtLeast(role, "bookkeeper") ? [...FARM_APP_SCOPES] : FARM_APP_SCOPES.filter((scope) => !RECORDING_SCOPES.includes(scope));
}

/** A key's scopes capped by its owner's role now (FA2). */
export function effectiveScopes(scopes: readonly FarmAppScope[], role: Role): FarmAppScope[] {
  const allowed = new Set(scopesAllowed(role));
  return scopes.filter((scope) => allowed.has(scope));
}
