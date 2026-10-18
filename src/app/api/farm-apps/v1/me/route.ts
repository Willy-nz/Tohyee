import { farmAppEndpoint, preflight } from "@/lib/farm-apps/http";
import { API_VERSION } from "@/lib/farm-apps/api";

/** GET: who this key is: the organisation, the person, the key's name and what it may do now (FA1, FA2). */
export const GET = farmAppEndpoint(null, async (_tx, { identity }) => ({
  apiVersion: API_VERSION,
  organisation: { id: identity.membership.organisation.id, name: identity.membership.organisation.displayName },
  person: identity.user.displayName,
  key: identity.keyName,
  scopes: identity.effectiveScopes,
}));
export const OPTIONS = preflight;
