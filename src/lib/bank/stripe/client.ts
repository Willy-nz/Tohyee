import { UnavailableError, ValidationError } from "@/lib/errors";

/**
 * A small read-only client for Stripe's API (https://docs.stripe.com/api),
 * used with the organisation's own restricted key (ST1-ST10). It reads the
 * balance and balance transactions only. Every call has a timeout, and none
 * is made inside a database transaction.
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
    throw new ValidationError("Use a restricted key with read access only. Tohyee doesn't take full secret keys, which can move money.");
  if (!/^rk_(live|test)_[A-Za-z0-9]{10,250}$/.test(key))
    throw new ValidationError("That isn't a Stripe restricted key. It starts with rk_live_ (or rk_test_ in test mode).");
  return key;
}

async function call<T>(key: string, path: string, params?: URLSearchParams): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(`${STRIPE_API}${path}${params ? `?${params.toString()}` : ""}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
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
      throw new StripeError(403, `The key can't read this: ${message} Give the restricted key read access to the balance.`);
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

/** Turns a Stripe failure into a message for the person who asked. */
export function stripeProblem(error: unknown): Error {
  if (error instanceof StripeError)
    return error.status === 401 || error.status === 403 ? new ValidationError(error.message) : new UnavailableError(error.message);
  return error instanceof Error ? error : new Error(String(error));
}
