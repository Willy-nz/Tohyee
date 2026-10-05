import { route, searchParams, withOrganisation } from "@/lib/api/http";
import { fileResponse } from "@/lib/api/upload";
import { getInboxItemContent } from "@/lib/bills/inbox";

type Context = { params: Promise<{ itemId: string }> };

/** GET: the item's file; see fileResponse for what opens in the browser. */
export const GET = route<Context>(async (request, context) => {
  const { itemId } = await context.params;
  const params = searchParams(request);
  const file = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => getInboxItemContent(tx, itemId));
  return fileResponse(file, params.get("download") === "1");
});
