import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { addReport, canSeeRestricted, listReports } from "@/lib/safety/reports";
import { canRecordSafety } from "@/lib/safety/records";
import { safetyPeople, safetyPeopleMap } from "@/lib/safety/people";

/**
 * GET: a farm's hazards spotted, near misses and incidents, newest first,
 * with their actions, photos and (for those allowed) restricted details;
 * and the people actions can be given to.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", async (tx) => ({
    reports: await listReports(tx, params.get("farmId"), { includeWithdrawn: params.get("includeWithdrawn") === "true" }),
    access: { canRecord: canRecordSafety(tx), canSeeRestricted: await canSeeRestricted(tx), isOwner: tx.actor.role === "owner" },
    people: canRecordSafety(tx) ? await safetyPeople(tx.organisationId) : [],
  }));
  return json(result);
});

/** Records a report (`farmId`, `type`, `title`, ..., optional restricted `details` and a first `action`). Bookkeepers and above. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "viewer", async (tx) => addReport(tx, body, body.action ? await safetyPeopleMap(tx.organisationId) : new Map()));
  return json(result, { status: 201 });
});
