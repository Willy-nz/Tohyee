import { NextResponse } from "next/server";
import { assertSameOrigin, authenticate, type AuthContext, requireOrganisationRole } from "@/lib/auth/guard";
import type { Role } from "@/lib/auth/roles";
import { type OrgRunner, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { HttpError, PayloadTooLargeError, ValidationError } from "@/lib/errors";
import type { Membership } from "@/lib/organisations/registry";
import { parseOrganisationId } from "@/lib/organisations/registry";
import { PAYROLL_MINIMUM_ROLE, requirePayrollAccess } from "@/lib/payroll/access";
import { addPersonNames, loadMemberNames } from "@/lib/people/names";
import { countRequest } from "@/lib/server-stats/counters";

export function json(data: unknown, init: { status?: number; headers?: HeadersInit } = {}) {
  return NextResponse.json(data, {
    status: init.status ?? 200,
    headers: { "cache-control": "no-store", ...(init.headers ?? {}) },
  });
}

/** Postgres error codes that mean "your request broke a rule", not "the server broke". */
const CLIENT_PG_ERRORS: Record<string, number> = {
  "23505": 409, // unique_violation
  "23503": 400, // foreign_key_violation
  "23514": 400, // check_violation (includes unbalanced journals)
  "23502": 400, // not_null_violation
  "22P02": 400, // invalid_text_representation
  "22007": 400, // invalid_datetime_format
  "22008": 400, // datetime_field_overflow
  P0001: 400, // raise_exception (append-only guard)
};

/** Turns any thrown error into a JSON response. Unexpected errors are logged, not leaked. */
export function errorResponse(error: unknown): NextResponse {
  if (error instanceof HttpError) {
    return json({ error: error.message, code: error.code }, { status: error.status });
  }
  const pgCode = (error as { code?: unknown })?.code;
  if (typeof pgCode === "string" && CLIENT_PG_ERRORS[pgCode]) {
    const message = error instanceof Error ? error.message : "The request was rejected by the database.";
    return json({ error: message, code: `db_${pgCode}` }, { status: CLIENT_PG_ERRORS[pgCode] });
  }
  console.error("[tohyee] unexpected error:", error);
  return json({ error: "Something went wrong on the server. Check the server logs.", code: "internal_error" }, { status: 500 });
}

type Handler<Context> = (request: Request, context: Context) => Promise<Response>;

/** Wraps a route handler so every error becomes a consistent JSON response. */
export function route<Context = unknown>(handler: Handler<Context>): Handler<Context> {
  return async (request, context) => {
    const started = performance.now();
    let response: Response;
    try {
      response = await handler(request, context);
    } catch (error) {
      response = errorResponse(error);
    }
    // For the server app's Stats page (decision 332): counts only.
    countRequest(performance.now() - started, response.status);
    return response;
  };
}

/** The most a JSON request body may be (#133); routes that carry a file (base64) or many rows pass a larger `maxBytes`. */
export const MAX_JSON_BYTES = 2 * 1024 * 1024;
/** For the import and statement routes: a 10 MB file as base64 (about 13.4 MB) and its form fields, or 5,000 parsed rows. */
export const MAX_FILE_JSON_BYTES = 20 * 1024 * 1024;

/** The body's text, stopping as soon as it's bigger than `maxBytes`, so a huge body can't use up memory first (#133). */
async function readLimitedText(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  const tooLarge = () => new PayloadTooLargeError(`The request is too large (at most ${Math.round(maxBytes / (1024 * 1024))} MB).`);
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readJson(request: Request, options: { maxBytes?: number } = {}): Promise<Record<string, unknown>> {
  const text = await readLimitedText(request, options.maxBytes ?? MAX_JSON_BYTES);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ValidationError("The request body must be JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("The request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

export function searchParams(request: Request): URLSearchParams {
  return new URL(request.url).searchParams;
}

/** Signed-in user, with the cross-site check for anything that changes data. */
export async function requireAuth(request: Request): Promise<AuthContext> {
  assertSameOrigin(request);
  return authenticate(request);
}

/**
 * Authenticates, checks the caller's role in the organisation, then runs
 * `work` inside one transaction on that organisation's own database. After
 * the transaction, every person's email in the result gets their name beside
 * it (`createdByEmail` -> `createdByName`), from one lookup of the
 * organisation's members.
 */
export async function withOrganisation<T>(
  request: Request,
  organisationIdInput: unknown,
  minimumRole: Role,
  work: (tx: OrgTx, context: { auth: AuthContext; membership: Membership }) => Promise<T>,
): Promise<T> {
  const auth = await requireAuth(request);
  const organisationId = parseOrganisationId(organisationIdInput);
  const membership = await requireOrganisationRole(auth, organisationId, minimumRole);
  const people = await loadMemberNames(membership.organisation.id);
  const result = await withOrganisationTransaction(
    membership.organisation,
    { userId: auth.user.id, email: auth.user.email },
    (tx) => work(tx, { auth, membership }),
    { people },
  );
  return addPersonNames(result, people);
}

/**
 * `withOrganisation` for payroll: the bookkeeper role or higher and payroll
 * access (examples PE9-PE12). Use it for every payroll route that reads or
 * changes pay details, allocations, rate history, IRD numbers, bank
 * accounts, pay runs or payroll reports.
 */
export async function withPayrollAccess<T>(
  request: Request,
  organisationIdInput: unknown,
  work: (tx: OrgTx, context: { auth: AuthContext; membership: Membership }) => Promise<T>,
): Promise<T> {
  return withOrganisation(request, organisationIdInput, PAYROLL_MINIMUM_ROLE, async (tx, context) => {
    await requirePayrollAccess(tx);
    return work(tx, context);
  });
}

/**
 * Like `withOrganisation`, but for bulk commands: authenticates and checks
 * the role once, then hands `work` a runner that opens a new transaction on
 * the organisation's database each time it's called, so one item failing
 * doesn't undo the others.
 */
export async function withOrganisationRunner<T>(
  request: Request,
  organisationIdInput: unknown,
  minimumRole: Role,
  work: (run: OrgRunner) => Promise<T>,
): Promise<T> {
  const auth = await requireAuth(request);
  const organisationId = parseOrganisationId(organisationIdInput);
  const membership = await requireOrganisationRole(auth, organisationId, minimumRole);
  const people = await loadMemberNames(membership.organisation.id);
  const actor = { userId: auth.user.id, email: auth.user.email };
  const run: OrgRunner = (each) => withOrganisationTransaction(membership.organisation, actor, each, { people });
  return addPersonNames(await work(run), people);
}
