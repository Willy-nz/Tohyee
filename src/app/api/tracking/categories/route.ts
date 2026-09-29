import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { createTrackingCategory } from "@/lib/tracking/service";

/** Adds a custom segment: a tracking category of the organisation's own (example CS1). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const setup = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    createTrackingCategory(tx, { name: body.name, isRequired: body.isRequired }),
  );
  return json(setup, { status: 201 });
});
