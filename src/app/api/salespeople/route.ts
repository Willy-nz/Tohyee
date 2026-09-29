import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createSalesperson, listSalespeople } from "@/lib/salespeople/service";

/** GET: whether advanced features are on, and every salesperson (examples SR1-SR8). */
export const GET = route(async (request) => {
  const setup = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listSalespeople(tx));
  return json(setup);
});

/** Adds a salesperson (example SR1). Admins only. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const setup = await withOrganisation(request, body.organisationId, "admin", (tx) => createSalesperson(tx, { name: body.name, email: body.email }));
  return json(setup, { status: 201 });
});
