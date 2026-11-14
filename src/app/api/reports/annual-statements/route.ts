import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { saveAnnualDocument } from "@/lib/reports/annual-document";
import { buildFinancialStatements } from "@/lib/reports/financial-statements";

/**
 * GET: the year's annual financial statements as the report shows them (FS4-FS13): the same pages and lines as the PDF.
 * `draftId` shows that saved set's words (and the year it's for, when `yearEnd` is left out); otherwise the year's final set,
 * its latest draft, or the defaults (FS16). Viewers and above.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    buildFinancialStatements(tx, { yearEnd: params.get("yearEnd") ?? undefined, draftId: params.get("draftId") ?? undefined }),
  );
  return json(report);
});

/**
 * PUT: saves a set's cover, compilation report and page headings (`yearEnd`, `status` "draft" or "final", `texts`, FS13).
 * With `draftId` it changes that set; without it, or with `asNew`, it starts another set for the year; `title` names it (FS16). Bookkeepers.
 */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const saved = await withOrganisation(request, body.organisationId, "bookkeeper", async (tx) =>
    saveAnnualDocument(tx, {
      yearEnd: body.yearEnd,
      status: body.status,
      texts: body.texts,
      draftId: body.draftId,
      asNew: body.asNew,
      title: body.title,
      name: (await getOrganisationSettings(tx)).displayName,
    }),
  );
  return json(saved);
});
