import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { checkFarmMailbox, mailboxForCheck } from "@/lib/farming/calendar";

type Context = { params: Promise<{ mailboxId: string }> };

/** POST: "Check now" for the member's own mailbox. Body: { organisationId }. The reading happens outside the request's transaction. */
export const POST = route<Context>(async (request, context) => {
  const { mailboxId } = await context.params;
  const body = await readJson(request);
  const { organisation, id } = await withOrganisation(request, body.organisationId, "viewer", async (tx, { membership }) => ({
    organisation: membership.organisation,
    id: await mailboxForCheck(tx, mailboxId),
  }));
  const result = await checkFarmMailbox(organisation, id);
  return json(result);
});
