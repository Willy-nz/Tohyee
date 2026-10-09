import { json, readJson, route, searchParams, withCrm } from "@/lib/api/http";
import { createActivity, listActivities } from "@/lib/crm/service";

/** Calls, meetings and notes, newest first (example CRM7). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const activities = await withCrm(request, params.get("organisationId"), "read", (tx, { scope }) =>
    listActivities(tx, { contactId: params.get("contactId"), personId: params.get("personId"), opportunityId: params.get("opportunityId"), leadId: params.get("leadId"), scope }),
  );
  return json({ activities });
});

export const POST = route(async (request) => {
  const body = await readJson(request);
  const activity = await withCrm(request, body.organisationId, "write", (tx, { scope }) =>
    createActivity(tx, {
      kind: body.kind,
      happenedAt: body.happenedAt,
      subject: body.subject,
      body: body.body,
      contactId: body.contactId,
      personId: body.personId,
      opportunityId: body.opportunityId,
      leadId: body.leadId,
    }, scope),
  );
  return json({ activity }, { status: 201 });
});
