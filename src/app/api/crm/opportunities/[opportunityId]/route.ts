import { json, readJson, route, searchParams, withCrm } from "@/lib/api/http";
import { getRecordType } from "@/lib/crm/record-types/service";
import { getOpportunity, listActivities, listTasks, opportunityStageHistory, opportunityTimeline, updateOpportunity } from "@/lib/crm/service";
import { getInvoice } from "@/lib/invoices/service";

type Context = { params: Promise<{ opportunityId: string }> };

/** An opportunity's record page (CRT11): the opportunity, its record type, tasks, activities, timeline, stage history (CRMS6) and invoice. */
export const GET = route<Context>(async (request, context) => {
  const { opportunityId } = await context.params;
  const result = await withCrm(request, searchParams(request).get("organisationId"), "read", async (tx, { scope }) => {
    const opportunity = await getOpportunity(tx, opportunityId, scope);
    return {
      opportunity,
      recordType: await getRecordType(tx, opportunity.recordTypeId),
      tasks: await listTasks(tx, { opportunityId: opportunity.id, scope }),
      activities: await listActivities(tx, { opportunityId: opportunity.id, scope }),
      timeline: await opportunityTimeline(tx, opportunity.id, scope),
      stageHistory: await opportunityStageHistory(tx, opportunity.id, scope),
      // Sales reps and managers see none of the books (decision 491).
      invoice: opportunity.invoiceId && !scope.sales ? await getInvoice(tx, opportunity.invoiceId) : null,
    };
  });
  return json(result);
});

/** Changes an opportunity or moves it to another stage (example CRM4). */
export const PATCH = route<Context>(async (request, context) => {
  const { opportunityId } = await context.params;
  const body = await readJson(request);
  const opportunity = await withCrm(request, body.organisationId, "write", (tx, { membership, scope }) =>
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
        probability: body.probability,
        forecastCategory: body.forecastCategory,
        customFields: body.customFields,
        recordTypeId: body.recordTypeId,
      },
      { role: membership.role, scope },
    ),
  );
  return json({ opportunity });
});
