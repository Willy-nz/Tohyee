import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { archiveContact, unarchiveContact, updateContact } from "@/lib/contacts/service";
import { ValidationError } from "@/lib/errors";
import { requireBoolean } from "@/lib/validation";

/**
 * Edits a contact's details, or archives/unarchives it with `isArchived`.
 * Archiving is a request on its own, so it can't be mixed up with an edit.
 */
export const PATCH = route<{ params: Promise<{ contactId: string }> }>(async (request, context) => {
  const { contactId } = await context.params;
  const body = await readJson(request);
  const details = {
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
  };
  const contact = await withOrganisation(request, body.organisationId, "bookkeeper", async (tx, { membership }) => {
    if (body.isArchived === undefined) {
      return updateContact(tx, contactId, details, { role: membership.role });
    }
    if (Object.values(details).some((value) => value !== undefined)) {
      throw new ValidationError("Archive or unarchive a contact on its own, then save any other changes separately.");
    }
    return requireBoolean(body.isArchived, "isArchived")
      ? archiveContact(tx, contactId)
      : unarchiveContact(tx, contactId);
  });
  return json({ contact });
});
