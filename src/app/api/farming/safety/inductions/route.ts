import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { addInduction, listInductions, listSignoffs, listSiteLinks, onSite } from "@/lib/safety/inductions";
import { canRecordSafety } from "@/lib/safety/records";

/** GET: a farm's inductions, who has signed (and who must sign again), who's on site, and its sign-in links. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const farmId = params.get("farmId");
  const result = await withFarmWork(request, params.get("organisationId"), "read", async (tx) => ({
    inductions: await listInductions(tx, farmId),
    signoffs: await listSignoffs(tx, farmId),
    onSite: await onSite(tx, farmId),
    links: canRecordSafety(tx) ? await listSiteLinks(tx, farmId) : [],
    canRecord: canRecordSafety(tx),
  }));
  return json(result);
});

/** Adds an induction (`farmId`, or none to share it across farms; `title`, `audiences`, `sections`). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const induction = await withFarmWork(request, body.organisationId, "read", (tx) => addInduction(tx, body));
  return json({ induction }, { status: 201 });
});
