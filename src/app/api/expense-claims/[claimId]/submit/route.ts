import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { publicOrigin } from "@/lib/auth/origin";
import { kickEmailOutbox } from "@/lib/email/outbox";
import { submitExpenseClaim } from "@/lib/expense-claims/service";

type Context = { params: Promise<{ claimId: string }> };

/** Sends the signed-in person's draft for approval (EC2), through an approval rule's steps when one matches it (AW15). */
export const POST = route<Context>(async (request, context) => {
  const { claimId } = await context.params;
  const body = await readJson(request);
  const origin = await publicOrigin(request);
  const { claim, organisationId } = await withOrganisation(request, body.organisationId, "bookkeeper", async (tx, { membership }) => ({
    claim: await submitExpenseClaim(tx, claimId, { origin }),
    organisationId: membership.organisation.id,
  }));
  kickEmailOutbox(organisationId);
  return json({ claim });
});
