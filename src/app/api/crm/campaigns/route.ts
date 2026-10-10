import { json, readJson, route, searchParams, withCrm } from "@/lib/api/http";
import { campaignTotals, createCampaign, listCampaigns } from "@/lib/crm/campaigns";

/** Campaigns and how many leads and deals each brought in (decision 498); a sales rep's counts are their own. */
export const GET = route(async (request) => {
  const result = await withCrm(request, searchParams(request).get("organisationId"), "read", async (tx, { scope }) => ({
    campaigns: await listCampaigns(tx),
    totals: await campaignTotals(tx, scope),
  }));
  return json(result);
});

/** Adds a campaign: `name`, `kind`, `status`, `startDate`, `endDate`, `budget`, `actualCost`, `description`. Admins and owners only. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const campaign = await withCrm(request, body.organisationId, "admin", (tx) =>
    createCampaign(tx, {
      name: body.name,
      kind: body.kind,
      status: body.status,
      startDate: body.startDate,
      endDate: body.endDate,
      budget: body.budget,
      actualCost: body.actualCost,
      description: body.description,
    }),
  );
  return json({ campaign }, { status: 201 });
});
