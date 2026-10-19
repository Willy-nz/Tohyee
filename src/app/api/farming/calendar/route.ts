import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { farmCalendar, itemsToCheck } from "@/lib/farming/calendar";

/**
 * GET ?organisationId=&from=&to=&farmId=&sender=: the member's own farm
 * calendar items in the range (FC13); with view=check, Needs checking
 * instead (no dates needed).
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const filter = { farmId: params.get("farmId") ?? undefined, sender: params.get("sender") ?? undefined };
  if (params.get("view") === "check") {
    const items = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => itemsToCheck(tx, filter));
    return json({ items });
  }
  const calendar = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => farmCalendar(tx, { from: params.get("from"), to: params.get("to"), ...filter }));
  return json(calendar);
});
