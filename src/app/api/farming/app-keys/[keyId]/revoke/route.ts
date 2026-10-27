import { json, readJson, requireAuth, route, requireFarmWorkMember } from "@/lib/api/http";
import { revokeFarmAppKey } from "@/lib/farm-apps/keys";
import { parseOrganisationId } from "@/lib/organisations/registry";

type Context = { params: Promise<{ keyId: string }> };

/** POST { organisationId }: revokes one of the signed-in person's own farm app keys. It stops working at once. */
export const POST = route<Context>(async (request, context) => {
  const { keyId } = await context.params;
  const auth = await requireAuth(request);
  const body = await readJson(request);
  const organisationId = parseOrganisationId(body.organisationId);
  await requireFarmWorkMember(auth, organisationId, "read");
  return json({ key: await revokeFarmAppKey(auth, organisationId, keyId) });
});
