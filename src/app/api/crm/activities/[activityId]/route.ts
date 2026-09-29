import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { updateActivity } from "@/lib/crm/service";

type Context = { params: Promise<{ activityId: string }> };

/** Corrects an activity; the change is in the history (example CRM7). */
export const PATCH = route<Context>(async (request, context) => {
  const { activityId } = await context.params;
  const body = await readJson(request);
  const activity = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    updateActivity(tx, activityId, {
      kind: body.kind,
      happenedAt: body.happenedAt,
      subject: body.subject,
      body: body.body,
      contactId: body.contactId,
      personId: body.personId,
      opportunityId: body.opportunityId,
    }),
  );
  return json({ activity });
});
