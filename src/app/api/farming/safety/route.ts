import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { getEmergency, listHazards } from "@/lib/safety/hazards";
import { canRecordSafety, canReportSafety, canSeeRestricted } from "@/lib/safety/records";

/**
 * GET: one farm's safety overview (#446): its hazards and no-go zones
 * (`includeWithdrawn=true` adds those withdrawn as mistakes), its emergency
 * details, and what the person may do. Viewers and above, on their farms.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const overview = await withFarmWork(request, params.get("organisationId"), "read", async (tx) => ({
    hazards: await listHazards(tx, params.get("farmId"), { includeWithdrawn: params.get("includeWithdrawn") === "true" }),
    emergency: await getEmergency(tx, params.get("farmId")),
    access: { canRecord: canRecordSafety(tx), canReport: canReportSafety(tx), farmStaff: tx.actor.role === "farm_worker", canSeeRestricted: await canSeeRestricted(tx), isOwner: tx.actor.role === "owner" },
  }));
  return json(overview);
});
