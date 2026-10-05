import { UnavailableError, ValidationError } from "@/lib/errors";

/**
 * A small client for Stripe's API (https://docs.stripe.com/api), used with
 * the organisation's own restricted key (ST1-ST10, PN1-PN12). It reads the
 * balance, balance transactions and checkout sessions, and makes and switches
 * off payment links, which only ever take money in. Every call has a
 * timeout, and none is made inside a database transaction.
 */
export const STRIPE_API = "https://api.stripe.com/v1";

export type StripeFeeDetail = { amount?: unknown; currency?: unknown; type?: unknown };

export type StripeBalanceTransaction = {
  id: string;
  amount: number;
  fee?: number;
  fee_details?: StripeFeeDetail[];
  net?: number;
  currency: string;
  created: number;
  description?: string | null;
  exchange_rate?: number | null;
  reporting_category?: string | null;
  status?: string;
  type?: string;
  /** Expanded when asked: the charge or other object behind the transaction. */
  source?: { amount?: unknown; currency?: unknown } | string | null;
};

export type StripeBalance = Array<{ currency: string; available: number; pending: number }>;

/** Lets tests swap the network for canned responses. */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
let fetcher: FetchLike = (input, init) => fetch(input, init);
export function setStripeFetchForTests(replacement: FetchLike | null): void {
  fetcher = replacement ?? ((input, init) => fetch(input, init));
}

export class StripeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A restricted key, checked by its form (ST1). Full secret keys are refused: they could move money. */
export function parseRestrictedKey(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) throw new ValidationError("Paste the restricted key from your Stripe dashboard.");
  const key = input.trim();
  if (/^sk_(live|test)_/.test(key))
    throw new ValidationError(
      "Use a restricted key (read access, plus write access to payment links for Pay now). Tohyee doesn't take full secret keys, which can move money.",
    );
  if (!/^rk_(live|test)_[A-Za-z0-9]{10,250}$/.test(key))
    throw new ValidationError("That isn't a Stripe restricted key. It starts with rk_live_ (or rk_test_ in test mode).");
  return key;
}

/** Payment links with an inline price need this API version or later (Stripe changelog, 2025-07-30). */
export const PAYMENT_LINKS_API_VERSION = "2025-07-30.basil";

async function call<T>(
  key: string,
  path: string,
  params?: URLSearchParams,
  post?: { form: URLSearchParams; idempotencyKey?: string; version?: string },
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(`${STRIPE_API}${path}${params ? `?${params.toString()}` : ""}`, {
      method: post ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        ...(post ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(post?.idempotencyKey ? { "Idempotency-Key": post.idempotencyKey } : {}),
        ...(post?.version ? { "Stripe-Version": post.version } : {}),
      },
      body: post ? post.form.toString() : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new StripeError(0, `Stripe couldn't be reached (${error instanceof Error ? error.message : "network error"}).`);
  }
  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    data = {};
  }
  if (!response.ok) {
    const detail = (data.error as { message?: unknown } | undefined)?.message;
    const message = typeof detail === "string" ? detail : `Stripe answered ${response.status}.`;
    if (response.status === 401) throw new StripeError(401, `Stripe refused the key: ${message}`);
    if (response.status === 403)
      throw new StripeError(
        403,
        post
          ? `The key can't make payment links: ${message} Give the restricted key write access to payment links (and the prices and products they make).`
          : `The key can't read this: ${message} Give the restricted key read access to the balance.`,
      );
    throw new StripeError(response.status, message);
  }
  return data as T;
}

/** Stripe's balance per currency (available and pending, in the smallest unit). */
export async function fetchBalance(key: string): Promise<StripeBalance> {
  const data = await call<{ available?: Array<{ amount: number; currency: string }>; pending?: Array<{ amount: number; currency: string }> }>(
    key,
    "/balance",
  );
  const byCurrency = new Map<string, { currency: string; available: number; pending: number }>();
  const entry = (currency: string) => {
    const code = currency.toUpperCase();
    if (!byCurrency.has(code)) byCurrency.set(code, { currency: code, available: 0, pending: 0 });
    return byCurrency.get(code)!;
  };
  for (const item of data.available ?? []) entry(item.currency).available += item.amount;
  for (const item of data.pending ?? []) entry(item.currency).pending += item.amount;
  return [...byCurrency.values()].sort((left, right) => left.currency.localeCompare(right.currency));
}

/**
 * Balance transactions in one currency created at or after `since` (Unix
 * seconds), oldest first, following Stripe's pages, with each source
 * expanded so a converted charge's own currency and amount are known.
 */
export async function listBalanceTransactions(key: string, currency: string, since: number): Promise<StripeBalanceTransaction[]> {
  const all: StripeBalanceTransaction[] = [];
  let after: string | null = null;
  for (let page = 0; page < 1000; page += 1) {
    const params = new URLSearchParams({ limit: "100", currency: currency.toLowerCase(), "created[gte]": String(since) });
    params.append("expand[]", "data.source");
    if (after) params.set("starting_after", after);
    const data: { data?: StripeBalanceTransaction[]; has_more?: boolean } = await call(key, "/balance_transactions", params);
    const items = data.data ?? [];
    all.push(...items);
    if (!data.has_more || items.length === 0) return all.reverse();
    after = items[items.length - 1].id;
  }
  throw new StripeError(0, "Stripe returned too many pages of balance transactions.");
}

export type StripePaymentLink = { id: string; url: string; active: boolean };

/**
 * Makes a payment link for one invoice (PN2): one line for the amount due in
 * the invoice's currency, at most one completed payment, the invoice's id in
 * its metadata and "Payment for INV-..." on the payment.
 */
export async function createPaymentLink(
  key: string,
  input: { invoiceId: string; invoiceNumber: string; currency: string; amountMinor: number; inactiveMessage: string; idempotencyKey: string },
): Promise<StripePaymentLink> {
  const form = new URLSearchParams();
  form.set("line_items[0][price_data][currency]", input.currency.toLowerCase());
  form.set("line_items[0][price_data][unit_amount]", String(input.amountMinor));
  form.set("line_items[0][price_data][product_data][name]", `Invoice ${input.invoiceNumber}`);
  form.set("line_items[0][quantity]", "1");
  form.set("restrictions[completed_sessions][limit]", "1");
  form.set("inactive_message", input.inactiveMessage.slice(0, 500));
  form.set("metadata[tohyee_invoice_id]", input.invoiceId);
  form.set("payment_intent_data[description]", `Payment for ${input.invoiceNumber}`);
  form.set("payment_intent_data[metadata][tohyee_invoice_id]", input.invoiceId);
  const data = await call<{ id?: unknown; url?: unknown; active?: unknown }>(key, "/payment_links", undefined, {
    form,
    idempotencyKey: input.idempotencyKey,
    version: PAYMENT_LINKS_API_VERSION,
  });
  if (typeof data.id !== "string" || typeof data.url !== "string" || !data.url.startsWith("https://")) {
    throw new StripeError(0, "Stripe didn't return a payment link.");
  }
  return { id: data.id, url: data.url, active: data.active !== false };
}

/** Switches a payment link off (PN5, PN10, PN11): anyone opening it sees its inactive message. */
export async function deactivatePaymentLink(key: string, linkId: string): Promise<void> {
  const form = new URLSearchParams({ active: "false" });
  await call(key, `/payment_links/${encodeURIComponent(linkId)}`, undefined, { form, version: PAYMENT_LINKS_API_VERSION });
}

export type StripeCheckoutSession = {
  id: string;
  status?: string;
  payment_status?: string;
  amount_total?: number | null;
  currency?: string | null;
  created?: number;
  payment_link?: string | null;
  /** Expanded: the payment, its charge and the charge's balance transaction. */
  payment_intent?:
    | string
    | {
        id?: string;
        latest_charge?: string | { id?: string; created?: number; balance_transaction?: string | StripeBalanceTransaction | null } | null;
      }
    | null;
};

/** A payment link's completed checkout sessions (PN3), with the payment, charge and balance transaction expanded. */
export async function listCompletedSessions(key: string, linkId: string): Promise<StripeCheckoutSession[]> {
  const all: StripeCheckoutSession[] = [];
  let after: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const params = new URLSearchParams({ limit: "100", payment_link: linkId, status: "complete" });
    params.append("expand[]", "data.payment_intent.latest_charge.balance_transaction");
    if (after) params.set("starting_after", after);
    const data: { data?: StripeCheckoutSession[]; has_more?: boolean } = await call(key, "/checkout/sessions", params);
    const items = data.data ?? [];
    all.push(...items);
    if (!data.has_more || items.length === 0) return all;
    after = items[items.length - 1].id;
  }
  throw new StripeError(0, "Stripe returned too many pages of checkout sessions.");
}

/** Turns a Stripe failure into a message for the person who asked. */
export function stripeProblem(error: unknown): Error {
  if (error instanceof StripeError)
    return error.status === 401 || error.status === 403 ? new ValidationError(error.message) : new UnavailableError(error.message);
  return error instanceof Error ? error : new Error(String(error));
}
