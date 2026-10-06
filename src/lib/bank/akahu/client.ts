import { UnavailableError, ValidationError } from "@/lib/errors";
import { dec, parseDecimalInput, toFixedString } from "@/lib/money/decimal";

/**
 * A small client for Akahu's API (NZ open finance), used for bank feeds.
 * https://developers.akahu.nz. Requests carry the organisation's personal app
 * App ID token (X-Akahu-Id) and user token (Authorization: Bearer). Every call
 * has a timeout, and none is made inside a database transaction.
 */
export const AKAHU_API = "https://api.akahu.io/v1";

export type AkahuCredentials = { appToken: string; userToken: string };

export type AkahuAccount = {
  _id: string;
  name: string;
  formatted_account?: string | null;
  type?: string;
  status?: string;
  balance?: { current?: number; available?: number; currency?: string } | null;
  connection?: { _id?: string; name?: string } | null;
  refreshed?: { balance?: string; transactions?: string } | null;
};

export type AkahuTransaction = {
  _id: string;
  _account: string;
  date: string;
  description: string;
  amount: number;
  balance?: number | null;
  type?: string;
  merchant?: { name?: string } | null;
  meta?: { particulars?: string | null; code?: string | null; reference?: string | null; other_account?: string | null } | null;
};

/**
 * Akahu sends money as JSON numbers. Each is read through its shortest string
 * form (so 0.1 stays "0.1") and must be whole cents: anything finer, like
 * 1.005, is refused rather than rounded (issue #147).
 */
export function akahuMoney(value: number, fieldName: string): string {
  return toFixedString(dec(parseDecimalInput(value, fieldName, { maxScale: 2, allowNegative: true, allowZero: true })), 2);
}

/** Lets tests swap the network for canned responses. */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
let fetcher: FetchLike = (input, init) => fetch(input, init);
export function setAkahuFetchForTests(replacement: FetchLike | null): void {
  fetcher = replacement ?? ((input, init) => fetch(input, init));
}

export class AkahuError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(
  path: string,
  options: { credentials?: AkahuCredentials; appToken?: string; method?: "GET" | "POST"; body?: unknown },
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const appToken = options.credentials?.appToken ?? options.appToken;
  if (appToken) headers["X-Akahu-Id"] = appToken;
  if (options.credentials?.userToken) headers.Authorization = `Bearer ${options.credentials.userToken}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetcher(`${AKAHU_API}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new AkahuError(0, `Akahu couldn't be reached (${error instanceof Error ? error.message : "network error"}).`);
  }
  const text = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    data = {};
  }
  if (!response.ok || data.success === false) {
    const message = typeof data.message === "string" ? data.message : `Akahu answered ${response.status}.`;
    const refused = response.status === 401 || response.status === 403;
    throw new AkahuError(response.status, refused ? `Akahu refused the tokens: ${message}${/[.!?]$/.test(message) ? "" : "."} Check the App ID token and user token.` : message);
  }
  return data as T;
}

/** The accounts the user has shared with the app. */
export async function listAkahuAccounts(credentials: AkahuCredentials): Promise<AkahuAccount[]> {
  const data = await call<{ items?: AkahuAccount[] }>("/accounts", { credentials });
  return data.items ?? [];
}

/**
 * Settled transactions for one account from `start` (exclusive) to `end`
 * (inclusive), following Akahu's cursor through every page. Pending
 * transactions aren't included (they come back once they settle).
 */
export async function listAkahuTransactions(
  credentials: AkahuCredentials,
  accountId: string,
  start: string,
  end?: string,
): Promise<AkahuTransaction[]> {
  const all: AkahuTransaction[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 1000; page += 1) {
    const params = new URLSearchParams({ start });
    if (end) params.set("end", end);
    if (cursor) params.set("cursor", cursor);
    const data: { items?: AkahuTransaction[]; cursor?: { next?: string | null } } = await call(
      `/accounts/${encodeURIComponent(accountId)}/transactions?${params.toString()}`,
      { credentials },
    );
    all.push(...(data.items ?? []));
    cursor = data.cursor?.next ?? null;
    if (!cursor) return all;
  }
  throw new AkahuError(0, "Akahu returned too many pages of transactions.");
}

/** Asks Akahu to refresh an account from the bank. Akahu may skip it if it refreshed recently. */
export async function refreshAkahuAccount(credentials: AkahuCredentials, accountId: string): Promise<void> {
  try {
    await call(`/refresh/${encodeURIComponent(accountId)}`, { credentials, method: "POST" });
  } catch {
    // A refresh is a request, not a promise; the sync reads whatever Akahu has.
  }
}

/** Turns an Akahu failure into a message for the person who asked. */
export function akahuProblem(error: unknown): Error {
  if (error instanceof AkahuError) {
    return error.status === 401 || error.status === 403
      ? new ValidationError(error.message)
      : new UnavailableError(error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}
