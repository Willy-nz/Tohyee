import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getContact } from "@/lib/contacts/service";
import { getRecordType } from "@/lib/crm/record-types/service";
import { companyRelated, companyTimeline, listActivities, listOpportunities, listPeople, listTasks } from "@/lib/crm/service";

type Context = { params: Promise<{ contactId: string }> };

/**
 * A company's record page (examples CRM8, CRT11): the contact and its record
 * type, its people, opportunities, tasks, activities, invoices, credit notes,
 * how many notes and files it has, and its timeline.
 */
export const GET = route<Context>(async (request, context) => {
  const { contactId } = await context.params;
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", async (tx) => {
    const contact = await getContact(tx, contactId);
    return {
      contact,
      recordType: await getRecordType(tx, contact.recordTypeId),
      people: await listPeople(tx, { contactId, includeArchived: true }),
      opportunities: await listOpportunities(tx, { contactId }),
      tasks: await listTasks(tx, { contactId }),
      activities: await listActivities(tx, { contactId }),
      timeline: await companyTimeline(tx, contactId),
      ...(await companyRelated(tx, contactId)),
    };
  });
  return json(result);
});
