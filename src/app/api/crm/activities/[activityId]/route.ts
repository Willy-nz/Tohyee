import { json, readJson, route, withCrm } from "@/lib/api/http";
import { updateActivity } from "@/lib/crm/service";

type Context = { params: Promise<{ activityId: string }> };

/** Corrects an activity; the change is in the history (example CRM7). */
export const PATCH = route<Context>(async (request, context) => {
  const { activityId } = await context.params;
  const body = await readJson(request);
  const activity = await withCrm(request, body.organisationId, "write", (tx, { scope }) =>
    updateActivity(tx, activityId, {
      kind: body.kind,
      happenedAt: body.happenedAt,
      subject: body.subject,
      body: body.body,
      contactId: body.contactId,
      personId: body.personId,
      opportunityId: body.opportunityId,
    }, scope),
  );
  return json({ activity });
});
