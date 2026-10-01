/**
 * Sales platform connections (examples SPC1-SPC10): names and shapes shared
 * with the browser. No server imports here.
 */

export const SALES_PLATFORMS = ["shopify"] as const;
export type SalesPlatform = (typeof SALES_PLATFORMS)[number];

export const SALES_PLATFORM_LABELS: Record<SalesPlatform, string> = {
  shopify: "Shopify",
};

export const SHOPIFY_AUTH_METHODS = ["access_token", "client_credentials"] as const;
export type ShopifyAuthMethod = (typeof SHOPIFY_AUTH_METHODS)[number];

export const AUTH_METHOD_LABELS: Record<string, string> = {
  access_token: "Admin API access token",
  client_credentials: "Client ID and secret",
};

export type ConnectionStatus = "active" | "paused" | "disconnected";

export type SalesPlatformConnection = {
  id: string;
  platform: SalesPlatform;
  storeDomain: string;
  storeName: string | null;
  storeCurrency: string | null;
  pricesIncludeTax: boolean | null;
  authMethod: string;
  syncCustomers: boolean;
  syncProducts: boolean;
  status: ConnectionStatus;
  lastSyncAt: string | null;
  lastError: string | null;
  failures: number;
  /** Whether the platform was told to send webhooks here. */
  webhooksActive: boolean;
  webhooksNote: string | null;
  connectedByEmail: string;
  connectedAt: string;
  disconnectedByEmail: string | null;
  disconnectedAt: string | null;
};

export type SyncLogAction =
  | "connected"
  | "tested"
  | "settings"
  | "webhooks"
  | "disconnected"
  | "sync"
  | "created"
  | "linked"
  | "updated"
  | "kept"
  | "skipped"
  | "failed";

export const SYNC_LOG_ACTION_LABELS: Record<SyncLogAction, string> = {
  connected: "Connected",
  tested: "Tested",
  settings: "Settings",
  webhooks: "Webhooks",
  disconnected: "Disconnected",
  sync: "Sync",
  created: "Added",
  linked: "Linked",
  updated: "Updated",
  kept: "Kept Tohyee's value",
  skipped: "Skipped",
  failed: "Failed",
};

export type SyncLogEntry = {
  id: string;
  loggedAt: string;
  source: "sync" | "webhook" | "connection";
  action: SyncLogAction;
  recordKind: "customer" | "product_variant" | null;
  externalId: string | null;
  contactId: string | null;
  itemId: string | null;
  message: string;
  actorEmail: string;
};

export type SyncResult = {
  created: number;
  linked: number;
  updated: number;
  kept: number;
  skipped: number;
  failed: number;
};
