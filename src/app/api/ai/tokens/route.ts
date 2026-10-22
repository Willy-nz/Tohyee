import { json, readJson, requireAuth, route, searchParams } from "@/lib/api/http";
import { oauthAddressesFor } from "@/lib/ai/oauth/config";
import { MAX_ACTIVE_CONNECTIONS } from "@/lib/ai/oauth/format";
import { createAiToken, listAiTokens, MAX_ACTIVE_AI_TOKENS, remoteAccessAddress } from "@/lib/ai/tokens";
import { requireOrganisationRole } from "@/lib/auth/guard";
import { parseOrganisationId } from "@/lib/organisations/registry";

/**
 * GET: the signed-in person's own AI keys and connected AI apps for the
 * organisation (never a key, token or hash; `kind` tells them apart), the
 * most they can have, the remote access address when remote access is on,
 * and the MCP address AI apps can sign in at (null unless it's https,
 * #427). Any member (viewer and up).
 */
export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  const organisationId = parseOrganisationId(searchParams(request).get("organisationId"));
  await requireOrganisationRole(auth, organisationId, "viewer");
  const remoteAddress = await remoteAccessAddress();
  return json({
    keys: await listAiTokens(auth, organisationId),
    maxActiveKeys: MAX_ACTIVE_AI_TOKENS,
    maxActiveConnections: MAX_ACTIVE_CONNECTIONS,
    remoteAddress,
    signInAddress: oauthAddressesFor(remoteAddress)?.resource ?? null,
  });
});

/**
 * POST { organisationId, name, accessLevel?, confirmFullAccess? }: makes a
 * key (accessLevel read, draft, post or full; read when left out). The key is
 * in this answer only. read, draft and post can be chosen by anyone and are
 * capped by the person's role whenever it's used; full needs the Owner role
 * and confirmFullAccess true (decision 488).
 */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  const body = await readJson(request);
  const organisationId = parseOrganisationId(body.organisationId);
  const membership = await requireOrganisationRole(auth, organisationId, "viewer");
  const result = await createAiToken(auth, organisationId, {
    name: body.name,
    accessLevel: body.accessLevel,
    role: membership.role,
    confirmFullAccess: body.confirmFullAccess,
  });
  return json(result, { status: 201 });
});
