import { json, readJson, route, withCrm } from "@/lib/api/http";
import { setMemberStatus } from "@/lib/crm/campaigns";

type Context = { params: Promise<{ memberId: string }> };

/** Sets a campaign member's `status` by hand: added, sent or responded (decision 498). */
export const PATCH = route<Context>(async (request, context) => {
  const { memberId } = await context.params;
  const body = await readJson(request);
  const member = await withCrm(request, body.organisationId, "write", (tx, { scope }) => setMemberStatus(tx, memberId, body.status, scope));
  return json({ member });
});
