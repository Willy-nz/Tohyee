import { json, route, withOrganisation } from "@/lib/api/http";
import { optionalFormFile, readUploadForm } from "@/lib/api/upload";
import { changeOverheadRule } from "@/lib/rd/overheads";

type Context = { params: Promise<{ ruleId: string }> };

/**
 * POST (multipart form): changes a rule by adding one that replaces it, with
 * new workings as `file` (bookkeepers and above; RD35, decision 58). Fields:
 * `organisationId`, `idempotencyKey`, `percentage`, `basis`, `basisDetail`,
 * `effectiveFrom`.
 */
export const POST = route<Context>(async (request, context) => {
  const { ruleId } = await context.params;
  const form = await readUploadForm(request);
  const workings = await optionalFormFile(form);
  const field = (name: string) => form.get(name) ?? undefined;
  const result = await withOrganisation(request, form.get("organisationId"), "bookkeeper", (tx) =>
    changeOverheadRule(
      tx,
      ruleId,
      {
        idempotencyKey: field("idempotencyKey"),
        percentage: field("percentage"),
        basis: field("basis"),
        basisDetail: field("basisDetail"),
        effectiveFrom: field("effectiveFrom"),
      },
      workings,
    ),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
