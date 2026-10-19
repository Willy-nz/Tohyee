import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { checkCalendarItem, deleteCalendarItem, dismissCalendarItem, replaceCalendarItem, shareCalendarItem, skipCalendarDate } from "@/lib/farming/calendar";

type Context = { params: Promise<{ itemId: string }> };

/**
 * PATCH: one of the member's own items.
 * Body: { organisationId, date?, startTime?, endTime?, kind?, title?, farmId?, notes?, repeat?, repeatUntil? } corrects or confirms it (FC14, FC18);
 * or { organisationId, action: "dismiss" | "replace" (replacesId) | "skip" (date) | "share" | "unshare" } (FC14, FC19, FC20).
 */
export const PATCH = route<Context>(async (request, context) => {
  const { itemId } = await context.params;
  const body = await readJson(request);
  const item = await withOrganisation(request, body.organisationId, "viewer", (tx) => {
    switch (body.action) {
      case "dismiss":
        return dismissCalendarItem(tx, itemId);
      case "replace":
        return replaceCalendarItem(tx, itemId, body.replacesId);
      case "skip":
        return skipCalendarDate(tx, itemId, body.date);
      case "share":
        return shareCalendarItem(tx, itemId, true);
      case "unshare":
        return shareCalendarItem(tx, itemId, false);
      default:
        return checkCalendarItem(tx, itemId, {
          date: body.date,
          startTime: body.startTime,
          endTime: body.endTime,
          kind: body.kind,
          title: body.title,
          farmId: body.farmId,
          notes: body.notes,
          repeat: body.repeat,
          repeatUntil: body.repeatUntil,
        });
    }
  });
  return json({ item });
});

/** DELETE ?organisationId=: an item the member added (FC17). Items from email can only be hidden. */
export const DELETE = route<Context>(async (request, context) => {
  const { itemId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => deleteCalendarItem(tx, itemId));
  return json({ deleted: true });
});
