import { json, readJson, route, withCrm } from "@/lib/api/http";
import { addMembers } from "@/lib/crm/campaigns";

type Context = { params: Promise<{ campaignId: string }> };

/** Adds leads and people to a campaign: `leadIds`, `personIds` (decision 498). */
export const POST = route<Context>(async (request, context) => {
  const { campaignId } = await context.params;
  const body = await readJson(request);
  const result = await withCrm(request, body.organisationId, "write", (tx, { scope }) =>
    addMembers(tx, { campaignId, leadIds: body.leadIds, personIds: body.personIds }, scope),
  );
  return json(result);
});
