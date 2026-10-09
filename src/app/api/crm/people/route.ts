import { json, readJson, route, searchParams, withCrm } from "@/lib/api/http";
import { createPerson, listPeople } from "@/lib/crm/service";

/** People, optionally at one company or matching a search (example CRM2). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const people = await withCrm(request, params.get("organisationId"), "read", (tx) =>
    listPeople(tx, { contactId: params.get("contactId"), search: params.get("search"), includeArchived: params.get("includeArchived") === "true" }),
  );
  return json({ people });
});

export const POST = route(async (request) => {
  const body = await readJson(request);
  const person = await withCrm(request, body.organisationId, "write", (tx, { membership }) =>
    createPerson(
      tx,
      {
      contactId: body.contactId,
      firstName: body.firstName,
      lastName: body.lastName,
      jobTitle: body.jobTitle,
      email: body.email,
      phone: body.phone,
      isPrimary: body.isPrimary,
      customFields: body.customFields,
      recordTypeId: body.recordTypeId,
      },
      { role: membership.role },
    ),
  );
  return json({ person }, { status: 201 });
});
