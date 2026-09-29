import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { createPriceLevel } from "@/lib/customers/service";

/** Adds a price level (example RC7). Admins only. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const setup = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    createPriceLevel(tx, { name: body.name, markupPercent: body.markupPercent }),
  );
  return json(setup, { status: 201 });
});
