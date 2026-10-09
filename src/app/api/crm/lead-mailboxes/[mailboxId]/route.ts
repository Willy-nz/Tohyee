import { json, route, searchParams, withCrm } from "@/lib/api/http";
import { deleteLeadMailbox } from "@/lib/crm/lead-intake";

type Context = { params: Promise<{ mailboxId: string }> };

/** Stops reading a mailbox into leads; the leads stay. Admins. */
export const DELETE = route<Context>(async (request, context) => {
  const { mailboxId } = await context.params;
  await withCrm(request, searchParams(request).get("organisationId"), "admin", (tx) => deleteLeadMailbox(tx, mailboxId));
  return json({ removed: true });
});
