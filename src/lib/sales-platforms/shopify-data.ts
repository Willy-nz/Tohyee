import { abs, add, dec, isDecimalString, mul, neg, sum, toPlainString, ZERO_DECIMAL, type Decimal } from "@/lib/money/decimal";
import type {
  ExtrasRequest,
  ExtrasResult,
  PlatformDailyStats,
  PlatformDiscount,
  PlatformDiscountApplication,
  PlatformFulfilment,
  PlatformGiftCard,
  PlatformGiftCardTransaction,
  PlatformLocation,
  PlatformOrderExtras,
  PlatformSalesBreakdown,
  PlatformStockLevel,
} from "@/lib/sales-platforms/connector";
import { PlatformError } from "@/lib/sales-platforms/connector";
import { STATS_NOT_APPROVED } from "@/lib/sales-platforms/parts";

/**
 * Shopify's read-only extras (decisions 1237-1245, examples SPD1-SPD10):
 * stock levels by location, shop stats (ShopifyQL), discounts, gift cards,
 * and the discounts, shipments and shipping charged on orders. Nothing here
 * changes Shopify or Tohyee's books. Not tried against a real store; the
 * shapes are from shopify.dev's 2026-10 reference, read 2 November 2026:
 *
 * - InventoryLevel.quantities(names:) with "available" and "on_hand"
 *   (on_hand = available + committed + reserved + damaged + safety_stock +
 *   quality_control); read_inventory. Location; read_locations.
 * - shopifyqlQuery(query:) -> { tableData { columns { name dataType
 *   displayName } rows } parseErrors }; read_reports and level 2 protected
 *   customer data, "even for aggregate queries". Datasets `sessions`
 *   (sessions, conversion_rate) and `sales` (orders, gross_sales,
 *   net_sales; dimensions day, product_title, sales_channel). Cells come as
 *   strings.
 * - DiscountCodeBasic and kin: title, status, startsAt, endsAt,
 *   asyncUsageCount, customerGets; read_discounts.
 * - GiftCard: lastCharacters ("the final four characters"), initialValue,
 *   balance, expiresOn, enabled, createdAt, deactivatedAt; read_gift_cards.
 *   GiftCardTransaction (credit, debit, cash out): id, amount, processedAt;
 *   read_gift_card_transactions. The full code is never asked for.
 * - Order.discountApplications, Order.fulfillments (status, createdAt,
 *   deliveredAt, trackingInfo), totalShippingPriceSet, totalDiscountsSet,
 *   displayFulfillmentStatus: read_orders. Order.fulfillmentOrders:
 *   read_merchant_managed_fulfillment_orders (approval may be needed).
 *
 * Not confirmed from the docs (see the PR): FulfillmentTrackingInfo's
 * company/number fields, the sign of a debit's amount (stored negative
 * whatever Shopify sends), whether conversion_rate comes as 2.5 or 0.025
 * (stored as sent), whether asyncUsageCount is on automatic discounts, and
 * the exact wording Shopify uses when it refuses shop reports.
 */

export type Gql = (query: string, variables?: Record<string, unknown>) => Promise<Record<string, unknown>>;

// Query cost: each object 1, each connection sized by `first` (limit 1,000 a query).
const LOCATIONS_PER_PAGE = 100;
const MAX_LOCATION_PAGES = 5;
/** 20 items x (1 + 10 levels x 3) is about 640. */
const INVENTORY_ITEMS_PER_PAGE = 20;
const LEVELS_PER_ITEM = 10;
const MAX_INVENTORY_PAGES = 100;
const DISCOUNTS_PER_PAGE = 50;
const MAX_DISCOUNT_PAGES = 20;
/** 25 cards x (2 + 20 transactions) is about 550. */
const GIFT_CARDS_PER_PAGE = 25;
const TRANSACTIONS_PER_GIFT_CARD = 20;
const MAX_GIFT_CARD_PAGES = 40;
export const DISCOUNT_APPLICATIONS_PER_ORDER = 10;
export const FULFILMENTS_PER_ORDER = 10;
export const FULFILMENT_ORDERS_PER_ORDER = 5;
/** Rows read at most from a breakdown (by product, by channel). */
export const STATS_BREAKDOWN_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Small readers

function text(value: unknown): string | null {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function nodes(connection: unknown): Record<string, unknown>[] {
  const c = record(connection);
  const list = Array.isArray(c.nodes) ? c.nodes : Array.isArray(connection) ? (connection as unknown[]) : [];
  return list.map(record);
}

const hasMore = (connection: unknown) => record(record(connection).pageInfo).hasNextPage === true;
const cursor = (connection: unknown) => text(record(record(connection).pageInfo).endCursor);

/** "gid://shopify/Location/1" -> "1"; null when it isn't a Shopify ID. */
export function idOf(value: unknown): string | null {
  return text(value)?.match(/^(?:gid:\/\/shopify\/[A-Za-z]+\/)?(\d{1,30})$/)?.[1] ?? null;
}

function timestamp(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const time = Date.parse(raw);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function dateOnly(value: unknown): string | null {
  const raw = text(value);
  return raw && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
}

/** A number Shopify sent (string or number) as a decimal string, or null. Floats from JSON are read by their shortest text. */
export function decimalText(value: unknown): string | null {
  const raw = typeof value === "number" && Number.isFinite(value) ? String(value) : text(value);
  if (raw === null || /e/i.test(raw) || !isDecimalString(raw)) return null;
  return toPlainString(dec(raw));
}

const money = (value: unknown): string => decimalText(record(value).amount) ?? "0";
const bagMoney = (bag: unknown): string => money(record(bag).shopMoney);

function wholeNumber(value: unknown): string | null {
  const raw = decimalText(value);
  return raw !== null && /^-?\d+$/.test(raw) ? raw : null;
}

/** Whether Shopify refused for want of access or approval, rather than failing. */
export function isAccessDenied(error: unknown): boolean {
  if (!(error instanceof PlatformError)) return false;
  if ((error as { accessDenied?: boolean }).accessDenied === true) return true;
  return error.platformStatus === 403 || /access denied|not approved|protected customer data|required access/i.test(error.message);
}

// ---------------------------------------------------------------------------
// Stock levels (SPD1-SPD2)

const LOCATIONS_QUERY = `query TohyeeLocations($first: Int!, $after: String) {
  locations(first: $first, after: $after, includeInactive: true) {
    nodes { id name isActive }
    pageInfo { hasNextPage endCursor }
  }
}`;

const INVENTORY_QUERY = `query TohyeeInventory($first: Int!, $after: String) {
  inventoryItems(first: $first, after: $after) {
    nodes {
      id sku tracked
      variant { id title product { title } }
      inventoryLevels(first: ${LEVELS_PER_ITEM}) {
        nodes { location { id } quantities(names: ["available", "on_hand"]) { name quantity } }
        pageInfo { hasNextPage }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

export function shopifyLocationFromGraphql(node: unknown): PlatformLocation | null {
  const n = record(node);
  const externalId = idOf(n.id);
  if (!externalId) return null;
  return { externalId, name: (text(n.name) ?? `Location ${externalId}`).slice(0, 255), active: n.isActive !== false };
}

/** An inventory item's levels, one per location; untracked items and ones without a variant are left out. */
export function shopifyStockFromGraphql(node: unknown): { levels: PlatformStockLevel[]; moreLevels: boolean } {
  const n = record(node);
  const variant = record(n.variant);
  const variantId = idOf(variant.id);
  const itemId = idOf(n.id);
  if (!variantId || !itemId || n.tracked === false) return { levels: [], moreLevels: false };
  const levels: PlatformStockLevel[] = [];
  for (const level of nodes(n.inventoryLevels)) {
    const locationId = idOf(record(level.location).id);
    if (!locationId) continue;
    const quantities = Array.isArray(level.quantities) ? level.quantities.map(record) : [];
    const quantity = (name: string) => wholeNumber(quantities.find((q) => q.name === name)?.quantity) ?? "0";
    levels.push({
      variantId,
      inventoryItemId: itemId,
      locationId,
      sku: text(n.sku),
      productTitle: text(record(variant.product).title),
      variantTitle: text(variant.title),
      available: quantity("available"),
      onHand: quantity("on_hand"),
    });
  }
  return { levels, moreLevels: hasMore(n.inventoryLevels) };
}

async function fetchStock(gql: Gql, notes: string[]): Promise<{ locations: PlatformLocation[]; stock: PlatformStockLevel[]; complete: boolean }> {
  const locations: PlatformLocation[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_LOCATION_PAGES; page += 1) {
    const connection: unknown = (await gql(LOCATIONS_QUERY, { first: LOCATIONS_PER_PAGE, after })).locations;
    for (const node of nodes(connection)) {
      const location = shopifyLocationFromGraphql(node);
      if (location) locations.push(location);
    }
    if (!hasMore(connection) || !cursor(connection)) break;
    after = cursor(connection);
  }
  const stock: PlatformStockLevel[] = [];
  let complete = true;
  after = null;
  for (let page = 0; page < MAX_INVENTORY_PAGES; page += 1) {
    const connection: unknown = (await gql(INVENTORY_QUERY, { first: INVENTORY_ITEMS_PER_PAGE, after })).inventoryItems;
    for (const node of nodes(connection)) {
      const found = shopifyStockFromGraphql(node);
      stock.push(...found.levels);
      if (found.moreLevels) notes.push(`Stock for SKU ${text(node.sku) ?? idOf(node.id)} is at more than ${LEVELS_PER_ITEM} locations; only the first ${LEVELS_PER_ITEM} were read.`);
    }
    if (!hasMore(connection) || !cursor(connection)) break;
    after = cursor(connection);
    if (page === MAX_INVENTORY_PAGES - 1) {
      complete = false;
      notes.push(`The store has more than ${INVENTORY_ITEMS_PER_PAGE * MAX_INVENTORY_PAGES} stock items; only the first ${INVENTORY_ITEMS_PER_PAGE * MAX_INVENTORY_PAGES} were read.`);
    }
  }
  return { locations, stock, complete };
}

// ---------------------------------------------------------------------------
// Shop stats (SPD3-SPD4)

const SHOPIFYQL_QUERY = `query TohyeeShopStats($query: String!) {
  shopifyqlQuery(query: $query) {
    tableData { columns { name dataType } rows }
    parseErrors
  }
}`;

/** The ShopifyQL asked, for the last `days` days (Shopify's own day boundaries, in the store's time zone). */
export function statsQueries(days: number): { sessions: string; sales: string; byProduct: string; byChannel: string } {
  const since = `SINCE -${days}d`;
  return {
    sessions: `FROM sessions SHOW sessions, conversion_rate TIMESERIES day ${since} ORDER BY day ASC`,
    sales: `FROM sales SHOW orders, gross_sales, net_sales TIMESERIES day ${since} ORDER BY day ASC`,
    byProduct: `FROM sales SHOW orders, gross_sales, net_sales GROUP BY day, product_title ${since} ORDER BY day ASC LIMIT ${STATS_BREAKDOWN_LIMIT}`,
    byChannel: `FROM sales SHOW orders, gross_sales, net_sales GROUP BY day, sales_channel ${since} ORDER BY day ASC LIMIT ${STATS_BREAKDOWN_LIMIT}`,
  };
}

/** A ShopifyQL answer as rows keyed by column name (rows come as objects; arrays are read by the columns' order too). */
export function shopifyqlRows(result: unknown): Array<Record<string, unknown>> {
  const r = record(result);
  const errors = Array.isArray(r.parseErrors) ? r.parseErrors.map((e) => text(e) ?? text(record(e).message)).filter(Boolean) : [];
  if (errors.length > 0) throw new PlatformError(200, `Shopify couldn't read the shop stats question: ${errors.join("; ")}`);
  const table = record(r.tableData);
  const columns = (Array.isArray(table.columns) ? table.columns : []).map((c) => text(record(c).name) ?? "");
  return (Array.isArray(table.rows) ? table.rows : []).map((row) =>
    Array.isArray(row) ? Object.fromEntries(columns.map((name, index) => [name, row[index]])) : record(row),
  );
}

/** Merges the sessions and sales answers into one row a day. */
export function dailyStats(sessions: Array<Record<string, unknown>>, sales: Array<Record<string, unknown>>): PlatformDailyStats[] {
  const days = new Map<string, PlatformDailyStats>();
  const day = (key: string) => {
    let row = days.get(key);
    if (!row) {
      row = { day: key, sessions: null, conversionRate: null, orders: null, grossSales: null, netSales: null };
      days.set(key, row);
    }
    return row;
  };
  for (const row of sessions) {
    const key = dateOnly(row.day);
    if (!key) continue;
    Object.assign(day(key), { sessions: wholeNumber(row.sessions), conversionRate: decimalText(row.conversion_rate) });
  }
  for (const row of sales) {
    const key = dateOnly(row.day);
    if (!key) continue;
    Object.assign(day(key), { orders: wholeNumber(row.orders), grossSales: decimalText(row.gross_sales), netSales: decimalText(row.net_sales) });
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export function salesBreakdown(rows: Array<Record<string, unknown>>, dimension: "product" | "channel"): PlatformSalesBreakdown[] {
  const field = dimension === "product" ? "product_title" : "sales_channel";
  const seen = new Map<string, PlatformSalesBreakdown>();
  for (const row of rows) {
    const day = dateOnly(row.day);
    if (!day) continue;
    const value = (text(row[field]) ?? "(none)").slice(0, 255);
    // Two titles the same after trimming are added together.
    const key = `${day}\u0000${value}`;
    const before = seen.get(key);
    const orders = wholeNumber(row.orders);
    const gross = decimalText(row.gross_sales);
    const net = decimalText(row.net_sales);
    const plus = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : toPlainString(add(dec(a), dec(b))));
    seen.set(key, before
      ? { ...before, orders: plus(before.orders, orders), grossSales: plus(before.grossSales, gross), netSales: plus(before.netSales, net) }
      : { day, dimension, value, orders, grossSales: gross, netSales: net });
  }
  return [...seen.values()];
}

async function fetchStats(gql: Gql, days: number, notes: string[]): Promise<ExtrasResult["stats"]> {
  const queries = statsQueries(days);
  const ask = async (query: string) => shopifyqlRows((await gql(SHOPIFYQL_QUERY, { query })).shopifyqlQuery);
  try {
    const sessions = await ask(queries.sessions);
    const sales = await ask(queries.sales);
    const byProduct = await ask(queries.byProduct);
    const byChannel = await ask(queries.byChannel);
    if (byProduct.length >= STATS_BREAKDOWN_LIMIT) notes.push(`Sales by product had more than ${STATS_BREAKDOWN_LIMIT} rows; only the first ${STATS_BREAKDOWN_LIMIT} came in.`);
    if (byChannel.length >= STATS_BREAKDOWN_LIMIT) notes.push(`Sales by channel had more than ${STATS_BREAKDOWN_LIMIT} rows; only the first ${STATS_BREAKDOWN_LIMIT} came in.`);
    return {
      daily: dailyStats(sessions, sales),
      breakdown: [...salesBreakdown(byProduct, "product"), ...salesBreakdown(byChannel, "channel")],
      days,
    };
  } catch (error) {
    // Shopify refuses shop reports until it approves the app (level 2 protected customer data): logged, not a failed sync.
    if (isAccessDenied(error)) {
      notes.push(STATS_NOT_APPROVED);
      return null;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Discounts (SPD5-SPD6)

const DISCOUNT_VALUE = `value {
  __typename
  ... on DiscountPercentage { percentage }
  ... on DiscountAmount { amount { amount currencyCode } }
}`;
const DISCOUNT_COMMON = "title status startsAt endsAt asyncUsageCount";

const DISCOUNTS_QUERY = `query TohyeeDiscounts($first: Int!, $after: String) {
  discountNodes(first: $first, after: $after) {
    nodes {
      id
      discount {
        __typename
        ... on DiscountCodeBasic { ${DISCOUNT_COMMON} customerGets { ${DISCOUNT_VALUE} } }
        ... on DiscountCodeBxgy { ${DISCOUNT_COMMON} }
        ... on DiscountCodeFreeShipping { ${DISCOUNT_COMMON} }
        ... on DiscountCodeApp { ${DISCOUNT_COMMON} }
        ... on DiscountAutomaticBasic { ${DISCOUNT_COMMON} customerGets { ${DISCOUNT_VALUE} } }
        ... on DiscountAutomaticBxgy { ${DISCOUNT_COMMON} }
        ... on DiscountAutomaticFreeShipping { ${DISCOUNT_COMMON} }
        ... on DiscountAutomaticApp { ${DISCOUNT_COMMON} }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const DISCOUNT_TYPES: Record<string, { method: "code" | "automatic"; type: string }> = {
  DiscountCodeBasic: { method: "code", type: "amount_off" },
  DiscountCodeBxgy: { method: "code", type: "buy_x_get_y" },
  DiscountCodeFreeShipping: { method: "code", type: "free_shipping" },
  DiscountCodeApp: { method: "code", type: "app" },
  DiscountAutomaticBasic: { method: "automatic", type: "amount_off" },
  DiscountAutomaticBxgy: { method: "automatic", type: "buy_x_get_y" },
  DiscountAutomaticFreeShipping: { method: "automatic", type: "free_shipping" },
  DiscountAutomaticApp: { method: "automatic", type: "app" },
};

/** A percentage as Shopify sends it (0.1 for 10%) -> "10". */
function percentText(value: unknown): string | null {
  const raw = decimalText(value);
  if (raw === null) return null;
  return toPlainString(mul(dec(raw), dec("100")));
}

export function shopifyDiscountFromGraphql(node: unknown): PlatformDiscount | null {
  const n = record(node);
  const externalId = idOf(n.id);
  const discount = record(n.discount);
  const kind = DISCOUNT_TYPES[text(discount.__typename) ?? ""];
  if (!externalId || !kind) return null;
  const value = record(record(discount.customerGets).value);
  const valueType = value.__typename === "DiscountPercentage" ? "percentage" : value.__typename === "DiscountAmount" ? "amount" : null;
  const used = wholeNumber(discount.asyncUsageCount);
  return {
    externalId,
    method: kind.method,
    title: (text(discount.title) ?? "Discount").slice(0, 255),
    discountType: kind.type,
    valueType,
    value: valueType === "percentage" ? percentText(value.percentage) : valueType === "amount" ? money(value.amount) : null,
    startsAt: timestamp(discount.startsAt),
    endsAt: timestamp(discount.endsAt),
    status: text(discount.status),
    timesUsed: used === null ? null : Number(used),
  };
}

async function fetchDiscounts(gql: Gql, notes: string[]): Promise<PlatformDiscount[]> {
  const found: PlatformDiscount[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_DISCOUNT_PAGES; page += 1) {
    const connection: unknown = (await gql(DISCOUNTS_QUERY, { first: DISCOUNTS_PER_PAGE, after })).discountNodes;
    for (const node of nodes(connection)) {
      const discount = shopifyDiscountFromGraphql(node);
      if (discount) found.push(discount);
    }
    if (!hasMore(connection) || !cursor(connection)) return found;
    after = cursor(connection);
  }
  notes.push(`The store has more than ${DISCOUNTS_PER_PAGE * MAX_DISCOUNT_PAGES} discounts; only the first ${DISCOUNTS_PER_PAGE * MAX_DISCOUNT_PAGES} were read.`);
  return found;
}

// ---------------------------------------------------------------------------
// Gift cards (SPD7-SPD8). Only lastCharacters is asked for: never the code or maskedCode.

const GIFT_CARDS_QUERY = `query TohyeeGiftCards($first: Int!, $after: String) {
  giftCards(first: $first, after: $after) {
    nodes {
      id lastCharacters enabled expiresOn createdAt deactivatedAt
      initialValue { amount currencyCode }
      balance { amount currencyCode }
      transactions(first: ${TRANSACTIONS_PER_GIFT_CARD}) {
        nodes { __typename id processedAt amount { amount currencyCode } }
        pageInfo { hasNextPage }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const GIFT_CARD_KINDS: Record<string, PlatformGiftCardTransaction["kind"]> = {
  GiftCardCreditTransaction: "credit",
  GiftCardDebitTransaction: "debit",
  GiftCardCashOutTransaction: "cash_out",
};

/** The last characters, letters and digits only, at most 4 (Shopify says "the final four"); anything longer is cut to its last 4. */
export function lastCharacters(value: unknown): string {
  const raw = (text(value) ?? "").replace(/[^A-Za-z0-9]/g, "");
  return raw.slice(-4) || "????";
}

export function shopifyGiftCardFromGraphql(node: unknown): PlatformGiftCard | null {
  const n = record(node);
  const externalId = idOf(n.id);
  if (!externalId) return null;
  const transactions: PlatformGiftCardTransaction[] = [];
  for (const t of nodes(n.transactions)) {
    const id = idOf(t.id);
    const processedAt = timestamp(t.processedAt);
    if (!id || !processedAt) continue;
    const kind = GIFT_CARD_KINDS[text(t.__typename) ?? ""] ?? "other";
    const amount = dec(money(t.amount));
    // Debits and cash outs take money off the card: stored negative, whichever sign Shopify sends (not confirmed in its docs).
    const signed = kind === "credit" ? abs(amount) : kind === "other" ? amount : neg(abs(amount));
    transactions.push({ externalId: id, kind, amount: toPlainString(signed), processedAt });
  }
  return {
    externalId,
    lastCharacters: lastCharacters(n.lastCharacters),
    initialValue: money(n.initialValue),
    balance: money(n.balance),
    currency: text(record(n.balance).currencyCode) ?? text(record(n.initialValue).currencyCode),
    expiresOn: dateOnly(n.expiresOn),
    enabled: n.enabled !== false,
    createdAt: timestamp(n.createdAt),
    deactivatedAt: timestamp(n.deactivatedAt),
    transactions,
    moreTransactions: hasMore(n.transactions),
  };
}

async function fetchGiftCards(gql: Gql, notes: string[]): Promise<PlatformGiftCard[]> {
  const found: PlatformGiftCard[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_GIFT_CARD_PAGES; page += 1) {
    const connection: unknown = (await gql(GIFT_CARDS_QUERY, { first: GIFT_CARDS_PER_PAGE, after })).giftCards;
    for (const node of nodes(connection)) {
      const card = shopifyGiftCardFromGraphql(node);
      if (!card) continue;
      found.push(card);
      if (card.moreTransactions) notes.push(`Gift card ending ${card.lastCharacters} has more than ${TRANSACTIONS_PER_GIFT_CARD} transactions; only the first ${TRANSACTIONS_PER_GIFT_CARD} came in.`);
    }
    if (!hasMore(connection) || !cursor(connection)) return found;
    after = cursor(connection);
  }
  notes.push(`The store has more than ${GIFT_CARDS_PER_PAGE * MAX_GIFT_CARD_PAGES} gift cards; only the first ${GIFT_CARDS_PER_PAGE * MAX_GIFT_CARD_PAGES} were read.`);
  return found;
}

/** The parts asked for, each skipped when null. A refusal of shop reports is a note, not a failure. */
export async function fetchShopifyExtras(gql: Gql, request: ExtrasRequest): Promise<ExtrasResult> {
  const notes: string[] = [];
  const result: ExtrasResult = { locations: null, stock: null, stockComplete: true, stats: null, discounts: null, giftCards: null, notes };
  if (request.stock) {
    const stock = await fetchStock(gql, notes);
    result.locations = stock.locations;
    result.stock = stock.stock;
    result.stockComplete = stock.complete;
  }
  if (request.statsDays !== null) result.stats = await fetchStats(gql, request.statsDays, notes);
  if (request.discounts) result.discounts = await fetchDiscounts(gql, notes);
  if (request.giftCards) result.giftCards = await fetchGiftCards(gql, notes);
  return result;
}

// ---------------------------------------------------------------------------
// On each order (SPD6, SPD9-SPD10): asked for with the order when the part is on.

export type OrderParts = { discounts: boolean; fulfilments: boolean; fulfilmentOrders: boolean };

const MONEY = "shopMoney { amount currencyCode }";

/** Extra fields for ORDER_QUERY; `allocation` goes inside each line's and shipping line's discountAllocations. */
export function orderExtraFields(parts: OrderParts): { order: string; allocation: string; shippingAllocations: string } {
  const order: string[] = [];
  if (parts.discounts) {
    order.push(`totalDiscountsSet { ${MONEY} }
    discountApplications(first: ${DISCOUNT_APPLICATIONS_PER_ORDER}) {
      nodes {
        __typename index
        value { __typename ... on MoneyV2 { amount currencyCode } ... on PricingPercentageValue { percentage } }
        ... on DiscountCodeApplication { code }
        ... on AutomaticDiscountApplication { title }
        ... on ManualDiscountApplication { title }
        ... on ScriptDiscountApplication { title }
      }
      pageInfo { hasNextPage }
    }`);
  }
  if (parts.fulfilments) {
    order.push(`displayFulfillmentStatus totalShippingPriceSet { ${MONEY} }
    fulfillments(first: ${FULFILMENTS_PER_ORDER}) { id status createdAt deliveredAt trackingInfo(first: 1) { company number } }`);
  }
  if (parts.fulfilments && parts.fulfilmentOrders) {
    order.push(`fulfillmentOrders(first: ${FULFILMENT_ORDERS_PER_ORDER}) { nodes { id status } }`);
  }
  return {
    order: order.join("\n    "),
    allocation: parts.discounts ? "discountApplication { index }" : "",
    shippingAllocations: parts.discounts ? `discountAllocations { allocatedAmountSet { ${MONEY} } discountApplication { index } }` : "",
  };
}

const APPLICATION_KINDS: Record<string, PlatformDiscountApplication["kind"]> = {
  DiscountCodeApplication: "code",
  AutomaticDiscountApplication: "automatic",
  ManualDiscountApplication: "manual",
  ScriptDiscountApplication: "script",
};

/**
 * The order's extras from its GraphQL node. Each discount's amount is what
 * Shopify allocated to the lines and shipping lines from that discount (the
 * application itself only gives its rate or amount).
 */
export function shopifyOrderExtrasFromGraphql(node: unknown, parts: OrderParts): PlatformOrderExtras {
  const n = record(node);
  const extras: PlatformOrderExtras = {
    discountApplications: null,
    discountsTotal: null,
    fulfilments: null,
    fulfilmentStatus: null,
    shippingCharged: null,
    fulfilmentOrderStatuses: null,
  };
  if (parts.discounts) {
    const allocated = new Map<number, Decimal[]>();
    const lines = [...nodes(n.lineItems), ...nodes(n.shippingLines)];
    for (const line of lines) {
      for (const allocation of Array.isArray(line.discountAllocations) ? line.discountAllocations.map(record) : []) {
        const index = record(allocation.discountApplication).index;
        if (typeof index !== "number") continue;
        allocated.set(index, [...(allocated.get(index) ?? []), dec(bagMoney(allocation.allocatedAmountSet))]);
      }
    }
    extras.discountApplications = nodes(n.discountApplications).flatMap((application): PlatformDiscountApplication[] => {
      const index = application.index;
      if (typeof index !== "number" || !Number.isInteger(index)) return [];
      const value = record(application.value);
      const valueType = value.__typename === "PricingPercentageValue" ? "percentage" : value.__typename === "MoneyV2" ? "amount" : null;
      return [
        {
          index,
          kind: APPLICATION_KINDS[text(application.__typename) ?? ""] ?? "other",
          code: text(application.code)?.slice(0, 255) ?? null,
          title: text(application.title)?.slice(0, 255) ?? null,
          valueType,
          // PricingPercentageValue.percentage is already a percentage (10.0 for 10%).
          value: valueType === "percentage" ? decimalText(value.percentage) : valueType === "amount" ? money(value) : null,
          amount: toPlainString(sum(allocated.get(index) ?? [ZERO_DECIMAL])),
        },
      ];
    });
    extras.discountsTotal = n.totalDiscountsSet ? bagMoney(n.totalDiscountsSet) : "0";
  }
  if (parts.fulfilments) {
    const list = Array.isArray(n.fulfillments) ? n.fulfillments.map(record) : [];
    extras.fulfilments = list.flatMap((f): PlatformFulfilment[] => {
      const externalId = idOf(f.id);
      if (!externalId) return [];
      const tracking = record(Array.isArray(f.trackingInfo) ? f.trackingInfo[0] : null);
      return [
        {
          externalId,
          status: text(f.status),
          createdAt: timestamp(f.createdAt),
          deliveredAt: timestamp(f.deliveredAt),
          carrier: text(tracking.company)?.slice(0, 255) ?? null,
          trackingNumber: text(tracking.number)?.slice(0, 255) ?? null,
        },
      ];
    });
    extras.fulfilmentStatus = text(n.displayFulfillmentStatus);
    extras.shippingCharged = n.totalShippingPriceSet ? bagMoney(n.totalShippingPriceSet) : "0";
    if (parts.fulfilmentOrders) extras.fulfilmentOrderStatuses = nodes(n.fulfillmentOrders).map((fo) => text(fo.status) ?? "UNKNOWN");
  }
  return extras;
}
