import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { previewAgeing, setAgeingSplit } from "@/lib/livestock/movements";

/** GET: the ageing at the start of the year ending `yearEnd` (LV1). It's worked out, not run. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const ageing = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => previewAgeing(tx, { yearEnd: params.get("yearEnd") }));
  return json({ ageing });
});

/** Says how many mixed-age ewes turn rising five at the start of that year. Bookkeepers and above. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const ageing = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    setAgeingSplit(tx, { yearEnd: body.yearEnd, kind: body.kind, classCode: body.classCode, head: body.head }),
  );
  return json({ ageing });
});
