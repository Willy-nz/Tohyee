import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { MailOwner } from "@/lib/private-mail/access";
import { readMyThread } from "@/lib/private-mail/store";

type Context = { params: Promise<{ messageId: string }> };

/** GET ?organisationId=: one email's conversation (PM10). The Owner's own only; anyone else's is "not found". */
export const GET = route<Context>(async (request, context) => {
  const { messageId } = await context.params;
  const thread = await withOrganisation(request, searchParams(request).get("organisationId"), "sales_rep", async (tx) => readMyThread(tx, await MailOwner.of(tx), messageId));
  return json(thread, { headers: { "cache-control": "private, no-store" } });
});
