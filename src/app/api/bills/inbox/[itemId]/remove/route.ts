import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { removeInboxItem } from "@/lib/bills/inbox";

type Context = { params: Promise<{ itemId: string }> };

/** POST: removes an item that isn't a bill, with a `reason` (BI6). Bookkeepers and above. */
export const POST = route<Context>(async (request, context) => {
  const { itemId } = await context.params;
  const body = await readJson(request);
  const item = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => removeInboxItem(tx, itemId, { reason: body.reason }));
  return json({ item });
});
