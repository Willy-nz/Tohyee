import { json, readJson, route, searchParams, withCrm } from "@/lib/api/http";
import { getLead, updateLead } from "@/lib/crm/leads";
import { listActivities, listTasks } from "@/lib/crm/service";

type Context = { params: Promise<{ leadId: string }> };

/** A lead with its tasks and activities (decision 492). */
export const GET = route<Context>(async (request, context) => {
  const { leadId } = await context.params;
  const result = await withCrm(request, searchParams(request).get("organisationId"), "read", async (tx, { scope }) => {
    const lead = await getLead(tx, leadId, scope);
    return {
      lead,
      tasks: await listTasks(tx, { leadId: lead.id, scope }),
      activities: await listActivities(tx, { leadId: lead.id, scope }),
    };
  });
  return json(result);
});

/** Changes a lead, its owner or status (new, working, unqualified with `unqualifiedReason`), or `reviewed: true`. */
export const PATCH = route<Context>(async (request, context) => {
  const { leadId } = await context.params;
  const body = await readJson(request);
  const lead = await withCrm(request, body.organisationId, "write", (tx, { scope }) =>
    updateLead(
      tx,
      leadId,
      {
        firstName: body.firstName,
        lastName: body.lastName,
        companyName: body.companyName,
        email: body.email,
        phone: body.phone,
        jobTitle: body.jobTitle,
        description: body.description,
        sourceDetail: body.sourceDetail,
        ownerUserId: body.ownerUserId,
        status: body.status,
        unqualifiedReason: body.unqualifiedReason,
        reviewed: body.reviewed,
      },
      scope,
    ),
  );
  return json({ lead });
});
