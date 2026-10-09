import { json, readJson, route, searchParams, withCrm } from "@/lib/api/http";
import { salesContactInput } from "@/lib/crm/sales-contacts";
import { createContact, listContacts } from "@/lib/contacts/service";

/**
 * Contacts, searched by name or email. `includeArchived=true` also returns
 * archived contacts. Viewers and up, and sales reps and managers: the
 * contacts are the CRM's shared address book (decision 491).
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const contacts = await withCrm(request, params.get("organisationId"), "read", (tx) =>
    listContacts(tx, {
      search: params.get("search"),
      includeArchived: params.get("includeArchived") === "true",
    }),
  );
  return json({ contacts });
});

export const POST = route(async (request) => {
  const body = await readJson(request);
  // Bookkeepers and up; a sales rep or manager adds a prospect with its contact details only (decision 491).
  const result = await withCrm(request, body.organisationId, "write", (tx, { membership, scope }) =>
    createContact(
      tx,
      scope.sales ? salesContactInput(body, "create") : {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      name: body.name,
      isCustomer: body.isCustomer,
      isSupplier: body.isSupplier,
      email: body.email,
      phone: body.phone,
      postalAddress: body.postalAddress,
      gstNumber: body.gstNumber,
      currencyCode: body.currencyCode,
      customFields: body.customFields,
      defaultSalespersonId: body.defaultSalespersonId,
      isProspect: body.isProspect,
      deliveryAddress: body.deliveryAddress,
      paymentTermId: body.paymentTermId,
      creditLimit: body.creditLimit,
      customerGroupId: body.customerGroupId,
      priceLevelId: body.priceLevelId,
      parentContactId: body.parentContactId,
      supplierPaymentTermId: body.supplierPaymentTermId,
      billingCountry: body.billingCountry,
      deliveryCountry: body.deliveryCountry,
      defaultSalesTaxCode: body.defaultSalesTaxCode,
      defaultPurchaseTaxCode: body.defaultPurchaseTaxCode,
      defaultPurchaseAccountCode: body.defaultPurchaseAccountCode,
      defaultSalesAccountCode: body.defaultSalesAccountCode,
      defaultPurchaseTracking: body.defaultPurchaseTracking,
      defaultSalesTracking: body.defaultSalesTracking,
      recordTypeId: body.recordTypeId,
      ownerUserId: body.ownerUserId,
      },
      { role: membership.role },
    ),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
