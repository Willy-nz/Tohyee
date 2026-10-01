import { HttpError } from "@/lib/errors";
import type { SalesPlatform } from "@/lib/sales-platforms/types";

/**
 * The connector framework (examples SPC1-SPC10): what Tohyee needs from each
 * sales platform. Shopify is the first; WooCommerce, Square and Stripe would
 * each be another connector. Connectors only talk to the platform; the
 * service decides what happens in Tohyee, and network calls never happen
 * inside a database transaction.
 */

/** A platform's customer, in the shape every connector returns. */
export type PlatformCustomer = {
  externalId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  /** ISO timestamp of the platform's last change. */
  updatedAt: string | null;
};

/** One sellable variant of a platform's product (an item in Tohyee). */
export type PlatformVariant = {
  externalId: string;
  productId: string;
  productTitle: string;
  variantTitle: string | null;
  sku: string | null;
  /** As the platform sends it, e.g. "8.50"; tax inclusive or not depends on the store. */
  price: string | null;
  updatedAt: string | null;
};

export type StoreInfo = {
  storeName: string;
  currency: string;
  pricesIncludeTax: boolean;
};

export type AccessToken = { token: string; expiresAt: string | null };

/** What a connector is given for one connection. Credentials are decrypted only for the call. */
export type ConnectorContext = {
  storeDomain: string;
  credentials: Record<string, string>;
  /** The cached access token, if the platform hands out short-lived ones. */
  cachedToken: AccessToken | null;
  now: Date;
};

export type ChangesRequest = {
  customers: boolean;
  products: boolean;
  customersSince: string | null;
  productsSince: string | null;
};

export type Changes = {
  customers: PlatformCustomer[];
  variants: PlatformVariant[];
  /** The newest change seen, to ask from next time (null: nothing new). */
  customersUntil: string | null;
  productsUntil: string | null;
  /** Things worth telling people that aren't one record, e.g. a product with too many variants. */
  notes: string[];
};

export type WebhookRecords = { kind: "customers"; records: PlatformCustomer[] } | { kind: "variants"; records: PlatformVariant[] };

export type ConnectInput = {
  storeDomain: string;
  authMethod: string;
  credentials: Record<string, string>;
};

export interface SalesPlatformConnector {
  readonly platform: SalesPlatform;
  /** Checks what an admin typed: the store's address and the credentials. No network. */
  parseConnectInput(body: Record<string, unknown>): ConnectInput;
  /** A usable access token, asking the platform for a new one when needed. Network. */
  accessToken(context: ConnectorContext): Promise<{ token: AccessToken; renewed: boolean }>;
  /** Reads the store's name, currency and tax setting, and checks the access granted. Network. */
  checkStore(context: ConnectorContext, token: AccessToken): Promise<StoreInfo>;
  /** Customers and variants changed since the last sync. Network. */
  fetchChanges(context: ConnectorContext, token: AccessToken, request: ChangesRequest): Promise<Changes>;
  /** Subscribes the platform's webhooks to `callbackUrl`; returns their IDs. Network. */
  registerWebhooks(context: ConnectorContext, token: AccessToken, callbackUrl: string): Promise<string[]>;
  removeWebhooks(context: ConnectorContext, token: AccessToken, ids: readonly string[]): Promise<void>;
  /** The secret the platform signs webhooks with. */
  webhookSecret(credentials: Record<string, string>): string;
  /**
   * Checks a webhook delivery's signature against the raw body before
   * anything else. Null when it fails or isn't for this store.
   */
  checkWebhook(headers: Headers, rawBody: Buffer, secret: string, storeDomain: string): { deliveryId: string; topic: string } | null;
  /** The records in a verified delivery, or null for a topic Tohyee doesn't handle. */
  webhookRecords(topic: string, body: unknown): WebhookRecords | null;
}

/** The platform answered with an error (or couldn't be reached). */
export class PlatformError extends HttpError {
  /** The platform's HTTP status, or 0 when it couldn't be reached. */
  readonly platformStatus: number;
  constructor(platformStatus: number, message: string) {
    super(502, "platform_error", message);
    this.platformStatus = platformStatus;
  }

  /** The platform refused the credentials. */
  get refused(): boolean {
    return this.platformStatus === 400 || this.platformStatus === 401 || this.platformStatus === 403;
  }
}
