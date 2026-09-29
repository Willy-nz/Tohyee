import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { updatePerson } from "@/lib/crm/service";

type Context = { params: Promise<{ personId: string }> };

/** Changes a person, or archives or restores them (`isArchived`). */
export const PATCH = route<Context>(async (request, context) => {
  const { personId } = await context.params;
  const body = await readJson(request);
  const person = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    updatePerson(tx, personId, {
      contactId: body.contactId,
      firstName: body.firstName,
      lastName: body.lastName,
      jobTitle: body.jobTitle,
      email: body.email,
      phone: body.phone,
      isArchived: body.isArchived,
    }),
  );
  return json({ person });
});
