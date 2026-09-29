import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { ValidationError } from "@/lib/errors";
import { archiveFixedAssetType } from "@/lib/fixed-assets/service";

type Context = { params: Promise<{ typeId: string }> };

/** Archives an asset type (`archived: true`) or brings it back (`archived: false`). Admins. */
export const POST = route<Context>(async (request, context) => {
  const { typeId } = await context.params;
  const body = await readJson(request);
  if (typeof body.archived !== "boolean") throw new ValidationError("archived must be true or false.");
  const archived = body.archived;
  const type = await withOrganisation(request, body.organisationId, "admin", (tx) => archiveFixedAssetType(tx, typeId, { archived }));
  return json({ type });
});
