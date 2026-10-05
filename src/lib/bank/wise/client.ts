import { UnavailableError, ValidationError } from "@/lib/errors";

/**
 * A small read-only client for Wise's API (https://docs.wise.com), used with
 * the organisation's own business account and a personal API token
 * (WI1-WI10). It reads profiles, balances and balance statements only. Wise
 * allows statements with a personal token for accounts based in the US,
 * Canada, Australia, New Zealand, Singapore and Malaysia; at most 469 days
 * per request. Every call has a timeout, and none is made inside a database
 * transaction. The version in the address is the one Wise documented on
 * 5 Oct 2026.
 */
export const WISE_API = "https://api.wise.com/2026Q4";
export const MAX_DAYS_PER_REQUEST = 469;

type Money = { value?: unknown; currency?: unknown };

export type WiseProfile = { id: number; type: string; name: string | null };
export type WiseBalance = { id: number; currency: string; amount: string | null };

export type WiseStatementTransaction = {
  type?: unknown;
  date?: unknown;
  amount?: Money;
  totalFees?: Money;
  details?: {
    type?: unknown;
    description?: unknown;
    senderName?: unknown;
    paymentReference?: unknown;
    merchant?: { name?: unknown } | null;
    sourceAmount?: Money;
    targetAmount?: Money;
  } | null;
  exchangeDetails?: { forAmount?: Money } | null;
  runningBalance?: Money;
  referenceNumber?: unknown;
};

export type WiseStatement = { transactions: WiseStatementTransaction[]; endBalance: string | null };

/** Lets tests swap the network for canned responses. */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
let fetcher: FetchLike = (input, init) => fetch(input, init);
export function setWiseFetchForTests(replacement: FetchLike | null): void {
  fetcher = replacement ?? ((input, init) => fetch(input, init));
}

export class WiseError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The token someone pasted, checked by its form. */
export function parseToken(input: unknown): string {
  const token = typeof input === "string" ? input.trim() : "";
  if (!/^[A-Za-z0-9._-]{20,2000}$/.test(token)) throw new ValidationError("Paste the personal API token from your Wise business account.");
  return token;
}

/** A Wise amount (a JSON number, or a string) as a decimal string, or null. */
export function money(value: unknown): string | null {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  return /^-?\d+(\.\d+)?$/.test(text) ? text : null;
}

async function get<T>(token: string, path: string, params?: URLSearchParams): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(`${WISE_API}${path}${params ? `?${params.toString()}` : ""}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new WiseError(0, `Wise couldn't be reached (${error instanceof Error ? error.message : "network error"}).`);
  }
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const body = (data ?? {}) as { message?: unknown; errors?: Array<{ message?: unknown }> };
    const detail = typeof body.message === "string" ? body.message : typeof body.errors?.[0]?.message === "string" ? body.errors[0].message : null;
    if (response.status === 401)
      throw new WiseError(401, `Wise refused the token${detail ? `: ${detail}` : ""}. Make a new personal API token in Wise.`);
    if (response.status === 403) {
      throw new WiseError(
        403,
        `Wise won't let this token read it${detail ? ` (${detail})` : ""}. Wise allows balance statements with a personal token only for accounts based in the US, Canada, Australia, New Zealand, Singapore or Malaysia.`,
      );
    }
    if (response.status === 429) throw new WiseError(429, "Wise asked Tohyee to slow down. The next sync carries on.");
    throw new WiseError(response.status, detail ?? `Wise answered ${response.status}.`);
  }
  return data as T;
}

/** The token's profiles (business first). */
export async function listProfiles(token: string): Promise<WiseProfile[]> {
  const data = await get<Array<{ id?: unknown; type?: unknown; businessName?: unknown; fullName?: unknown }>>(token, "/profiles");
  return (Array.isArray(data) ? data : [])
    .filter((profile) => typeof profile.id === "number" && typeof profile.type === "string")
    .map((profile) => ({
      id: profile.id as number,
      type: profile.type as string,
      name: typeof profile.businessName === "string" ? profile.businessName : typeof profile.fullName === "string" ? profile.fullName : null,
    }))
    .sort((left, right) => (left.type === right.type ? 0 : left.type === "BUSINESS" ? -1 : 1));
}

/** A profile's standard (not savings) balances. */
export async function listBalances(token: string, profileId: number): Promise<WiseBalance[]> {
  const data = await get<Array<{ id?: unknown; currency?: unknown; amount?: Money }>>(
    token,
    `/profiles/${profileId}/balances`,
    new URLSearchParams({ types: "STANDARD" }),
  );
  return (Array.isArray(data) ? data : [])
    .filter((balance) => typeof balance.id === "number" && typeof balance.currency === "string")
    .map((balance) => ({ id: balance.id as number, currency: (balance.currency as string).toUpperCase(), amount: money(balance.amount?.value) }))
    .sort((left, right) => left.currency.localeCompare(right.currency));
}

/** One balance's statement from `start` to `end` (at most 469 days apart), one line per transaction. */
export async function fetchStatement(
  token: string,
  profileId: number,
  balanceId: number,
  currency: string,
  start: Date,
  end: Date,
): Promise<WiseStatement> {
  const data = await get<{ transactions?: WiseStatementTransaction[]; endOfStatementBalance?: Money }>(
    token,
    `/profiles/${profileId}/balance-statements/${balanceId}/statement.json`,
    new URLSearchParams({ currency, intervalStart: start.toISOString(), intervalEnd: end.toISOString(), type: "COMPACT" }),
  );
  return { transactions: Array.isArray(data?.transactions) ? data.transactions : [], endBalance: money(data?.endOfStatementBalance?.value) };
}

/** Turns a Wise failure into a message for the person who asked. */
export function wiseProblem(error: unknown): Error {
  if (error instanceof WiseError)
    return error.status === 401 || error.status === 403 ? new ValidationError(error.message) : new UnavailableError(error.message);
  return error instanceof Error ? error : new Error(String(error));
}
