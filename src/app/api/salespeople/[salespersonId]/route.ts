import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { updateSalesperson } from "@/lib/salespeople/service";

type Context = { params: Promise<{ salespersonId: string }> };

/** Renames a salesperson, changes their email, or archives or restores them (`isActive`, example SR6). */
export const PATCH = route<Context>(async (request, context) => {
  const { salespersonId } = await context.params;
  const body = await readJson(request);
  const setup = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    updateSalesperson(tx, salespersonId, { name: body.name, email: body.email, isActive: body.isActive }),
  );
  return json(setup);
});
