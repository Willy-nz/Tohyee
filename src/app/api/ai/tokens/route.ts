import { json, readJson, requireAuth, route, searchParams } from "@/lib/api/http";
import { createAiToken, listAiTokens, MAX_ACTIVE_AI_TOKENS, remoteAccessAddress } from "@/lib/ai/tokens";
import { requireOrganisationRole } from "@/lib/auth/guard";
import { parseOrganisationId } from "@/lib/organisations/registry";

/**
 * GET: the signed-in person's own AI keys for the organisation (never the
 * keys themselves or their hashes), the most they can have, and the remote
 * access address when remote access is on. Any member (viewer and up).
 */
export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  const organisationId = parseOrganisationId(searchParams(request).get("organisationId"));
  await requireOrganisationRole(auth, organisationId, "viewer");
  return json({
    keys: await listAiTokens(auth, organisationId),
    maxActiveKeys: MAX_ACTIVE_AI_TOKENS,
    remoteAddress: await remoteAccessAddress(),
  });
});

/** POST { organisationId, name }: makes a key. The key is in this answer only. */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  const body = await readJson(request);
  const organisationId = parseOrganisationId(body.organisationId);
  await requireOrganisationRole(auth, organisationId, "viewer");
  const result = await createAiToken(auth, organisationId, { name: body.name });
  return json(result, { status: 201 });
});
