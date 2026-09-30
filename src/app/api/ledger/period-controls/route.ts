import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getPeriodControls, updatePeriodControls } from "@/lib/ledger/period-controls";

export const GET = route(async (request) => {
  const controls = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) =>
    getPeriodControls(tx),
  );
  return json({ controls });
});

/**
 * Moves the lock date (admins), e.g. the import's lock up to the conversion
 * date. Moving it earlier or clearing it (null) reopens periods and needs a
 * `reason`. Months are closed and reopened on Period close.
 */
export const PATCH = route(async (request) => {
  const body = await readJson(request);
  const input: Record<string, unknown> = {};
  for (const key of ["lockDate", "reason"]) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      input[key] = body[key];
    }
  }
  const controls = await withOrganisation(request, body.organisationId, "admin", (tx) => updatePeriodControls(tx, input));
  return json({ controls });
});
