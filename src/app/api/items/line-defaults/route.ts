import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { itemLineDefaults } from "@/lib/items/lines";

/**
 * What picking an item fills on a line (IT2-IT6): description, unit price,
 * account and tax code. `side` is sale or purchase; `contactId` is the
 * customer (for their price level) or supplier (for their price); `unitId`
 * a unit other than the item's default.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const defaults = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    itemLineDefaults(tx, {
      itemId: params.get("itemId"),
      side: params.get("side"),
      contactId: params.get("contactId"),
      unitId: params.has("unitId") ? params.get("unitId") : undefined,
    }),
  );
  return json(defaults);
});
