import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { addHolding, coopShareSchedule } from "@/lib/farming/coop-shares";

/** The co-op share register for a financial year (CSR2-CSR7). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const schedule = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => coopShareSchedule(tx, { yearEnd: params.get("yearEnd") }));
  return json(schedule);
});

/** Adds a co-op and share class (CSR1). Bookkeepers. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const holding = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    addHolding(tx, { coopName: body.coopName, shareClass: body.shareClass, notes: body.notes }),
  );
  return json({ holding }, { status: 201 });
});
