import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { ValidationError } from "@/lib/errors";
import { closePeriod, listPeriods, reopenPeriod } from "@/lib/ledger/period-close";

/** The financial years and months with their status, and the close and reopen history (PC1). Viewers. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const periods = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listPeriods(tx, {}));
  return json({ periods });
});

/**
 * `action: "close"` closes the month ending `periodEnd` (bookkeepers when
 * every check passes; owners and admins with `acknowledgeWarnings` when some
 * don't). `action: "reopen"` reopens it and every later month (owners and
 * admins, with a `reason`). PC10-PC12.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  if (body.action !== "close" && body.action !== "reopen") {
    throw new ValidationError('action must be "close" or "reopen".');
  }
  const result = await withOrganisation(request, body.organisationId, body.action === "close" ? "bookkeeper" : "admin", (tx, { membership }) =>
    body.action === "close"
      ? closePeriod(tx, membership.role, { periodEnd: body.periodEnd, acknowledgeWarnings: body.acknowledgeWarnings })
      : reopenPeriod(tx, membership.role, { periodEnd: body.periodEnd, reason: body.reason }),
  );
  return json({ result });
});
