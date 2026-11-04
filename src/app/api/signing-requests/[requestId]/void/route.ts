import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { kickEmailOutbox } from "@/lib/email/outbox";
import { voidSigningRequest } from "@/lib/signing/service";

type Context = { params: Promise<{ requestId: string }> };

/** POST `{ reason }`: voids an open request; its links stop working. */
export const POST = route<Context>(async (request, context) => {
  const { requestId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", async (tx) => ({ request: await voidSigningRequest(tx, requestId, { reason: body.reason }), organisationId: tx.organisationId }));
  kickEmailOutbox(result.organisationId);
  return json({ request: result.request });
});
