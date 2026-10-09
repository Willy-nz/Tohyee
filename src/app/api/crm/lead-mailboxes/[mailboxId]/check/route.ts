import { json, readJson, route, withCrm } from "@/lib/api/http";
import { checkLeadMailbox } from "@/lib/crm/lead-intake";

type Context = { params: Promise<{ mailboxId: string }> };

/** Check now: reads new emails into leads. The mailbox is read outside any database transaction. Admins. */
export const POST = route<Context>(async (request, context) => {
  const { mailboxId } = await context.params;
  const body = await readJson(request);
  const { organisation, actor } = await withCrm(request, body.organisationId, "admin", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  return json({ check: await checkLeadMailbox(organisation, actor, mailboxId) });
});
