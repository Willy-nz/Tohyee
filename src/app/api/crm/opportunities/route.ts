import { json, readJson, route, searchParams, withCrm } from "@/lib/api/http";
import { createOpportunity, listOpportunities } from "@/lib/crm/service";

/** Every opportunity in pipeline order, or one company's (examples CRM3, CRM9). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const opportunities = await withCrm(request, params.get("organisationId"), "read", (tx, { scope }) =>
    listOpportunities(tx, { contactId: params.get("contactId"), scope }),
  );
  return json({ opportunities });
});

export const POST = route(async (request) => {
  const body = await readJson(request);
  const opportunity = await withCrm(request, body.organisationId, "write", (tx, { membership, scope }) =>
    createOpportunity(
      tx,
      {
      name: body.name,
      contactId: body.contactId,
      pointOfContactId: body.pointOfContactId,
      ownerUserId: body.ownerUserId,
      amount: body.amount,
      closeDate: body.closeDate,
      stage: body.stage,
        probability: body.probability,
        forecastCategory: body.forecastCategory,
      customFields: body.customFields,
      recordTypeId: body.recordTypeId,
      },
      { role: membership.role, scope },
    ),
  );
  return json({ opportunity }, { status: 201 });
});
