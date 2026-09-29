import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createFixedAssetType, listFixedAssetTypes } from "@/lib/fixed-assets/service";

/** GET: asset types; `includeArchived=true` shows archived ones too. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const types = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listFixedAssetTypes(tx, { includeArchived: params.get("includeArchived") }),
  );
  return json({ types });
});

/** Adds an asset type: its accounts and default method and rate (FA1). Admins. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    createFixedAssetType(tx, { ...body, idempotencyKey: body.idempotencyKey, source: body.source }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
