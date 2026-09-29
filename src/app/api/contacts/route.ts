import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createContact, listContacts } from "@/lib/contacts/service";

/** Contacts, searched by name or email. `includeArchived=true` also returns archived contacts. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const contacts = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listContacts(tx, {
      search: params.get("search"),
      includeArchived: params.get("includeArchived") === "true",
    }),
  );
  return json({ contacts });
});

export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    createContact(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      name: body.name,
      isCustomer: body.isCustomer,
      isSupplier: body.isSupplier,
      email: body.email,
      phone: body.phone,
      postalAddress: body.postalAddress,
      gstNumber: body.gstNumber,
      customFields: body.customFields,
      defaultSalespersonId: body.defaultSalespersonId,
      isProspect: body.isProspect,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
