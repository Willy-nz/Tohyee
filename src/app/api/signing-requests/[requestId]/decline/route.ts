import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { kickEmailOutbox } from "@/lib/email/outbox";
import { signMeta } from "@/lib/signing/http";
import { declineAsMember } from "@/lib/signing/service";

type Context = { params: Promise<{ requestId: string }> };

/** POST `{ reason }`: the signed-in member declines to sign. */
export const POST = route<Context>(async (request, context) => {
  const { requestId } = await context.params;
  const body = await readJson(request);
  const meta = await signMeta(request);
  const result = await withOrganisation(request, body.organisationId, "farm_worker", async (tx) => ({ request: await declineAsMember(tx, requestId, body, meta), organisationId: tx.organisationId }));
  kickEmailOutbox(result.organisationId);
  return json({ request: result.request });
});
