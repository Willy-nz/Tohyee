import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { publicOrigin } from "@/lib/auth/origin";
import { kickEmailOutbox } from "@/lib/email/outbox";
import { resendSigningLink } from "@/lib/signing/service";

type Context = { params: Promise<{ requestId: string }> };

/** POST `{ signerId }`: emails that signer a new link (the old one stops working). */
export const POST = route<Context>(async (request, context) => {
  const { requestId } = await context.params;
  const body = await readJson(request);
  const origin = await publicOrigin(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", async (tx) => ({ request: await resendSigningLink(tx, requestId, body.signerId, origin), organisationId: tx.organisationId }));
  kickEmailOutbox(result.organisationId);
  return json({ request: result.request });
});
