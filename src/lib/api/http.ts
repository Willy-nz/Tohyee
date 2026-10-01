import { NextResponse } from "next/server";
import { assertSameOrigin, authenticate, type AuthContext, requireOrganisationRole } from "@/lib/auth/guard";
import type { Role } from "@/lib/auth/roles";
import { type OrgRunner, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { HttpError, ValidationError } from "@/lib/errors";
import type { Membership } from "@/lib/organisations/registry";
import { parseOrganisationId } from "@/lib/organisations/registry";
import { PAYROLL_MINIMUM_ROLE, requirePayrollAccess } from "@/lib/payroll/access";
import { addPersonNames, loadMemberNames } from "@/lib/people/names";

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
    try {
      return await handler(request, context);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
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
 * access (examples PR9-PR12). Use it for every payroll route that reads or
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
