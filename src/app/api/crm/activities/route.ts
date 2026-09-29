import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createActivity, listActivities } from "@/lib/crm/service";

/** Calls, meetings and notes, newest first (example CRM7). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const activities = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listActivities(tx, { contactId: params.get("contactId"), personId: params.get("personId"), opportunityId: params.get("opportunityId") }),
  );
  return json({ activities });
});

export const POST = route(async (request) => {
  const body = await readJson(request);
  const activity = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    createActivity(tx, {
      kind: body.kind,
      happenedAt: body.happenedAt,
      subject: body.subject,
      body: body.body,
      contactId: body.contactId,
      personId: body.personId,
      opportunityId: body.opportunityId,
    }),
  );
  return json({ activity }, { status: 201 });
});
