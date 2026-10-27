import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { addReport, canSeeRestricted, farmActionsWithoutReport, listReports } from "@/lib/safety/reports";
import { canRecordSafety, canReportSafety } from "@/lib/safety/records";
import { safetyPeople, safetyPeopleMap } from "@/lib/safety/people";

/**
 * GET: a farm's hazards spotted, near misses and incidents, newest first,
 * with their actions, photos and (for those allowed) restricted details;
 * the farm's open actions that aren't on a report; and the people actions can be given to.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withFarmWork(request, params.get("organisationId"), "read", async (tx) => ({
    reports: await listReports(tx, params.get("farmId"), { includeWithdrawn: params.get("includeWithdrawn") === "true" }),
    otherActions: await farmActionsWithoutReport(tx, params.get("farmId")),
    access: { canRecord: canRecordSafety(tx), canReport: canReportSafety(tx), farmStaff: tx.actor.role === "farm_worker", canSeeRestricted: await canSeeRestricted(tx), isOwner: tx.actor.role === "owner" },
    people: canRecordSafety(tx) ? await safetyPeople(tx.organisationId) : [],
  }));
  return json(result);
});

/** Records a report (`farmId`, `type`, `title`, ..., optional restricted `details` and a first `action`). Bookkeepers and above. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withFarmWork(request, body.organisationId, "read", async (tx) => addReport(tx, body, body.action ? await safetyPeopleMap(tx.organisationId) : new Map()));
  return json(result, { status: 201 });
});
