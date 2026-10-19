import type { SalesPlatformConnection } from "@/lib/sales-platforms/types";

/**
 * What CRM Home says about sales platforms (#342, decision 582):
 * - stores connected (active or paused): each one's state, last sync and last error;
 * - none, for an admin: a "Connect Shopify" link to Settings › Sales platforms;
 * - none, for anyone else: nothing, since only admins can connect a store.
 */
export type IntegrationsSummary = { kind: "stores"; connections: SalesPlatformConnection[] } | { kind: "connect" } | null;

export function integrationsSummary(connections: SalesPlatformConnection[], isAdmin: boolean): IntegrationsSummary {
  const current = connections.filter((connection) => connection.status !== "disconnected");
  if (current.length > 0) return { kind: "stores", connections: current };
  return isAdmin ? { kind: "connect" } : null;
}
