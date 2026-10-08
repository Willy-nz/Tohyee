import { UnavailableError, ValidationError } from "@/lib/errors";

/**
 * A small client for GoCardless's API (https://docs.gocardless.com/docs/api-reference,
 * checked 8 Oct 2026), used with the organisation's own access token for
 * direct debit (stage 10, examples GC1-GC10). It asks for authorities through
 * billing requests and GoCardless's own page, creates, cancels and retries
 * payments, and reads payments, mandates and payouts. Every call has a
 * timeout, and none is made inside a database transaction.
 */
export type GoCardlessEnvironment = "live" | "sandbox";

const BASE: Record<GoCardlessEnvironment, string> = {
  live: "https://api.gocardless.com",
  sandbox: "https://api-sandbox.gocardless.com",
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
let fetcher: FetchLike = (input, init) => fetch(input, init);
/** Lets tests swap the network for a pretend GoCardless. */
export function setGoCardlessFetchForTests(replacement: FetchLike | null): void {
  fetcher = replacement ?? ((input, init) => fetch(input, init));
}

export class GoCardlessError extends Error {
  readonly status: number;
  readonly reason: string | null;
  readonly conflictingId: string | null;
  constructor(status: number, message: string, reason: string | null = null, conflictingId: string | null = null) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.conflictingId = conflictingId;
  }
}

export type GoCardlessCredentials = { token: string; environment: GoCardlessEnvironment };

/** An access token, checked by its form only (GoCardless checks it properly on the first call). */
export function parseAccessToken(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) throw new ValidationError("Paste the access token from your GoCardless dashboard (Developers, Create, Access token).");
  const token = input.trim();
  if (!/^[A-Za-z0-9_-]{20,300}$/.test(token)) throw new ValidationError("That doesn't look like a GoCardless access token.");
  return token;
}

async function call<T>(
  credentials: GoCardlessCredentials,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.token}`,
    "GoCardless-Version": "2015-07-06",
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let response: Response;
  try {
    response = await fetcher(`${BASE[credentials.environment]}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new GoCardlessError(0, `GoCardless couldn't be reached (${error instanceof Error ? error.message : "network error"}).`);
  }
  const text = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    data = {};
  }
  if (!response.ok) {
    const error = (data.error ?? {}) as { message?: unknown; errors?: Array<{ reason?: unknown; message?: unknown; links?: { conflicting_resource_id?: unknown } }> };
    const first = error.errors?.[0];
    const message = typeof error.message === "string" ? error.message : `GoCardless answered ${response.status}.`;
    const reason = typeof first?.reason === "string" ? first.reason : null;
    const conflicting = typeof first?.links?.conflicting_resource_id === "string" ? first.links.conflicting_resource_id : null;
    throw new GoCardlessError(
      response.status,
      response.status === 401 ? "GoCardless refused the access token. Check it in Settings › Online payments." : `GoCardless: ${message}`,
      reason,
      conflicting,
    );
  }
  return data as T;
}

/** Turns a GoCardless failure into a message for the person who asked. */
export function goCardlessProblem(error: unknown): Error {
  if (error instanceof GoCardlessError) return error.status === 0 || error.status >= 500 ? new UnavailableError(error.message) : new ValidationError(error.message);
  return error instanceof Error ? error : new Error(String(error));
}

export type GcCreditor = { id: string; name: string };
export type GcBillingRequest = { id: string; status: string; links?: { mandate_request_mandate?: string | null; customer?: string | null } };
export type GcFlow = { id: string; authorisation_url: string; expires_at: string | null };
export type GcMandate = { id: string; status: string; next_possible_charge_date: string | null };
export type GcPayment = {
  id: string;
  amount: number;
  currency: string;
  charge_date: string | null;
  status: string;
  links?: { mandate?: string };
};
export type GcPayout = { id: string; amount: number; deducted_fees: number; currency: string; status: string; arrival_date: string | null; reference: string | null; payout_type?: string; created_at: string };

/** The creditor the token belongs to (GC1): checks the token and gives its name. */
export async function getCreditor(credentials: GoCardlessCredentials): Promise<GcCreditor> {
  const data = await call<{ creditors?: GcCreditor[] }>(credentials, "GET", "/creditors?limit=1");
  const creditor = data.creditors?.[0];
  if (!creditor) throw new GoCardlessError(400, "GoCardless has no creditor for this access token.");
  return creditor;
}

/** Asks for a BECS NZ direct debit authority (GC2): a billing request, then GoCardless's page for the customer. */
export async function startAuthority(
  credentials: GoCardlessCredentials,
  input: { contactId: string; name: string; email: string | null; idempotencyKey: string },
): Promise<{ billingRequest: GcBillingRequest; flow: GcFlow }> {
  const created = await call<{ billing_requests: GcBillingRequest }>(
    credentials,
    "POST",
    "/billing_requests",
    { billing_requests: { mandate_request: { currency: "NZD", scheme: "becs_nz" }, metadata: { tohyee_contact: input.contactId } } },
    input.idempotencyKey,
  );
  const flow = await call<{ billing_request_flows: GcFlow }>(credentials, "POST", "/billing_request_flows", {
    billing_request_flows: {
      links: { billing_request: created.billing_requests.id },
      prefilled_customer: { company_name: input.name.slice(0, 100), ...(input.email ? { email: input.email } : {}) },
    },
  });
  return { billingRequest: created.billing_requests, flow: flow.billing_request_flows };
}

export async function getBillingRequest(credentials: GoCardlessCredentials, id: string): Promise<GcBillingRequest> {
  return (await call<{ billing_requests: GcBillingRequest }>(credentials, "GET", `/billing_requests/${encodeURIComponent(id)}`)).billing_requests;
}

export async function getMandate(credentials: GoCardlessCredentials, id: string): Promise<GcMandate> {
  return (await call<{ mandates: GcMandate }>(credentials, "GET", `/mandates/${encodeURIComponent(id)}`)).mandates;
}

/** A payment from a mandate (GC3). Amount in cents; a charge date of null means as soon as possible. */
export async function createPayment(
  credentials: GoCardlessCredentials,
  input: { amountCents: number; chargeDate: string | null; mandateId: string; description: string; invoiceId: string; idempotencyKey: string },
): Promise<GcPayment> {
  try {
    return (
      await call<{ payments: GcPayment }>(
        credentials,
        "POST",
        "/payments",
        {
          payments: {
            amount: input.amountCents,
            currency: "NZD",
            ...(input.chargeDate ? { charge_date: input.chargeDate } : {}),
            description: input.description.slice(0, 100),
            metadata: { tohyee_invoice: input.invoiceId },
            links: { mandate: input.mandateId },
          },
        },
        input.idempotencyKey,
      )
    ).payments;
  } catch (error) {
    // Asked before (a retry after a timeout, GC10): the payment it made then.
    if (error instanceof GoCardlessError && error.reason === "idempotent_creation_conflict" && error.conflictingId) {
      return getPayment(credentials, error.conflictingId);
    }
    throw error;
  }
}

export async function getPayment(credentials: GoCardlessCredentials, id: string): Promise<GcPayment> {
  return (await call<{ payments: GcPayment }>(credentials, "GET", `/payments/${encodeURIComponent(id)}`)).payments;
}

/** Cancels a payment not yet sent to the banks (GC9); GoCardless refuses once it has been. */
export async function cancelPayment(credentials: GoCardlessCredentials, id: string): Promise<GcPayment> {
  return (await call<{ payments: GcPayment }>(credentials, "POST", `/payments/${encodeURIComponent(id)}/actions/cancel`, { data: {} })).payments;
}

/** Retries a failed payment (GC6, "Try again"; GoCardless allows three). */
export async function retryPayment(credentials: GoCardlessCredentials, id: string): Promise<GcPayment> {
  return (await call<{ payments: GcPayment }>(credentials, "POST", `/payments/${encodeURIComponent(id)}/actions/retry`, { data: {} })).payments;
}

/** NZD payouts paid since a time, oldest first (GC5). */
export async function listPaidPayouts(credentials: GoCardlessCredentials, since: string): Promise<GcPayout[]> {
  const payouts: GcPayout[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({ status: "paid", currency: "NZD", "created_at[gte]": since, limit: "100" });
    if (after) query.set("after", after);
    const data = await call<{ payouts?: GcPayout[]; meta?: { cursors?: { after?: string | null } } }>(credentials, "GET", `/payouts?${query.toString()}`);
    payouts.push(...(data.payouts ?? []));
    after = data.meta?.cursors?.after ?? null;
    if (!after) break;
  }
  return payouts.sort((a, b) => a.created_at.localeCompare(b.created_at));
}
