import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { revokeAiToken } from "@/lib/ai/tokens";
import { requireOrganisationRole } from "@/lib/auth/guard";
import { parseOrganisationId } from "@/lib/organisations/registry";

type Context = { params: Promise<{ tokenId: string }> };

/** POST { organisationId }: revokes one of the signed-in person's own AI keys. It stops working at once. */
export const POST = route<Context>(async (request, context) => {
  const { tokenId } = await context.params;
  const auth = await requireAuth(request);
  const body = await readJson(request);
  const organisationId = parseOrganisationId(body.organisationId);
  await requireOrganisationRole(auth, organisationId, "viewer");
  return json({ key: await revokeAiToken(auth, organisationId, tokenId) });
});
