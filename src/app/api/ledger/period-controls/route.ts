import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getPeriodControls, updatePeriodControls } from "@/lib/ledger/period-controls";

export const GET = route(async (request) => {
  const controls = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) =>
    getPeriodControls(tx),
  );
  return json({ controls });
});

/** Lock date and unlock window. Admins only. Send null to clear a date. */
export const PATCH = route(async (request) => {
  const body = await readJson(request);
  const input: Record<string, unknown> = {};
  for (const key of ["lockDate", "unlockStart", "unlockEnd"]) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      input[key] = body[key];
    }
  }
  const controls = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    updatePeriodControls(tx, input),
  );
  return json({ controls });
});
