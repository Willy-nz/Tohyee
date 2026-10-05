import { UnavailableError, ValidationError } from "@/lib/errors";

/**
 * A small read-only client for PayPal's Transaction Search API (PP1-PP10),
 * used with the organisation's own live REST app: an OAuth token from its
 * client ID and secret, then `GET /v1/reporting/balances` and
 * `GET /v1/reporting/transactions` (at most 31 days per request; PayPal says
 * transactions take up to three hours to appear). Every call has a timeout,
 * and none is made inside a database transaction.
 */
export const PAYPAL_API = "https://api-m.paypal.com";
export const MAX_DAYS_PER_REQUEST = 31;

type Money = { currency_code?: unknown; value?: unknown };

export type PayPalTransaction = {
  transaction_info: {
    transaction_id?: unknown;
    transaction_event_code?: unknown;
    transaction_initiation_date?: unknown;
    transaction_amount?: Money;
    fee_amount?: Money;
    transaction_status?: unknown;
    transaction_subject?: unknown;
    invoice_id?: unknown;
  };
  payer_info?: { payer_name?: { alternate_full_name?: unknown; given_name?: unknown; surname?: unknown } } | null;
};

export type PayPalBalance = { currency: string; total: string; available: string | null; withheld: string | null };

export type PayPalCredentials = { clientId: string; clientSecret: string };

/** Lets tests swap the network for canned responses. */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
let fetcher: FetchLike = (input, init) => fetch(input, init);
export function setPayPalFetchForTests(replacement: FetchLike | null): void {
  fetcher = replacement ?? ((input, init) => fetch(input, init));
}

export class PayPalError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The client ID and secret someone pasted, checked by their form. */
export function parseCredentials(input: { clientId?: unknown; clientSecret?: unknown }): PayPalCredentials {
  const clientId = typeof input.clientId === "string" ? input.clientId.trim() : "";
  const clientSecret = typeof input.clientSecret === "string" ? input.clientSecret.trim() : "";
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(clientId)) throw new ValidationError("Paste the client ID of your live PayPal REST app.");
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(clientSecret)) throw new ValidationError("Paste the secret of your live PayPal REST app.");
  return { clientId, clientSecret };
}

async function send(url: string, init: RequestInit): Promise<{ status: number; data: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new PayPalError(0, `PayPal couldn't be reached (${error instanceof Error ? error.message : "network error"}).`);
  }
  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    data = {};
  }
  return { status: response.status, data };
}

function messageOf(data: Record<string, unknown>, status: number): string {
  const text = [data.error_description, data.message, data.error].find((value) => typeof value === "string" && value.trim());
  return typeof text === "string" ? text : `PayPal answered ${status}.`;
}

/** An access token for the app (OAuth client credentials). */
export async function getToken(credentials: PayPalCredentials): Promise<string> {
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64");
  const { status, data } = await send(`${PAYPAL_API}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: "grant_type=client_credentials",
  });
  if (status === 401 || status === 400) {
    throw new PayPalError(
      401,
      `PayPal refused the client ID and secret: ${messageOf(data, status)}. Use the live app's client ID and secret (not sandbox).`,
    );
  }
  if (status < 200 || status > 299 || typeof data.access_token !== "string") throw new PayPalError(status, messageOf(data, status));
  return data.access_token;
}

async function get<T>(token: string, path: string, params: URLSearchParams): Promise<T> {
  const { status, data } = await send(`${PAYPAL_API}${path}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (status === 401 || status === 403) {
    throw new PayPalError(
      403,
      `PayPal won't let the app read this: ${messageOf(data, status)}. Turn on Transaction Search for the app in PayPal's developer dashboard.`,
    );
  }
  if (status < 200 || status > 299) throw new PayPalError(status, messageOf(data, status));
  return data as T;
}

/** PayPal's balance per currency (total, available and withheld). */
export async function fetchBalances(token: string): Promise<PayPalBalance[]> {
  const data = await get<{ balances?: Array<{ currency?: unknown; total_balance?: Money; available_balance?: Money; withheld_balance?: Money }> }>(
    token,
    "/v1/reporting/balances",
    new URLSearchParams(),
  );
  const amount = (money: Money | undefined) => (typeof money?.value === "string" && /^-?\d+(\.\d+)?$/.test(money.value) ? money.value : null);
  return (data.balances ?? [])
    .filter((entry) => typeof entry.currency === "string" && amount(entry.total_balance) !== null)
    .map((entry) => ({
      currency: (entry.currency as string).toUpperCase(),
      total: amount(entry.total_balance)!,
      available: amount(entry.available_balance),
      withheld: amount(entry.withheld_balance),
    }))
    .sort((left, right) => left.currency.localeCompare(right.currency));
}

/** Transactions in one currency from `start` to `end` (at most 31 days apart), every page. */
export async function listTransactions(token: string, currency: string, start: Date, end: Date): Promise<PayPalTransaction[]> {
  const all: PayPalTransaction[] = [];
  for (let page = 1; page <= 1000; page += 1) {
    const params = new URLSearchParams({
      start_date: start.toISOString().replace(/\.\d{3}Z$/, "Z"),
      end_date: end.toISOString().replace(/\.\d{3}Z$/, "Z"),
      transaction_currency: currency,
      fields: "all",
      page_size: "500",
      page: String(page),
    });
    const data = await get<{ transaction_details?: PayPalTransaction[]; total_pages?: number }>(token, "/v1/reporting/transactions", params);
    all.push(...(data.transaction_details ?? []));
    if (!data.total_pages || page >= data.total_pages) return all;
  }
  throw new PayPalError(0, "PayPal returned too many pages of transactions.");
}

/** Turns a PayPal failure into a message for the person who asked. */
export function payPalProblem(error: unknown): Error {
  if (error instanceof PayPalError)
    return error.status === 401 || error.status === 403 ? new ValidationError(error.message) : new UnavailableError(error.message);
  return error instanceof Error ? error : new Error(String(error));
}
