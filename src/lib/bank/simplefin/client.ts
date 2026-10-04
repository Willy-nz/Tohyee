import { assertPublicMailHost } from "@/lib/analytics/mail-host";
import { UnavailableError, ValidationError } from "@/lib/errors";

/**
 * A small client for the SimpleFIN protocol (https://www.simplefin.org/protocol.html),
 * used with the organisation's own SimpleFIN Bridge account (SF1-SF10).
 *
 * - A setup token is a base64 claim URL; POSTing to it once returns the
 *   access URL, whose user name and password are the credentials.
 * - `GET {access}/accounts` returns accounts and their transactions, with
 *   `start-date` and `end-date` as Unix times. The Bridge allows at most 90
 *   days per request and 24 requests a day (its developer guide).
 *
 * Hosts must be on the internet (as IMAP hosts, decision 376). Every call has
 * a timeout, and none is made inside a database transaction.
 */
export const MAX_DAYS_PER_REQUEST = 90;

export type SimpleFinTransaction = {
  id?: unknown;
  posted?: unknown;
  amount?: unknown;
  description?: unknown;
  payee?: unknown;
  memo?: unknown;
  pending?: unknown;
};

export type SimpleFinAccount = {
  id: string;
  name: string;
  conn_id?: string;
  currency: string;
  balance?: string;
  "balance-date"?: number;
  org?: { name?: string } | null;
  transactions?: SimpleFinTransaction[];
};

export type SimpleFinProblem = { code: string | null; message: string; connectionId: string | null; accountId: string | null };

export type SimpleFinAccountSet = {
  accounts: SimpleFinAccount[];
  /** Connection names by connection id (protocol version 2). */
  connections: Record<string, string>;
  problems: SimpleFinProblem[];
};

/** Lets tests swap the network for canned responses. */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
let fetcher: FetchLike = (input, init) => fetch(input, init);
export function setSimpleFinFetchForTests(replacement: FetchLike | null): void {
  fetcher = replacement ?? ((input, init) => fetch(input, init));
}

export class SimpleFinError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function publicHost(url: URL): Promise<void> {
  if (url.protocol !== "https:") throw new ValidationError("SimpleFIN addresses must start with https://.");
  try {
    await assertPublicMailHost(url.hostname);
  } catch {
    throw new ValidationError(`${url.hostname} isn't a SimpleFIN server Tohyee can reach on the internet.`);
  }
}

/** The claim URL inside a setup token, checked. */
export function claimUrlFromToken(token: unknown): URL {
  if (typeof token !== "string" || !token.trim() || token.length > 2000) throw new ValidationError("Paste the setup token from SimpleFIN Bridge.");
  let decoded: string;
  try {
    decoded = Buffer.from(token.trim(), "base64").toString("utf8");
  } catch {
    decoded = "";
  }
  let url: URL;
  try {
    url = new URL(decoded);
  } catch {
    throw new ValidationError("That isn't a SimpleFIN setup token. Copy the whole token from SimpleFIN Bridge.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new ValidationError("That isn't a SimpleFIN setup token. Copy the whole token from SimpleFIN Bridge.");
  }
  return url;
}

/** Claims a setup token (it works once) and returns the access URL. */
export async function claimSetupToken(token: unknown): Promise<string> {
  const url = claimUrlFromToken(token);
  await publicHost(url);
  let response: Response;
  try {
    response = await fetcher(url.toString(), {
      method: "POST",
      headers: { "Content-Length": "0" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new SimpleFinError(0, `SimpleFIN couldn't be reached (${error instanceof Error ? error.message : "network error"}).`);
  }
  const text = (await response.text()).trim();
  if (response.status === 403) throw new ValidationError("This setup token has been used. Make a new one in SimpleFIN Bridge.");
  if (!response.ok) throw new SimpleFinError(response.status, `SimpleFIN answered ${response.status} when claiming the token.`);
  let access: URL;
  try {
    access = new URL(text);
  } catch {
    throw new SimpleFinError(response.status, "SimpleFIN didn't send back an access address.");
  }
  if (access.protocol !== "https:" || !access.username || !access.password) {
    throw new SimpleFinError(response.status, "SimpleFIN didn't send back an access address.");
  }
  await publicHost(access);
  return access.toString();
}

/** The host of an access URL, to show which Bridge a connection uses (never its credentials). */
export function accessHost(accessUrl: string): string {
  return new URL(accessUrl).hostname;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Accounts (and, unless `balancesOnly`, transactions from `start` up to
 * `end`, both Unix seconds) for the given SimpleFIN account ids, or all.
 * Pending transactions aren't asked for.
 */
export async function fetchAccounts(
  accessUrl: string,
  options: { start?: number; end?: number; accountIds?: string[]; balancesOnly?: boolean } = {},
): Promise<SimpleFinAccountSet> {
  const access = new URL(accessUrl);
  await publicHost(access);
  const credentials = Buffer.from(`${decodeURIComponent(access.username)}:${decodeURIComponent(access.password)}`).toString("base64");
  access.username = "";
  access.password = "";
  const base = access.toString().replace(/\/$/, "");
  const params = new URLSearchParams({ version: "2" });
  if (options.start !== undefined) params.set("start-date", String(options.start));
  if (options.end !== undefined) params.set("end-date", String(options.end));
  if (options.balancesOnly) params.set("balances-only", "1");
  for (const id of options.accountIds ?? []) params.append("account", id);
  let response: Response;
  try {
    response = await fetcher(`${base}/accounts?${params.toString()}`, {
      headers: { Authorization: `Basic ${credentials}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new SimpleFinError(0, `SimpleFIN couldn't be reached (${error instanceof Error ? error.message : "network error"}).`);
  }
  if (response.status === 403 || response.status === 401) {
    throw new SimpleFinError(
      response.status,
      "SimpleFIN refused Tohyee's access. It may have been revoked in SimpleFIN Bridge: disconnect and connect again with a new setup token.",
    );
  }
  if (response.status === 402) throw new SimpleFinError(402, "SimpleFIN answered 402 (payment required). Check the SimpleFIN Bridge account.");
  if (!response.ok) throw new SimpleFinError(response.status, `SimpleFIN answered ${response.status}.`);
  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new SimpleFinError(response.status, "SimpleFIN sent something Tohyee couldn't read.");
  }
  const accounts = (Array.isArray(data.accounts) ? data.accounts : []).filter(
    (account): account is SimpleFinAccount =>
      typeof account === "object" &&
      account !== null &&
      typeof (account as SimpleFinAccount).id === "string" &&
      typeof (account as SimpleFinAccount).currency === "string",
  );
  const connections: Record<string, string> = {};
  for (const connection of Array.isArray(data.connections) ? data.connections : []) {
    const id = text((connection as Record<string, unknown>)?.conn_id);
    const name = text((connection as Record<string, unknown>)?.name) ?? text((connection as Record<string, unknown>)?.org_name);
    if (id && name) connections[id] = name;
  }
  const problems: SimpleFinProblem[] = [];
  for (const entry of Array.isArray(data.errlist) ? data.errlist : []) {
    const item = entry as Record<string, unknown>;
    const message = text(item?.msg);
    if (message) problems.push({ code: text(item.code), message, connectionId: text(item.conn_id), accountId: text(item.account_id) });
  }
  // Version 1 servers send plain strings in `errors`.
  for (const entry of Array.isArray(data.errors) ? data.errors : []) {
    const message = text(entry);
    if (message) problems.push({ code: null, message, connectionId: null, accountId: null });
  }
  return { accounts, connections, problems };
}

/** Turns a SimpleFIN failure into a message for the person who asked. */
export function simpleFinProblem(error: unknown): Error {
  if (error instanceof SimpleFinError)
    return error.status === 401 || error.status === 403 ? new ValidationError(error.message) : new UnavailableError(error.message);
  return error instanceof Error ? error : new Error(String(error));
}
