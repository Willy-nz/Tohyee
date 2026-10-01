import { createHmac, timingSafeEqual } from "node:crypto";
import { ValidationError } from "@/lib/errors";
import {
  type AccessToken,
  type Changes,
  type ChangesRequest,
  type ConnectInput,
  type ConnectorContext,
  PlatformError,
  type PlatformCustomer,
  type PlatformVariant,
  type SalesPlatformConnector,
  type StoreInfo,
  type WebhookRecords,
} from "@/lib/sales-platforms/connector";
import { SHOPIFY_AUTH_METHODS } from "@/lib/sales-platforms/types";
import { requireOneOf, requireString } from "@/lib/validation";

/**
 * The Shopify connector (examples SPC1-SPC10). Not tried against a real
 * store: the tests use recorded Shopify-shaped responses.
 *
 * - Access: a custom app's Admin API access token (apps made in the store
 *   admin before 1 Jan 2026), or a Dev Dashboard app's client ID and
 *   secret, exchanged for a token that lasts about a day (the client
 *   credentials grant):
 *   https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
 * - The Admin GraphQL API, version 2026-07:
 *   https://shopify.dev/docs/api/admin-graphql/2026-07
 * - Read-only scopes: read_customers, read_products
 *   (https://shopify.dev/docs/api/usage/access-scopes).
 * - Webhooks are signed with the app's secret: X-Shopify-Hmac-SHA256 is the
 *   base64 HMAC-SHA256 of the raw body
 *   (https://shopify.dev/docs/apps/build/webhooks/subscribe/https).
 *
 * shopify.dev couldn't be opened where this was written; the request shapes
 * follow Shopify's own library, github.com/Shopify/shopify-app-js.
 */
export const SHOPIFY_API_VERSION = "2026-07";
export const SHOPIFY_SCOPES = ["read_customers", "read_products"] as const;
const WEBHOOK_TOPICS = ["CUSTOMERS_CREATE", "CUSTOMERS_UPDATE", "PRODUCTS_CREATE", "PRODUCTS_UPDATE"] as const;

const TIMEOUT_MS = 30_000;
const CUSTOMERS_PER_PAGE = 100;
const MAX_CUSTOMER_PAGES = 20;
// Each product asks for up to 100 variants, so few products per page keeps the query under Shopify's cost limit.
const PRODUCTS_PER_PAGE = 8;
const MAX_PRODUCT_PAGES = 50;
const VARIANTS_PER_PRODUCT = 100;
/** A cached token this close to expiring is renewed first. */
const RENEW_BEFORE_MS = 5 * 60 * 1000;

/** Lets tests swap the network for canned responses. */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
let fetcher: FetchLike = (input, init) => fetch(input, init);
export function setSalesPlatformFetchForTests(replacement: FetchLike | null): void {
  fetcher = replacement ?? ((input, init) => fetch(input, init));
}

// ---------------------------------------------------------------------------
// Checking what an admin typed

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/;

/** The store's permanent address, e.g. "glimmers.myshopify.com" (a bare "glimmers" is accepted). */
export function normaliseShopDomain(input: unknown): string {
  const raw = requireString(input, "storeDomain", { maxLength: 255 }).trim().toLowerCase();
  let host = raw.replace(/^https?:\/\//, "").split(/[/?#]/)[0];
  if (/^[a-z0-9][a-z0-9-]*$/.test(host)) host = `${host}.myshopify.com`;
  if (!SHOP_DOMAIN.test(host)) {
    throw new ValidationError("Enter the store's myshopify.com address, like glimmers.myshopify.com (it's in the store's admin address).");
  }
  return host;
}

function secretField(input: unknown, field: string, label: string): string {
  return requireString(input, field, {
    maxLength: 500,
    pattern: /^\S+$/,
    patternHint: `The ${label} can't contain spaces.`,
  });
}

// ---------------------------------------------------------------------------
// Webhook signatures

/** Whether `signature` is the base64 HMAC-SHA256 of the raw body with `secret`, compared in constant time. */
export function verifyShopifyWebhook(rawBody: string | Buffer, signature: string | null, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody).digest();
  const given = Buffer.from(signature.trim(), "base64");
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

// ---------------------------------------------------------------------------
// Record shapes

function text(value: unknown): string | null {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** "gid://shopify/Customer/1001", 1001 or "1001" -> "1001". */
function shopifyId(value: unknown, what: string): string {
  const raw = text(value);
  const id = raw?.match(/^(?:gid:\/\/shopify\/[A-Za-z]+\/)?(\d{1,30})$/)?.[1];
  if (!id) throw new ValidationError(`Shopify sent a ${what} without an ID.`);
  return id;
}

function timestamp(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const time = Date.parse(raw);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function later(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function joinName(first: unknown, last: unknown): string | null {
  return text([text(first), text(last)].filter(Boolean).join(" "));
}

/** A customer from the Admin GraphQL API. `email` and `phone` are deprecated there, so the default ones are read. */
export function shopifyCustomerFromGraphql(node: unknown): PlatformCustomer {
  const n = record(node);
  const email = text(record(n.defaultEmailAddress).emailAddress);
  const phone = text(record(n.defaultPhoneNumber).phoneNumber);
  return {
    externalId: shopifyId(n.id, "customer"),
    name: joinName(n.firstName, n.lastName) ?? text(n.displayName) ?? email ?? phone,
    email,
    phone,
    updatedAt: timestamp(n.updatedAt),
  };
}

/** A customer from a customers/create or customers/update webhook (REST-shaped JSON). */
export function shopifyCustomerFromWebhook(body: unknown): PlatformCustomer {
  const b = record(body);
  const email = text(b.email) ?? text(record(b.default_email_address).email_address);
  const phone = text(b.phone) ?? text(record(b.default_phone_number).phone_number);
  return {
    externalId: shopifyId(b.id, "customer"),
    name: joinName(b.first_name, b.last_name) ?? email ?? phone,
    email,
    phone,
    updatedAt: timestamp(b.updated_at),
  };
}

function variant(
  product: { id: string; title: string; updatedAt: string | null },
  raw: Record<string, unknown>,
  updatedAt: unknown,
): PlatformVariant {
  return {
    externalId: shopifyId(raw.id, "product variant"),
    productId: product.id,
    productTitle: product.title,
    variantTitle: text(raw.title),
    sku: text(raw.sku),
    price: text(raw.price),
    updatedAt: later(product.updatedAt, timestamp(updatedAt)),
  };
}

/** A product's variants from the Admin GraphQL API, and whether it has more than were asked for. */
export function shopifyVariantsFromGraphql(node: unknown): { records: PlatformVariant[]; moreVariants: boolean } {
  const n = record(node);
  const product = { id: shopifyId(n.id, "product"), title: text(n.title) ?? "Untitled product", updatedAt: timestamp(n.updatedAt) };
  const variants = record(n.variants);
  const nodes = Array.isArray(variants.nodes) ? variants.nodes : [];
  return {
    records: nodes.map((raw) => variant(product, record(raw), record(raw).updatedAt)),
    moreVariants: record(variants.pageInfo).hasNextPage === true,
  };
}

/** A product's variants from a products/create or products/update webhook. */
export function shopifyVariantsFromWebhook(body: unknown): PlatformVariant[] {
  const b = record(body);
  const product = { id: shopifyId(b.id, "product"), title: text(b.title) ?? "Untitled product", updatedAt: timestamp(b.updated_at) };
  const variants = Array.isArray(b.variants) ? b.variants : [];
  return variants.map((raw) => variant(product, record(raw), record(raw).updated_at));
}

// ---------------------------------------------------------------------------
// Talking to Shopify (never inside a database transaction)

async function call(url: string, init: RequestInit): Promise<unknown> {
  const host = new URL(url).host;
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new PlatformError(0, `Couldn't reach ${host}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = await response.text();
  let parsed: unknown = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const b = record(parsed);
    const errors = b.errors;
    const detail =
      text(b.error_description) ??
      (typeof errors === "string" ? errors : Array.isArray(errors) ? errors.map((e) => text(record(e).message)).filter(Boolean).join("; ") : null) ??
      text(b.error) ??
      body.slice(0, 200);
    throw new PlatformError(response.status, `${host} said ${response.status}: ${detail || "no details"}`);
  }
  return parsed;
}

async function graphql(storeDomain: string, token: AccessToken, query: string, variables: Record<string, unknown> = {}) {
  const url = `https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const body = record(
    await call(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-Shopify-Access-Token": token.token },
      body: JSON.stringify({ query, variables }),
    }),
  );
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const messages = body.errors.map((e) => text(record(e).message) ?? "unknown error").join("; ");
    throw new PlatformError(200, `${storeDomain} said: ${messages}`);
  }
  return record(body.data);
}

function userErrors(result: Record<string, unknown>): string | null {
  const errors = Array.isArray(result.userErrors) ? result.userErrors : [];
  return errors.length === 0 ? null : errors.map((e) => text(record(e).message) ?? "unknown error").join("; ");
}

const SHOP_QUERY = `query TohyeeShop {
  shop { name myshopifyDomain currencyCode taxesIncluded }
  currentAppInstallation { accessScopes { handle } }
}`;

const CUSTOMERS_QUERY = `query TohyeeCustomers($first: Int!, $after: String, $query: String) {
  customers(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
    nodes {
      id displayName firstName lastName updatedAt
      defaultEmailAddress { emailAddress }
      defaultPhoneNumber { phoneNumber }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const PRODUCTS_QUERY = `query TohyeeProducts($first: Int!, $after: String, $query: String) {
  products(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
    nodes {
      id title updatedAt
      variants(first: ${VARIANTS_PER_PRODUCT}) {
        nodes { id title sku price updatedAt }
        pageInfo { hasNextPage }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const WEBHOOK_CREATE = `mutation TohyeeWebhookCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    webhookSubscription { id }
    userErrors { field message }
  }
}`;

const WEBHOOK_DELETE = `mutation TohyeeWebhookDelete($id: ID!) {
  webhookSubscriptionDelete(id: $id) {
    deletedWebhookSubscriptionId
    userErrors { field message }
  }
}`;

/** Shopify's search syntax for "changed since". */
function changedSince(since: string | null): string | null {
  return since ? `updated_at:>='${new Date(since).toISOString().replace(/\.\d{3}Z$/, "Z")}'` : null;
}

async function pages(
  storeDomain: string,
  token: AccessToken,
  query: string,
  field: "customers" | "products",
  perPage: number,
  maxPages: number,
  since: string | null,
): Promise<unknown[]> {
  const nodes: unknown[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const data = await graphql(storeDomain, token, query, { first: perPage, after, query: changedSince(since) });
    const connection = record(data[field]);
    if (Array.isArray(connection.nodes)) nodes.push(...connection.nodes);
    const info = record(connection.pageInfo);
    if (info.hasNextPage !== true || !text(info.endCursor)) break;
    after = text(info.endCursor);
  }
  return nodes;
}

export const shopifyConnector: SalesPlatformConnector = {
  platform: "shopify",

  parseConnectInput(body): ConnectInput {
    const storeDomain = normaliseShopDomain(body.storeDomain);
    const authMethod = requireOneOf(body.authMethod ?? "access_token", "authMethod", SHOPIFY_AUTH_METHODS);
    if (authMethod === "access_token") {
      return {
        storeDomain,
        authMethod,
        credentials: {
          accessToken: secretField(body.accessToken, "accessToken", "access token"),
          apiSecret: secretField(body.apiSecret, "apiSecret", "API secret key"),
        },
      };
    }
    return {
      storeDomain,
      authMethod,
      credentials: {
        clientId: secretField(body.clientId, "clientId", "client ID"),
        clientSecret: secretField(body.clientSecret, "clientSecret", "client secret"),
      },
    };
  },

  async accessToken(context) {
    const { credentials, cachedToken, now } = context;
    if (credentials.accessToken) return { token: { token: credentials.accessToken, expiresAt: null }, renewed: false };
    if (cachedToken?.expiresAt && Date.parse(cachedToken.expiresAt) - RENEW_BEFORE_MS > now.getTime()) {
      return { token: cachedToken, renewed: false };
    }
    const body = record(
      await call(`https://${context.storeDomain}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ client_id: credentials.clientId, client_secret: credentials.clientSecret, grant_type: "client_credentials" }),
      }),
    );
    const token = text(body.access_token);
    if (!token) throw new PlatformError(200, `${context.storeDomain} didn't send an access token.`);
    const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
    return { token: { token, expiresAt: new Date(now.getTime() + seconds * 1000).toISOString() }, renewed: true };
  },

  async checkStore(context, token): Promise<StoreInfo> {
    const data = await graphql(context.storeDomain, token, SHOP_QUERY);
    const shop = record(data.shop);
    const scopes = (Array.isArray(record(data.currentAppInstallation).accessScopes) ? (record(data.currentAppInstallation).accessScopes as unknown[]) : [])
      .map((scope) => text(record(scope).handle))
      .filter((handle): handle is string => handle !== null);
    const writes = scopes.filter((scope) => scope.startsWith("write_"));
    if (writes.length > 0) {
      throw new ValidationError(
        `This app can change the store (${writes.join(", ")}). Tohyee only reads, so give the app only ${SHOPIFY_SCOPES.join(" and ")}.`,
      );
    }
    const missing = SHOPIFY_SCOPES.filter((scope) => !scopes.includes(scope));
    if (missing.length > 0) {
      throw new ValidationError(`This app doesn't have ${missing.join(" or ")}. Give it ${SHOPIFY_SCOPES.join(" and ")}.`);
    }
    const currency = text(shop.currencyCode);
    if (!currency || !/^[A-Z]{3}$/.test(currency) || typeof shop.taxesIncluded !== "boolean") {
      throw new PlatformError(200, `${context.storeDomain} didn't say its currency and tax setting.`);
    }
    return { storeName: text(shop.name) ?? context.storeDomain, currency, pricesIncludeTax: shop.taxesIncluded };
  },

  async fetchChanges(context, token, request: ChangesRequest): Promise<Changes> {
    const changes: Changes = { customers: [], variants: [], customersUntil: null, productsUntil: null, notes: [] };
    if (request.customers) {
      const nodes = await pages(context.storeDomain, token, CUSTOMERS_QUERY, "customers", CUSTOMERS_PER_PAGE, MAX_CUSTOMER_PAGES, request.customersSince);
      for (const node of nodes) {
        const customer = shopifyCustomerFromGraphql(node);
        changes.customers.push(customer);
        changes.customersUntil = later(changes.customersUntil, customer.updatedAt);
      }
    }
    if (request.products) {
      const nodes = await pages(context.storeDomain, token, PRODUCTS_QUERY, "products", PRODUCTS_PER_PAGE, MAX_PRODUCT_PAGES, request.productsSince);
      for (const node of nodes) {
        const product = shopifyVariantsFromGraphql(node);
        changes.variants.push(...product.records);
        changes.productsUntil = later(changes.productsUntil, timestamp(record(node).updatedAt));
        if (product.moreVariants) {
          changes.notes.push(
            `Product ${shopifyId(record(node).id, "product")} "${text(record(node).title) ?? ""}" has more than ${VARIANTS_PER_PRODUCT} variants; only the first ${VARIANTS_PER_PRODUCT} were synced.`,
          );
        }
      }
    }
    return changes;
  },

  async registerWebhooks(context, token, callbackUrl) {
    const ids: string[] = [];
    for (const topic of WEBHOOK_TOPICS) {
      const data = await graphql(context.storeDomain, token, WEBHOOK_CREATE, { topic, webhookSubscription: { callbackUrl, format: "JSON" } });
      const result = record(data.webhookSubscriptionCreate);
      const problem = userErrors(result);
      if (problem) throw new PlatformError(200, `${context.storeDomain} didn't accept the ${topic} webhook: ${problem}`);
      const id = text(record(result.webhookSubscription).id);
      if (id) ids.push(id);
    }
    return ids;
  },

  async removeWebhooks(context, token, ids) {
    for (const id of ids) {
      const data = await graphql(context.storeDomain, token, WEBHOOK_DELETE, { id });
      const problem = userErrors(record(data.webhookSubscriptionDelete));
      if (problem) throw new PlatformError(200, `${context.storeDomain} didn't remove a webhook: ${problem}`);
    }
  },

  webhookSecret(credentials) {
    return credentials.apiSecret ?? credentials.clientSecret ?? "";
  },

  checkWebhook(headers, rawBody, secret, storeDomain) {
    if (!verifyShopifyWebhook(rawBody, headers.get("x-shopify-hmac-sha256"), secret)) return null;
    if (headers.get("x-shopify-shop-domain")?.trim().toLowerCase() !== storeDomain.toLowerCase()) return null;
    const deliveryId = text(headers.get("x-shopify-webhook-id"));
    const topic = text(headers.get("x-shopify-topic"));
    if (!deliveryId || deliveryId.length > 200 || !topic || topic.length > 100) return null;
    return { deliveryId, topic };
  },

  webhookRecords(topic, body): WebhookRecords | null {
    if (topic === "customers/create" || topic === "customers/update") {
      return { kind: "customers", records: [shopifyCustomerFromWebhook(body)] };
    }
    if (topic === "products/create" || topic === "products/update") {
      return { kind: "variants", records: shopifyVariantsFromWebhook(body) };
    }
    return null;
  },
};
