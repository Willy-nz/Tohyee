import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createFixedAsset, listFixedAssets } from "@/lib/fixed-assets/service";

/** GET: fixed assets by number; `status` is registered (the default), disposed, archived or all. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const assets = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listFixedAssets(tx, { status: params.get("status") }));
  return json({ assets });
});

/** Registers an asset, optionally from a bill line (FA2). Posts nothing. Bookkeepers and above. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    createFixedAsset(tx, { ...body, idempotencyKey: body.idempotencyKey, source: body.source }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
