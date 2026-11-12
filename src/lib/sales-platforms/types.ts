/**
 * Sales platform connections (examples SPC1-SPC23): names and shapes shared
 * with the browser. No server imports here.
 */

export const SALES_PLATFORMS = ["shopify", "woocommerce"] as const;
export type SalesPlatform = (typeof SALES_PLATFORMS)[number];

export const SALES_PLATFORM_LABELS: Record<SalesPlatform, string> = {
  shopify: "Shopify",
  woocommerce: "WooCommerce",
};

export const SHOPIFY_AUTH_METHODS = ["access_token", "client_credentials"] as const;
export type ShopifyAuthMethod = (typeof SHOPIFY_AUTH_METHODS)[number];

export const AUTH_METHOD_LABELS: Record<string, string> = {
  access_token: "Admin API access token",
  client_credentials: "Client ID and secret",
  api_key: "REST API key",
};

/**
 * WooCommerce (WC1-WC10): where each payment method's money goes. An
 * account the payment is recorded into, or "Left owing" (bank transfer,
 * cheque): the invoice is left for the bank feed to match. Neither: seen on
 * an order but not chosen yet, so such orders wait (WC8).
 */
export type PaymentMethodMapping = {
  method: string;
  title: string | null;
  accountCode: string | null;
  leftOwing: boolean;
};

export type ConnectionStatus = "active" | "paused" | "disconnected";

/**
 * Which store customers become contacts (decision 1334): every customer,
 * or only customers who have ordered (a contact is added when their first
 * order is posted). New connections default to "buyers".
 */
export const CUSTOMER_SCOPES = ["buyers", "all"] as const;
export type CustomerScope = (typeof CUSTOMER_SCOPES)[number];

export type SalesPlatformConnection = {
  id: string;
  platform: SalesPlatform;
  storeDomain: string;
  storeName: string | null;
  storeCurrency: string | null;
  pricesIncludeTax: boolean | null;
  authMethod: string;
  syncCustomers: boolean;
  /** With syncCustomers on: all customers, or only those who have ordered (decision 1334). */
  customerScope: CustomerScope;
  syncProducts: boolean;
  /** The store's variants linked to items, and how many of them have no SKU in the store (decision 1337). */
  productVariants: { linked: number; withoutSku: number };
  status: ConnectionStatus;
  /** The last sync attempt, whether it worked or not. */
  lastSyncAt: string | null;
  /** The last sync that worked (#572): what the books are up to date with. */
  lastSuccessfulSyncAt: string | null;
  lastError: string | null;
  /** The store refused Tohyee's login (401 or 403): only new credentials fix it (#572). */
  needsReconnect: boolean;
  failures: number;
  /** Whether the platform was told to send webhooks here. */
  webhooksActive: boolean;
  webhooksNote: string | null;
  connectedByEmail: string;
  connectedAt: string;
  disconnectedByEmail: string | null;
  disconnectedAt: string | null;
  /** Stage 2 (SPC11-SPC23): orders, refunds and payouts into the accounts. Nothing is fetched or posted while it's off. */
  postToAccounts: boolean;
  /** SSD1: products Shopify tracks inventory for come in as stock items (true), or always as non-stock (made to order). */
  stockItems: boolean;
  /** Only orders processed, and payouts issued, on or after this date (New Zealand time) come in. */
  startDate: string | null;
  clearingAccountCode: string | null;
  payoutAccountCode: string | null;
  feesAccountCode: string | null;
  salesAccountCode: string | null;
  shippingAccountCode: string | null;
  /** Sales when sent's Income in advance account (SWS1), or null when it's off. */
  salesWhenSentAccountCode: string | null;
  /** Where Shopify gift cards sold are held until they're spent (GC1-GC5), or null to refuse orders with gift cards. */
  giftCardAccountCode: string | null;
  /** Products sold as gift cards that Shopify doesn't mark as gift cards (GC6), and ones whose names suggest they are. */
  giftCardItems: Array<{ id: string; code: string; name: string }>;
  giftCardItemSuggestions: Array<{ id: string; code: string; name: string }>;
  /** Where a disputed amount goes (SPC25). */
  chargebacksAccountCode: string | null;
  /** The bank account money Shopify holds back sits in (SPC28). */
  reserveAccountCode: string | null;
  /** WooCommerce: each payment method seen and where its money goes (WC2); empty for Shopify. */
  paymentMethods: PaymentMethodMapping[];
  /** The contact guest checkouts go to (decision 317), or null: guest checkouts are refused. */
  guestContactId: string | null;
  guestContactName: string | null;
  untaxedTaxCode: string | null;
  /** Shopify's tax rate as a percentage ("15") -> the Tohyee tax code. */
  taxCodes: Array<{ rate: string; taxCode: string }>;
  /** The access scopes the store gave the app, as it last said. */
  grantedScopes: string[];
};

/** The scopes stage 2 reads with: orders (with their transactions and refunds), and Shopify Payments payouts. */
export const ORDER_SCOPE = "read_orders";
export const PAYOUT_SCOPES = ["read_shopify_payments_payouts", "read_shopify_payments_accounts"] as const;

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
  | "failed"
  | "posted"
  | "cancelled"
  | "waiting";

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
  posted: "Posted",
  cancelled: "Cancelled",
  waiting: "Waiting",
};

export type SyncRecordKind = "customer" | "product_variant" | "order" | "refund" | "payout";

export type SyncDocumentType = "sales_order" | "invoice" | "customer_payment" | "credit_note" | "credit_note_refund" | "transfer" | "bank_transaction";

export type SyncLogEntry = {
  id: string;
  loggedAt: string;
  source: "sync" | "webhook" | "connection";
  action: SyncLogAction;
  recordKind: SyncRecordKind | null;
  externalId: string | null;
  contactId: string | null;
  itemId: string | null;
  /** The Tohyee document the line is about, if any (stage 2). */
  documentType?: SyncDocumentType | null;
  documentId?: string | null;
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
  /** Orders, refunds and payouts posted to the accounts (stage 2). */
  posted?: number;
  /** Orders waiting (not paid yet, or posting stopped on Tohyee's side and tried again next sync). */
  waiting?: number;
};

/**
 * A store customer not brought in because an active contact has the same
 * name and nothing (no matching email) says whether they're the same person
 * (#539, decisions 1269-1272). An admin decides: same person (link) or
 * different person (a new contact, under `suggestedName` unless they type
 * another).
 */
export type CustomerMatch = {
  externalId: string;
  name: string;
  email: string | null;
  phone: string | null;
  /** The existing contact with the same name. */
  contactId: string;
  contactName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  /** An archived contact can't be linked; only "different person" is offered. */
  contactArchived: boolean;
  /** Whether that contact is already linked to another customer of this store (so it can't be linked to this one). */
  contactLinkedTo: string | null;
  /** A free name for a new contact, e.g. "Alex Example (Shopify)". */
  suggestedName: string;
  firstSeenAt: string;
};

export const CUSTOMER_MATCH_RESOLUTIONS = ["same", "different"] as const;
export type CustomerMatchResolution = (typeof CUSTOMER_MATCH_RESOLUTIONS)[number];
