import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { disposeFixedAsset, previewDisposal } from "@/lib/fixed-assets/runs";

type Context = { params: Promise<{ assetId: string }> };

/** GET: what disposing of it on `disposalDate` for `proceeds` would post, without posting (FA8). */
export const GET = route<Context>(async (request, context) => {
  const { assetId } = await context.params;
  const params = searchParams(request);
  const preview = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    previewDisposal(tx, assetId, {
      disposalDate: params.get("disposalDate"),
      proceeds: params.get("proceeds"),
      proceedsAccountCode: params.get("proceedsAccountCode"),
      gainLossAccountCode: params.get("gainLossAccountCode"),
      capitalGainAccountCode: params.get("capitalGainAccountCode"),
    }),
  );
  return json({ preview });
});

/** Sells or writes off the asset, posting its disposal journal (FA8-FA10). Bookkeepers and above. */
export const POST = route<Context>(async (request, context) => {
  const { assetId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    disposeFixedAsset(tx, assetId, { ...body, idempotencyKey: body.idempotencyKey, source: body.source }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
