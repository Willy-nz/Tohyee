import { HttpError } from "@/lib/errors";
import type { SalesPlatform } from "@/lib/sales-platforms/types";

/**
 * The connector framework (examples SPC1-SPC23): what Tohyee needs from each
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
  /** ISO 3166-1 alpha-2 country of the customer's default address (SPC16), if the platform said. */
  country?: string | null;
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
  /** Whether the platform tracks its stock (SPC17); null when it didn't say (e.g. a webhook). */
  tracked?: boolean | null;
  updatedAt: string | null;
};

export type StoreInfo = {
  storeName: string;
  currency: string;
  pricesIncludeTax: boolean;
  /** The access scopes the store gave the app. */
  scopes: string[];
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

/** A tax the platform charged on an order line or shipping line. Amounts are decimal strings in the store's currency. */
export type PlatformTaxLine = { title: string | null; rate: string; amount: string };

export type PlatformOrderLine = {
  externalId: string;
  variantId: string | null;
  sku: string | null;
  name: string;
  quantity: string;
  /** Before discounts (Shopify's originalTotalSet). */
  originalTotal: string;
  /** All the discounts allocated to the line. */
  discount: string;
  taxLines: PlatformTaxLine[];
  isGiftCard: boolean;
};

export type PlatformShippingLine = {
  externalId: string;
  title: string;
  /** After discounts (Shopify's discountedPriceSet). */
  amount: string;
  taxLines: PlatformTaxLine[];
  removed: boolean;
};

export type PlatformTransaction = {
  externalId: string;
  /** Shopify's kinds: SALE, CAPTURE, AUTHORIZATION, VOID, REFUND, CHANGE, EMV_AUTHORIZATION, SUGGESTED_REFUND. */
  kind: string;
  /** SUCCESS, PENDING, FAILURE, ERROR, AWAITING_RESPONSE, UNKNOWN. */
  status: string;
  gateway: string | null;
  amount: string;
  currency: string | null;
  processedAt: string | null;
  test: boolean;
};

export type PlatformRefund = {
  externalId: string;
  createdAt: string | null;
  processedAt: string | null;
  lines: Array<{ lineItemId: string; quantity: string; restocked: boolean; subtotal: string; tax: string }>;
  shipping: Array<{ shippingLineId: string | null; subtotal: string; tax: string }>;
  /** Order adjustments (refund discrepancies): Tohyee refuses refunds with any. */
  adjustments: number;
  transactions: PlatformTransaction[];
  /** More lines or transactions than were asked for. */
  incomplete: boolean;
};

export type PlatformOrder = {
  externalId: string;
  name: string;
  processedAt: string;
  updatedAt: string | null;
  cancelledAt: string | null;
  test: boolean;
  taxesIncluded: boolean;
  currency: string;
  presentmentCurrency: string | null;
  /** Shopify's displayFinancialStatus: PAID, PENDING, PARTIALLY_PAID, REFUNDED, VOIDED... */
  financialStatus: string | null;
  /** The total before returns, with taxes and discounts (Shopify's totalPriceSet). */
  total: string;
  customer: PlatformCustomer | null;
  billingCountry: string | null;
  lines: PlatformOrderLine[];
  shipping: PlatformShippingLine[];
  transactions: PlatformTransaction[];
  refunds: PlatformRefund[];
  /** More lines, shipping lines, transactions or refunds than were asked for. */
  incomplete: string | null;
};

export type PlatformBalanceTransaction = {
  externalId: string;
  /** Shopify's ShopifyPaymentsTransactionType: CHARGE, REFUND, ADJUSTMENT, CHARGEBACK... */
  type: string;
  amount: string;
  fee: string;
  net: string;
  currency: string | null;
  orderName: string | null;
  adjustmentReason: string | null;
  test: boolean;
};

export type PlatformPayout = {
  externalId: string;
  issuedAt: string;
  /** SCHEDULED, IN_TRANSIT, PAID, FAILED, CANCELED. */
  status: string;
  /** DEPOSIT or WITHDRAWAL. */
  direction: string;
  net: string;
  currency: string;
  transactions: PlatformBalanceTransaction[];
  /** More balance transactions than were asked for. */
  incomplete: boolean;
};

export type OrdersRequest = {
  /** Orders changed since (exclusive of nothing: overlapping is fine, posting is idempotent). */
  updatedSince: string | null;
  /** Only orders processed on or after this instant. */
  processedFrom: string;
  /** Orders to fetch again whatever their change time (ones that stopped part way). */
  retryIds: string[];
};

export type OrdersResult = { orders: PlatformOrder[]; until: string | null; notes: string[] };

export type PayoutsRequest = { issuedFrom: string; alreadyPosted: (externalId: string) => boolean };

export type PayoutsResult = { payouts: PlatformPayout[]; notes: string[] };

export type WebhookRecords =
  | { kind: "customers"; records: PlatformCustomer[] }
  | { kind: "variants"; records: PlatformVariant[] }
  /** An order changed or was refunded: the order is fetched again from the platform. */
  | { kind: "order"; orderId: string };

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
  /** Orders changed since the last sync, with their lines, transactions and refunds (SPC11-SPC23). Network. */
  fetchOrders(context: ConnectorContext, token: AccessToken, request: OrdersRequest): Promise<OrdersResult>;
  /** One order, or null when the platform doesn't have it. Network. */
  fetchOrder(context: ConnectorContext, token: AccessToken, orderId: string): Promise<PlatformOrder | null>;
  /** Payouts issued since `issuedFrom` with their balance transactions (SPC15). Network. */
  fetchPayouts(context: ConnectorContext, token: AccessToken, request: PayoutsRequest): Promise<PayoutsResult>;
  /** Subscribes the platform's webhooks to `callbackUrl` (order topics too when `orders`); returns their IDs. Network. */
  registerWebhooks(context: ConnectorContext, token: AccessToken, callbackUrl: string, options?: { orders?: boolean }): Promise<string[]>;
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
