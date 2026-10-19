import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { checkCalendarItem, dismissCalendarItem, replaceCalendarItem } from "@/lib/farming/calendar";

type Context = { params: Promise<{ itemId: string }> };

/**
 * PATCH: corrects or confirms one of the member's own items (FC14).
 * Body: { organisationId, date?, startTime?, endTime?, kind?, title?, farmId? },
 * or { organisationId, action: "dismiss" }, or { organisationId, action: "replace", replacesId }.
 */
export const PATCH = route<Context>(async (request, context) => {
  const { itemId } = await context.params;
  const body = await readJson(request);
  const item = await withOrganisation(request, body.organisationId, "viewer", (tx) =>
    body.action === "dismiss"
      ? dismissCalendarItem(tx, itemId)
      : body.action === "replace"
        ? replaceCalendarItem(tx, itemId, body.replacesId)
        : checkCalendarItem(tx, itemId, { date: body.date, startTime: body.startTime, endTime: body.endTime, kind: body.kind, title: body.title, farmId: body.farmId }),
  );
  return json({ item });
});
