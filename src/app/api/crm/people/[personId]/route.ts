import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getRecordType } from "@/lib/crm/record-types/service";
import { getPerson, listActivities, listOpportunities, listTasks, personTimeline, updatePerson } from "@/lib/crm/service";

type Context = { params: Promise<{ personId: string }> };

/** A person's record page (CRT11): the person, their record type, opportunities, tasks, activities and timeline. */
export const GET = route<Context>(async (request, context) => {
  const { personId } = await context.params;
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", async (tx) => {
    const person = await getPerson(tx, personId);
    return {
      person,
      recordType: await getRecordType(tx, person.recordTypeId),
      opportunities: await listOpportunities(tx, { personId: person.id }),
      tasks: await listTasks(tx, { personId: person.id }),
      activities: await listActivities(tx, { personId: person.id }),
      timeline: await personTimeline(tx, person.id),
    };
  });
  return json(result);
});

/** Changes a person, or archives or restores them (`isArchived`). */
export const PATCH = route<Context>(async (request, context) => {
  const { personId } = await context.params;
  const body = await readJson(request);
  const person = await withOrganisation(request, body.organisationId, "bookkeeper", (tx, { membership }) =>
    updatePerson(
      tx,
      personId,
      {
        contactId: body.contactId,
        firstName: body.firstName,
        lastName: body.lastName,
        jobTitle: body.jobTitle,
        email: body.email,
        phone: body.phone,
        isPrimary: body.isPrimary,
        isArchived: body.isArchived,
        customFields: body.customFields,
        recordTypeId: body.recordTypeId,
      },
      { role: membership.role },
    ),
  );
  return json({ person });
});
