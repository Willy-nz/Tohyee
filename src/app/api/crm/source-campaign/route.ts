import { json, readJson, route, withCrm } from "@/lib/api/http";
import { setSourceCampaign } from "@/lib/crm/campaigns";

/** Sets or clears the one campaign a lead or deal came from: `leadId` or `opportunityId`, and `campaignId` or null (decision 498). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  await withCrm(request, body.organisationId, "write", (tx, { scope }) =>
    setSourceCampaign(tx, { leadId: body.leadId, opportunityId: body.opportunityId, campaignId: body.campaignId ?? null }, scope),
  );
  return json({ ok: true });
});
