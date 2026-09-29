import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { createPaymentTerm } from "@/lib/customers/service";

/** Adds a payment term (example RC1). Admins only. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const setup = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    createPaymentTerm(tx, { name: body.name, kind: body.kind, days: body.days }),
  );
  return json(setup, { status: 201 });
});
