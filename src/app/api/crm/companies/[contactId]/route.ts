import { json, route, searchParams, withCrm } from "@/lib/api/http";
import { getContact } from "@/lib/contacts/service";
import { companyLinks } from "@/lib/crm/duplicates";
import { getRecordType } from "@/lib/crm/record-types/service";
import { companyRelated, companyTimeline, listActivities, listOpportunities, listPeople, listTasks } from "@/lib/crm/service";

type Context = { params: Promise<{ contactId: string }> };

/**
 * A company's record page (examples CRM8, CRT11): the contact and its record
 * type, its people, opportunities, tasks, activities, invoices, credit notes,
 * how many notes and files it has, its timeline, and what it was merged
 * into or marked as the same customer as (decision 494).
 */
export const GET = route<Context>(async (request, context) => {
  const { contactId } = await context.params;
  const result = await withCrm(request, searchParams(request).get("organisationId"), "read", async (tx, { scope }) => {
    const contact = await getContact(tx, contactId);
    return {
      contact,
      recordType: await getRecordType(tx, contact.recordTypeId),
      people: await listPeople(tx, { contactId, includeArchived: true }),
      opportunities: await listOpportunities(tx, { contactId, scope }),
      tasks: await listTasks(tx, { contactId, scope }),
      activities: await listActivities(tx, { contactId, scope }),
      timeline: await companyTimeline(tx, contactId, scope),
      ...(await companyRelated(tx, contactId, scope)),
      ...(await companyLinks(tx, contactId)),
    };
  });
  return json(result);
});
