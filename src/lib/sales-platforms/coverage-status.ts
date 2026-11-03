/**
 * What each part of a store connection has brought in (#532 part 2,
 * decision 1256): Customers, Products, Orders and Payouts, each off, needing
 * set-up, not synced yet, up to date, partly brought in, or failed, with
 * counts taken from the connection's mappings, documents and sync log. Pure,
 * shared with the browser. Nothing here guesses a count it wasn't given.
 */
import { ORDER_SCOPE, PAYOUT_SCOPES, type SalesPlatformConnection, type SyncLogAction, type SyncRecordKind } from "@/lib/sales-platforms/types";

export const COVERAGE_KINDS = ["customers", "products", "orders", "payouts"] as const;
export type CoverageKind = (typeof COVERAGE_KINDS)[number];

export type CoverageState = "off" | "needs_setup" | "not_synced" | "up_to_date" | "partly" | "failed";

/** The sync log's record kinds each part covers. */
export const COVERAGE_RECORD_KINDS: Record<CoverageKind, SyncRecordKind[]> = {
  customers: ["customer"],
  products: ["product_variant"],
  orders: ["order", "refund"],
  payouts: ["payout"],
};

/** A record still not brought in: the newest sync log line about it says so. */
export type OutstandingRecord = { recordKind: SyncRecordKind; action: SyncLogAction; message: string };

/** What the server counted for one connection. */
export type CoverageFacts = {
  /** Contacts and items linked to the store's customers and variants. */
  linkedCustomers: number;
  linkedVariants: number;
  /** Orders and payouts that became documents (not cancelled ones). */
  postedOrders: number;
  postedRefunds: number;
  postedPayouts: number;
  /** Records whose newest log line is skipped, failed or waiting. */
  outstanding: OutstandingRecord[];
  /** Whether that list was cut short (only the first lot were read). */
  outstandingCapped: boolean;
};

export type KindCoverage = {
  kind: CoverageKind;
  label: string;
  state: CoverageState;
  /** One short line: "1,204 brought in", "Posting not set up". */
  summary: string;
  /** Why records weren't brought in, most common first: "12 skipped: no SKU". */
  reasons: Array<{ text: string; count: number; outcome: "skipped" | "failed" | "waiting" }>;
  /** What to do about it, if anything. */
  action: { kind: "setup" | "turn_on" | "scopes" | "log"; text: string } | null;
  /** Payouts only (SPC39): some weren't posted, so "Try again" reads them from the store again. */
  retry?: boolean;
};

/** Plain reasons for the messages Tohyee writes when it skips or refuses a record. Unknown ones are "other". */
export function reasonFor(message: string): string {
  const rules: Array<[RegExp, string]> = [
    [/has no SKU/, "no SKU"],
    [/is a test customer/, "test customer"],
    [/has the same name/, "same name as a contact: check who they are"],
    [/can't be an item code/, "SKU can't be an item code"],
    [/is already linked to .* with the same SKU/, "SKU already linked to another variant"],
    [/isn't paid yet/, "not paid yet"],
    [/guest checkout/i, "guest checkout, no contact chosen"],
    [/locked/i, "date is in a locked period"],
    [/Choose a chargebacks account/, "no chargebacks account chosen"],
    [/Choose a reserve account/, "no reserve account chosen"],
    [/Choose where .* payments go|only Shopify Payments payouts clear/i, "payment method not chosen"],
    [/more than one payment method/i, "split payment"],
    [/payment method/i, "payment method not chosen"],
    [/can't be posted: no .* account is chosen/, "payout account not chosen"],
    [/transfer rows come to|transfer has a fee/, "payout's transfer doesn't match"],
    [/of a type Tohyee doesn't post|a kind Tohyee doesn't know/, "a payout line Tohyee doesn't post"],
    [/transactions come to .* but the payout is/, "totals don't add up"],
    [/customer couldn't be linked/, "customer not linked"],
    [/isn't linked to stock item/, "product not linked yet"],
    [/test order/i, "test order"],
    [/currenc/i, "another currency"],
    [/gift card/i, "gift card"],
    [/don't add up|doesn't add up|can't reproduce/i, "totals don't add up"],
  ];
  for (const [pattern, text] of rules) if (pattern.test(message)) return text;
  return "other reasons";
}

const LABELS: Record<CoverageKind, string> = { customers: "Customers", products: "Products", orders: "Orders", payouts: "Payouts" };

const count = (value: number, one: string, many = `${one}s`) => `${value.toLocaleString("en-NZ")} ${value === 1 ? one : many}`;

/** Groups outstanding records by outcome and reason, most common first. */
export function groupReasons(records: readonly OutstandingRecord[]): KindCoverage["reasons"] {
  const groups = new Map<string, KindCoverage["reasons"][number]>();
  for (const record of records) {
    const outcome = record.action === "failed" ? "failed" : record.action === "waiting" ? "waiting" : "skipped";
    const text = reasonFor(record.message);
    const keyText = `${outcome}|${text}`;
    const group = groups.get(keyText) ?? { text, count: 0, outcome };
    group.count += 1;
    groups.set(keyText, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
}

/** The parts a platform has: WooCommerce matches customers and products by email and SKU, so it has orders only (WC1). */
export function coverageKinds(platform: SalesPlatformConnection["platform"]): CoverageKind[] {
  return platform === "woocommerce" ? ["orders"] : [...COVERAGE_KINDS];
}

/** Whether the posting settings have been chosen at all (so "off" means turned off rather than never set up). */
export function postingSetUp(connection: SalesPlatformConnection): boolean {
  if (!connection.startDate || !connection.salesAccountCode) return false;
  return connection.platform === "woocommerce" || Boolean(connection.clearingAccountCode && connection.payoutAccountCode && connection.feesAccountCode);
}

export function coverageFor(kind: CoverageKind, connection: SalesPlatformConnection, facts: CoverageFacts): KindCoverage {
  const label = LABELS[kind];
  const mine = facts.outstanding.filter((record) => COVERAGE_RECORD_KINDS[kind].includes(record.recordKind));
  // Orders before the start date and payouts Shopify cancelled are skipped on purpose: not a problem to fix.
  const problems = kind === "orders" || kind === "payouts" ? mine.filter((record) => record.action !== "skipped") : mine;
  const reasons = groupReasons(problems);
  const more = facts.outstandingCapped ? " (at least)" : "";
  const base = { kind, label, reasons };

  if (kind === "customers" || kind === "products") {
    const on = kind === "customers" ? connection.syncCustomers : connection.syncProducts;
    const linked = kind === "customers" ? facts.linkedCustomers : facts.linkedVariants;
    const noun = kind === "customers" ? "contact" : "item";
    if (!on) return { ...base, state: "off", summary: `Off: not brought in${linked ? ` (${count(linked, noun)} linked earlier)` : ""}`, reasons: [], action: null };
    if (!connection.lastSyncAt && linked === 0) return { ...base, state: "not_synced", summary: "Not synced yet", reasons: [], action: null };
    if (problems.length === 0) {
      // A sync that failed outright (e.g. refused credentials) means it isn't up to date, whatever came in before.
      return connection.lastError
        ? { ...base, state: "failed", summary: `${count(linked, noun)} linked; the last sync failed`, action: null }
        : { ...base, state: "up_to_date", summary: `Up to date: ${count(linked, noun)} linked`, action: null };
    }
    const failedOnly = linked === 0 && problems.every((record) => record.action === "failed");
    return {
      ...base,
      state: failedOnly ? "failed" : "partly",
      summary: `${count(linked, noun)} linked, ${count(problems.length, "record")}${more} not brought in`,
      action: { kind: "log", text: "See why" },
    };
  }

  if (!connection.postToAccounts) {
    return postingSetUp(connection)
      ? { ...base, state: "off", summary: "Posting is off: nothing is brought in", reasons: [], action: { kind: "turn_on", text: "Turn on" } }
      : { ...base, state: "needs_setup", summary: "Posting not set up: nothing is brought in", reasons: [], action: { kind: "setup", text: "Set up" } };
  }
  const missingScopes = kind === "orders" ? (connection.grantedScopes.includes(ORDER_SCOPE) ? [] : [ORDER_SCOPE]) : PAYOUT_SCOPES.filter((scope) => !connection.grantedScopes.includes(scope));
  if (connection.platform === "shopify" && missingScopes.length > 0) {
    return { ...base, state: "needs_setup", summary: `Shopify hasn't given the app ${missingScopes.join(" and ")}`, reasons: [], action: { kind: "scopes", text: "Which scopes" } };
  }
  const posted =
    kind === "orders"
      ? `${count(facts.postedOrders, "order")}${facts.postedRefunds ? ` and ${count(facts.postedRefunds, "refund")}` : ""} posted since ${connection.startDate}`
      : `${count(facts.postedPayouts, "payout")} posted since ${connection.startDate}`;
  if (!connection.lastSyncAt) return { ...base, state: "not_synced", summary: "Not synced yet", reasons: [], action: null };
  if (problems.length === 0) {
    return connection.lastError
      ? { ...base, state: "failed", summary: `${posted}; the last sync failed`, action: null }
      : { ...base, state: "up_to_date", summary: `Up to date: ${posted}`, action: null };
  }
  const postedAny = kind === "orders" ? facts.postedOrders > 0 : facts.postedPayouts > 0;
  return {
    ...base,
    state: !postedAny && problems.every((record) => record.action === "failed") ? "failed" : "partly",
    summary: `${posted}; ${count(problems.length, kind === "orders" ? "order or refund" : "payout", kind === "orders" ? "orders or refunds" : "payouts")}${more} not posted yet`,
    action: { kind: "log", text: "See why" },
    ...(kind === "payouts" ? { retry: true } : {}),
  };
}
