import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getInboxItem } from "@/lib/bills/inbox";

type Context = { params: Promise<{ itemId: string }> };

/** GET: one bills inbox item (BI1-BI6). */
export const GET = route<Context>(async (request, context) => {
  const { itemId } = await context.params;
  const item = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getInboxItem(tx, itemId));
  return json({ item });
});
