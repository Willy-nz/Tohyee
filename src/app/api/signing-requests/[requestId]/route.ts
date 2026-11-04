import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getSigningRequest } from "@/lib/signing/service";

type Context = { params: Promise<{ requestId: string }> };

/** GET: one signing request with its signers, emails and history. */
export const GET = route<Context>(async (request, context) => {
  const { requestId } = await context.params;
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "farm_worker", async (tx) => ({ request: await getSigningRequest(tx, requestId) }));
  return json(result);
});
