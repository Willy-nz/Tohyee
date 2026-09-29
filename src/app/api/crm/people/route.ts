import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createPerson, listPeople } from "@/lib/crm/service";

/** People, optionally at one company or matching a search (example CRM2). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const people = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listPeople(tx, { contactId: params.get("contactId"), search: params.get("search"), includeArchived: params.get("includeArchived") === "true" }),
  );
  return json({ people });
});

export const POST = route(async (request) => {
  const body = await readJson(request);
  const person = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    createPerson(tx, { contactId: body.contactId, firstName: body.firstName, lastName: body.lastName, jobTitle: body.jobTitle, email: body.email, phone: body.phone }),
  );
  return json({ person }, { status: 201 });
});
