import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getRecordType } from "@/lib/crm/record-types/service";
import { getOpportunity, listActivities, listTasks, opportunityTimeline, updateOpportunity } from "@/lib/crm/service";
import { getInvoice } from "@/lib/invoices/service";

type Context = { params: Promise<{ opportunityId: string }> };

/** An opportunity's record page (CRT11): the opportunity, its record type, tasks, activities, timeline and invoice. */
export const GET = route<Context>(async (request, context) => {
  const { opportunityId } = await context.params;
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", async (tx) => {
    const opportunity = await getOpportunity(tx, opportunityId);
    return {
      opportunity,
      recordType: await getRecordType(tx, opportunity.recordTypeId),
      tasks: await listTasks(tx, { opportunityId: opportunity.id }),
      activities: await listActivities(tx, { opportunityId: opportunity.id }),
      timeline: await opportunityTimeline(tx, opportunity.id),
      invoice: opportunity.invoiceId ? await getInvoice(tx, opportunity.invoiceId) : null,
    };
  });
  return json(result);
});

/** Changes an opportunity or moves it to another stage (example CRM4). */
export const PATCH = route<Context>(async (request, context) => {
  const { opportunityId } = await context.params;
  const body = await readJson(request);
  const opportunity = await withOrganisation(request, body.organisationId, "bookkeeper", (tx, { membership }) =>
    updateOpportunity(
      tx,
      opportunityId,
      {
        name: body.name,
        contactId: body.contactId,
        pointOfContactId: body.pointOfContactId,
        ownerUserId: body.ownerUserId,
        amount: body.amount,
        closeDate: body.closeDate,
        stage: body.stage,
        customFields: body.customFields,
        recordTypeId: body.recordTypeId,
      },
      { role: membership.role },
    ),
  );
  return json({ opportunity });
});
