import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { optionalFormFile, readUploadForm } from "@/lib/api/upload";
import { createOverheadRule, listOverheadRules } from "@/lib/rd/overheads";

/** GET: every overhead rule, replaced ones included (viewers and above). */
export const GET = route(async (request) => {
  const rules = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listOverheadRules(tx));
  return json({ rules });
});

/**
 * POST (multipart form): sets an overhead rule with its workings as `file`
 * (bookkeepers and above; RD10, RD34, decision 46). Fields: `organisationId`,
 * `idempotencyKey`, `accountId`, `activityId`, `percentage`, `basis`,
 * `basisDetail`, `effectiveFrom`, `effectiveTo`.
 */
export const POST = route(async (request) => {
  const form = await readUploadForm(request);
  const workings = await optionalFormFile(form);
  const field = (name: string) => form.get(name) ?? undefined;
  const result = await withOrganisation(request, form.get("organisationId"), "bookkeeper", (tx) =>
    createOverheadRule(
      tx,
      {
        idempotencyKey: field("idempotencyKey"),
        accountId: field("accountId"),
        accountCode: field("accountCode"),
        activityId: field("activityId"),
        percentage: field("percentage"),
        basis: field("basis"),
        basisDetail: field("basisDetail"),
        effectiveFrom: field("effectiveFrom"),
        effectiveTo: field("effectiveTo") || undefined,
      },
      workings,
    ),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
