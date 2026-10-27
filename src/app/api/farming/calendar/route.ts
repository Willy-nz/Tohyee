import { json, readJson, route, searchParams, withOrganisation, withFarmWork } from "@/lib/api/http";
import { addCalendarItem, farmCalendar, itemsToCheck } from "@/lib/farming/calendar";

/**
 * GET ?organisationId=&from=&to=&farmId=&sender=: the member's own farm
 * calendar items in the range, and those shared with the team (FC13,
 * FC21); with view=check, Needs checking instead (no dates needed).
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const filter = { farmId: params.get("farmId") ?? undefined, sender: params.get("sender") ?? undefined };
  if (params.get("view") === "check") {
    const items = await withFarmWork(request, params.get("organisationId"), "read", (tx) => itemsToCheck(tx, filter));
    return json({ items });
  }
  const calendar = await withFarmWork(request, params.get("organisationId"), "read", (tx) => farmCalendar(tx, { from: params.get("from"), to: params.get("to"), ...filter }));
  return json(calendar);
});

/**
 * POST: an item the member adds (FC17, FC18).
 * Body: { organisationId, date, title, kind?, startTime?, endTime?, farmId?, notes?, repeat?, repeatUntil? }.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const item = await withOrganisation(request, body.organisationId, "viewer", (tx) =>
    addCalendarItem(tx, {
      date: body.date,
      title: body.title,
      kind: body.kind,
      startTime: body.startTime,
      endTime: body.endTime,
      farmId: body.farmId,
      notes: body.notes,
      repeat: body.repeat,
      repeatUntil: body.repeatUntil,
    }),
  );
  return json({ item }, { status: 201 });
});
