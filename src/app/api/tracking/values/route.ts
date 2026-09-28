import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { createTrackingValue } from "@/lib/tracking/service";

/** Adds a value to a tracking category, at the top or under `parentId` (example TC2). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const setup = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    createTrackingValue(tx, { categoryId: body.categoryId, name: body.name, parentId: body.parentId }),
  );
  return json(setup, { status: 201 });
});
