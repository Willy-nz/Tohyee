import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getContact } from "@/lib/contacts/service";
import { companyTimeline, listActivities, listOpportunities, listPeople, listTasks } from "@/lib/crm/service";

type Context = { params: Promise<{ contactId: string }> };

/** A company's page: the contact, its people, opportunities, tasks, activities and timeline (example CRM8). */
export const GET = route<Context>(async (request, context) => {
  const { contactId } = await context.params;
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", async (tx) => ({
    contact: await getContact(tx, contactId),
    people: await listPeople(tx, { contactId, includeArchived: true }),
    opportunities: await listOpportunities(tx, { contactId }),
    tasks: await listTasks(tx, { contactId }),
    activities: await listActivities(tx, { contactId }),
    timeline: await companyTimeline(tx, contactId),
  }));
  return json(result);
});
