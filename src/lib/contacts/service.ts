import {
  CONTACT_DEFAULT_COLUMNS,
  type ContactDefaultRow,
  type ContactDefaults,
  type ContactDefaultsInput,
  contactDefaultsFromRow,
  NO_CONTACT_DEFAULTS,
  saveContactDefaults,
} from "@/lib/contacts/defaults";
import { writeAuditEvent } from "@/lib/audit";
import {
  keptCustom,
  loadCustomFieldContext,
  missingRequiredField,
  parseCustomInput,
  resolveCustomValues,
} from "@/lib/custom-fields/service";
import { contactUses, type CustomField, type CustomFieldUse, type CustomValues, customValuesKey, defaultValues, isSwitchedOn } from "@/lib/custom-fields/values";
import type { CustomFieldContext } from "@/lib/custom-fields/service";
import type { Role } from "@/lib/auth/roles";
import { standardFieldApplies } from "@/lib/crm/record-types/layout";
import { checkAgainstLayout, chooseRecordType, getRecordType, type LayoutValues } from "@/lib/crm/record-types/service";
import { listMembers } from "@/lib/organisations/members";
import {
  CUSTOMER_DETAIL_FIELDS,
  type CustomerDetails,
  type CustomerDetailsInput,
  customerDetailsForHash,
  hierarchyError,
  NO_CUSTOMER_DETAILS,
  resolveCustomerDetails,
  resolveSupplierPaymentTerm,
} from "@/lib/customers/service";
import { findCountry, HOME_COUNTRY } from "@/lib/contacts/countries";
import { type AvailableOn, isAvailableOn, onlyWords } from "@/lib/tax/available-on";
import { parseCurrencyCode } from "@/lib/money/currency";
import type { OrgTx } from "@/lib/db/org-transaction";
import { resolveDefaultSalesperson } from "@/lib/salespeople/service";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import {
  optionalBoolean,
  optionalSource,
  optionalString,
  requireId,
  requireIdempotencyKey,
  requireString,
} from "@/lib/validation";

/**
 * Customers and suppliers. Sales invoices go to customers and bills come from
 * suppliers. Contacts are archived, never deleted.
 */
export type Contact = {
  id: string;
  name: string;
  isCustomer: boolean;
  isSupplier: boolean;
  email: string | null;
  phone: string | null;
  /** The billing address (RC6); called the postal address before richer customers. */
  postalAddress: string | null;
  /** Digits only, e.g. "123456789". */
  gstNumber: string | null;
  /** Custom field values (CF3), field id -> value. */
  customFields: CustomValues;
  /** Put on this customer's new invoices and credit notes (SR1). */
  defaultSalespersonId: string | null;
  /** Someone you hope to sell to (the CRM, CRM1). Can't be invoiced until marked as a customer. */
  isProspect: boolean;
  isArchived: boolean;
  /** The primary contact person for invoices (RC6), from the CRM's people. */
  primaryPerson: { id: string; name: string; email: string | null } | null;
  /** A supplier's default payment term (SPT1): new bills take their due date from it. */
  supplierPaymentTermId: string | null;
  /**
   * The contact's currency, like a NetSuite customer's or vendor's primary currency (MC1): its
   * invoices, bills and credit notes are in it. Null is the base currency. Fixed once it has any.
   */
  currencyCode: string | null;
  /** The billing address's country (EX1), an ISO 3166-1 alpha-2 code; NZ unless set. */
  billingCountry: string;
  /** The delivery address's country (EX6); null means the billing country. */
  deliveryCountry: string | null;
  /**
   * The contact's own default sales tax code (EX5), like a NetSuite customer's
   * tax item: new sales lines start with it, before the tax code for exports.
   */
  defaultSalesTaxCode: string | null;
  /**
   * The contact's own default purchase tax code (EX16), like Xero's contact
   * "Purchase defaults" tax rate: new lines on bills, supplier credit notes,
   * purchase orders, repeating bills and spend money start with it.
   */
  defaultPurchaseTaxCode: string | null;
  /** The CRM record type (CRT1): which page layout the company has, and its required and read-only fields. */
  recordTypeId: string;
  recordTypeName: string;
  /** The company's owner in the CRM (CRT8), a member of the organisation. */
  ownerUserId: string | null;
  createdAt: string;
  updatedAt: string;
} & CustomerDetails &
  ContactDefaults;

/** The details a person enters. An edit leaves out anything it doesn't change. */
export type ContactInput = {
  name?: unknown;
  isCustomer?: unknown;
  isSupplier?: unknown;
  email?: unknown;
  phone?: unknown;
  postalAddress?: unknown;
  gstNumber?: unknown;
  customFields?: unknown;
  defaultSalespersonId?: unknown;
  isProspect?: unknown;
  supplierPaymentTermId?: unknown;
  /** A currency code; blank or the base currency for the base currency (MC1). */
  currencyCode?: unknown;
  /** A country code or name (EX1); blank for New Zealand. */
  billingCountry?: unknown;
  /** A country code or name (EX6); blank for the billing country. */
  deliveryCountry?: unknown;
  /** A tax code; blank for none (EX5). */
  defaultSalesTaxCode?: unknown;
  /** A tax code; blank for none (EX16). */
  defaultPurchaseTaxCode?: unknown;
  /** A CRM record type for companies (CRT5); the default for a new contact. */
  recordTypeId?: unknown;
  /** A member's user id; blank for none (CRT8). */
  ownerUserId?: unknown;
} & CustomerDetailsInput &
  ContactDefaultsInput;

/** Who is saving: read-only fields on a record type are for admins and owners (CRT6). */
export type SaveOptions = { role?: Role };

type ContactDetails = Pick<Contact, "name" | "isCustomer" | "isSupplier" | "email" | "phone" | "postalAddress" | "gstNumber">;

const DETAIL_FIELDS = ["name", "isCustomer", "isSupplier", "email", "phone", "postalAddress", "gstNumber"] as const;

type ContactRow = {
  id: string;
  request_hash: string;
  name: string;
  is_customer: boolean;
  is_supplier: boolean;
  email: string | null;
  phone: string | null;
  postal_address: string | null;
  gst_number: string | null;
  custom_fields: CustomValues;
  default_salesperson_id: string | null;
  is_prospect: boolean;
  is_archived: boolean;
  delivery_address: string | null;
  payment_term_id: string | null;
  credit_limit: string | null;
  customer_group_id: string | null;
  price_level_id: string | null;
  parent_contact_id: string | null;
  supplier_payment_term_id: string | null;
  primary_person_id: string | null;
  primary_person_name: string | null;
  primary_person_email: string | null;
  currency_code: string | null;
  billing_country: string;
  delivery_country: string | null;
  default_sales_tax_code_id: string | null;
  default_sales_tax_code: string | null;
  default_purchase_tax_code_id: string | null;
  default_purchase_tax_code: string | null;
  record_type_id: string;
  record_type_name: string;
  owner_user_id: string | null;
  created_at: string;
  updated_at: string;
} & Partial<ContactDefaultRow>;

const OWN_COLUMNS =
  "id, request_hash, name, is_customer, is_supplier, email, phone, postal_address, gst_number, custom_fields, default_salesperson_id, is_prospect, is_archived, " +
  "delivery_address, payment_term_id, credit_limit::text, customer_group_id, price_level_id, parent_contact_id, supplier_payment_term_id, currency_code, " +
  "billing_country, delivery_country, default_sales_tax_code_id, default_purchase_tax_code_id, record_type_id, owner_user_id, created_at, updated_at";

/** The primary contact person (RC6), looked up for each contact. */
const PRIMARY_PERSON = `(select p.id from crm_people p where p.contact_id = contacts.id and p.is_primary) as primary_person_id,
  (select nullif(concat_ws(' ', p.first_name, p.last_name), '') from crm_people p where p.contact_id = contacts.id and p.is_primary) as primary_person_name,
  (select p.email from crm_people p where p.contact_id = contacts.id and p.is_primary) as primary_person_email`;

const COLUMNS = `${OWN_COLUMNS}, ${PRIMARY_PERSON},
  (select t.code from tax_codes t where t.id = contacts.default_sales_tax_code_id) as default_sales_tax_code,
  (select t.code from tax_codes t where t.id = contacts.default_purchase_tax_code_id) as default_purchase_tax_code,
  (select r.name from crm_record_types r where r.id = contacts.record_type_id) as record_type_name,
  ${CONTACT_DEFAULT_COLUMNS}`;

function toContact(row: ContactRow): Contact {
  return {
    id: row.id,
    name: row.name,
    isCustomer: row.is_customer,
    isSupplier: row.is_supplier,
    email: row.email,
    phone: row.phone,
    postalAddress: row.postal_address,
    gstNumber: row.gst_number,
    customFields: row.custom_fields ?? {},
    defaultSalespersonId: row.default_salesperson_id,
    isProspect: row.is_prospect,
    isArchived: row.is_archived,
    primaryPerson: row.primary_person_id
      ? { id: row.primary_person_id, name: row.primary_person_name ?? "", email: row.primary_person_email }
      : null,
    deliveryAddress: row.delivery_address,
    paymentTermId: row.payment_term_id,
    creditLimit: row.credit_limit,
    customerGroupId: row.customer_group_id,
    priceLevelId: row.price_level_id,
    parentContactId: row.parent_contact_id,
    supplierPaymentTermId: row.supplier_payment_term_id,
    currencyCode: row.currency_code,
    billingCountry: row.billing_country,
    deliveryCountry: row.delivery_country,
    defaultSalesTaxCode: row.default_sales_tax_code,
    defaultPurchaseTaxCode: row.default_purchase_tax_code,
    recordTypeId: row.record_type_id,
    recordTypeName: row.record_type_name,
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...contactDefaultsFromRow({
      default_purchase_account_code: row.default_purchase_account_code ?? null,
      default_sales_account_code: row.default_sales_account_code ?? null,
      default_purchase_tracking: row.default_purchase_tracking ?? null,
      default_sales_tracking: row.default_sales_tracking ?? null,
    }),
  };
}

/**
 * A country as sent (EX1, EX6): undefined when not sent; blank is `blank`
 * (New Zealand for the billing country, none for the delivery country).
 */
function parseCountry(input: unknown, label: string, blank: string | null): string | null | undefined {
  if (input === undefined) return undefined;
  if (input === null || (typeof input === "string" && input.trim() === "")) return blank;
  if (typeof input !== "string") throw new ValidationError(`${label} must be a country code, like AU.`);
  const code = findCountry(input);
  if (!code) throw new ValidationError(`${label} "${input.trim()}" isn't a country. Use its two-letter code (like AU or US) or its name.`);
  return code;
}

/**
 * The contact's default sales tax code (EX5) or purchase tax code (EX16,
 * EX21): blank for none, else an active tax code (matched ignoring case; the
 * one it already has may be kept though inactive) available on that side:
 * Sales or Both for the sales default, Purchases or Both for the purchase
 * one (TAO7, like NetSuite: a vendor's default "must be available on purchase
 * transactions"). The database checks it too. Returns its id and code, or
 * undefined when not sent.
 */
async function resolveDefaultTaxCode(
  tx: OrgTx,
  input: unknown,
  kept: string | null,
  side: "sales" | "purchase" = "sales",
): Promise<{ id: string; code: string } | null | undefined> {
  if (input === undefined) return undefined;
  const code = optionalString(input, side === "sales" ? "defaultSalesTaxCode" : "defaultPurchaseTaxCode", { maxLength: 20 });
  if (code === null) return null;
  const found = await tx.query<{ id: string; code: string; is_active: boolean; available_on: AvailableOn }>(
    "select id, code, is_active, available_on from tax_codes where upper(code) = upper($1)",
    [code],
  );
  const row = found.rows[0];
  if (!row) throw new ValidationError(`There's no tax code ${code}.`);
  if (!row.is_active && row.code !== kept) {
    throw new ValidationError(`Tax code ${row.code} is inactive, so it can't be a contact's default ${side} tax code.`);
  }
  if (!isAvailableOn(row.available_on, side === "sales" ? "sales" : "purchases")) {
    throw new ValidationError(
      `Tax code ${row.code} is available on ${onlyWords(row.available_on)}, so it can't be a contact's default ${side} tax code. Choose a code available on ${side === "sales" ? "sales" : "purchases"}.`,
    );
  }
  return { id: row.id, code: row.code };
}

/** A contact's currency as sent (MC1): undefined when not sent; null for the base currency. */
function parseContactCurrency(tx: OrgTx, input: unknown): string | null | undefined {
  if (input === undefined) return undefined;
  if (input === null || (typeof input === "string" && input.trim() === "")) return null;
  const code = parseCurrencyCode(input, "currencyCode");
  return code === tx.baseCurrency ? null : code;
}

/** Refuses changing the currency of a contact that has invoices, bills or credit notes (MC1). The database refuses it too. */
async function assertCurrencyCanChange(tx: OrgTx, contact: { id: string; name: string; currencyCode: string | null }): Promise<void> {
  const used = await tx.query(
    `select 1 where exists (select 1 from sales_invoices where contact_id = $1) or exists (select 1 from bills where contact_id = $1)
        or exists (select 1 from sales_credit_notes where contact_id = $1) or exists (select 1 from supplier_credit_notes where contact_id = $1)
        or exists (select 1 from quotes where contact_id = $1) or exists (select 1 from repeating_invoices where contact_id = $1)
        or exists (select 1 from repeating_bills where contact_id = $1) or exists (select 1 from purchase_orders where contact_id = $1)
        or exists (select 1 from sales_orders where contact_id = $1)`,
    [contact.id],
  );
  if ((used.rowCount ?? 0) > 0) {
    // Quotes, repeating documents, purchase and sales orders are in the contact's currency too (MC25-MC28, SO10).
    throw new ConflictError(
      `${contact.name} has invoices, bills or credit notes in ${contact.currencyCode ?? tx.baseCurrency}, so its currency can't change (quotes, repeating documents, purchase orders and sales orders count too). Add a new contact for the other currency.`,
    );
  }
  // A project's rates and estimate, and an opportunity's amount, are in the contact's currency too (MC61, MC68).
  const projects = await tx.query(
    "select 1 where exists (select 1 from projects where contact_id = $1) or exists (select 1 from crm_opportunities where contact_id = $1)",
    [contact.id],
  );
  if ((projects.rowCount ?? 0) > 0) {
    throw new ConflictError(
      `${contact.name} has projects or CRM opportunities in ${contact.currencyCode ?? tx.baseCurrency}, so its currency can't change (their rates, estimates and amounts are in it). Add a new contact for the other currency.`,
    );
  }
}

function customerDetailsOf(contact: Contact): CustomerDetails {
  return Object.fromEntries(CUSTOMER_DETAIL_FIELDS.map((field) => [field, contact[field]])) as CustomerDetails;
}

async function crmOn(tx: OrgTx): Promise<boolean> {
  const result = await tx.query<{ crm_enabled: boolean }>("select crm_enabled from organisation_settings where id = true");
  return result.rows[0]?.crm_enabled === true;
}

/**
 * Whether the contact is a prospect (CRM1): only the CRM can make one, but
 * one that already is stays one with the CRM off. A contact must be a
 * customer, a supplier or a prospect.
 */
async function prospectFlag(tx: OrgTx, input: unknown, details: ContactDetails, current: boolean): Promise<boolean> {
  const wanted = optionalBoolean(input, "isProspect") ?? current;
  const crm = wanted !== current || (!details.isCustomer && !details.isSupplier && !wanted) ? await crmOn(tx) : false;
  if (wanted && !current && !crm) throw new ValidationError("The CRM is off, so a contact can't be made a prospect.");
  if (!details.isCustomer && !details.isSupplier && !wanted) {
    throw new ValidationError(crm ? "A contact must be a customer, a supplier or a prospect." : "A contact must be a customer, a supplier or both.");
  }
  return wanted;
}

/**
 * Checks a contact's custom field values (CF3, CF7, CF8, CRMF3): the ones sent, or
 * for a new contact each field's default. A required field for one of the
 * contact's roles must be set.
 */
async function contactCustomValues(
  tx: OrgTx,
  raw: Record<string, unknown> | undefined,
  details: ContactDetails & { isProspect?: boolean },
  saved: CustomValues | null,
): Promise<CustomValues> {
  const ctx = await loadCustomFieldContext(tx);
  const uses = contactUses(details);
  const values = resolveCustomValues(ctx, raw === undefined && saved ? saved : raw, { record: "contact", uses, kept: keptCustom(saved ?? {}) });
  const missing = missingRequiredField(ctx, values, { record: "contact", uses });
  if (missing) throw new ValidationError(`${missing} is required.`);
  return values;
}

/** The company's owner (CRT8): a member of the organisation, or none. */
async function parseOwner(tx: OrgTx, input: unknown): Promise<string | null> {
  if (input === null || input === "") return null;
  if (typeof input !== "string") throw new ValidationError("The owner must be a member of the organisation.");
  const members = await listMembers(tx.organisationId);
  if (!members.some((member) => member.userId === input)) throw new ValidationError("The owner must be a member of the organisation.");
  return input;
}

/** Whether a contact field is used on a contact with these roles now (CRMF8, CRMF11). */
function contactFieldApplies(ctx: CustomFieldContext, uses: readonly CustomFieldUse[]): (field: CustomField) => boolean {
  return (field) => field.usedOn.some((use) => uses.includes(use) && isSwitchedOn(ctx, use));
}

type LayoutStandard = Pick<Contact, "name" | "email" | "phone" | "gstNumber" | "postalAddress" | "deliveryAddress" | "ownerUserId">;

function contactLayoutValues(standard: LayoutStandard, custom: CustomValues): LayoutValues {
  return {
    standard: {
      name: standard.name,
      ownerUserId: standard.ownerUserId,
      email: standard.email,
      phone: standard.phone,
      gstNumber: standard.gstNumber,
      postalAddress: standard.postalAddress,
      deliveryAddress: standard.deliveryAddress,
    },
    custom,
  };
}

function detailsOf(contact: Contact): ContactDetails {
  return {
    name: contact.name,
    isCustomer: contact.isCustomer,
    isSupplier: contact.isSupplier,
    email: contact.email,
    phone: contact.phone,
    postalAddress: contact.postalAddress,
    gstNumber: contact.gstNumber,
  };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseName(input: unknown): string {
  return requireString(input, "name", { maxLength: 150 });
}

function parseEmail(input: unknown): string | null {
  const email = optionalString(input, "email", { maxLength: 254 });
  if (email !== null && !EMAIL_PATTERN.test(email)) {
    throw new ValidationError("Enter a valid email address, like accounts@example.co.nz.");
  }
  return email;
}

function parsePhone(input: unknown): string | null {
  return optionalString(input, "phone", { maxLength: 50 });
}

function parsePostalAddress(input: unknown): string | null {
  return optionalString(input, "postal address", { maxLength: 500 });
}

/**
 * NZ GST numbers have 8 or 9 digits and are often written 123-456-789. Only
 * the digits are kept. This checks the format; it doesn't prove the number
 * belongs to anyone.
 */
function parseGstNumber(input: unknown): string | null {
  const value = optionalString(input, "GST number", { maxLength: 20 });
  if (value === null) {
    return null;
  }
  if (!/^[0-9 -]+$/.test(value)) {
    throw new ValidationError("GST number can contain only digits, spaces and dashes.");
  }
  const digits = value.replace(/[ -]/g, "");
  if (!/^[0-9]{8,9}$/.test(digits)) {
    throw new ValidationError("GST number must have 8 or 9 digits, like 123-456-789.");
  }
  return digits;
}


function nameTaken(name: string): ConflictError {
  return new ConflictError(
    `There's already an active contact called "${name}". Use a different name, or archive that contact first.`,
  );
}

/** Name of another active contact with the same name, ignoring case. */
async function activeNameClash(tx: OrgTx, name: string, exceptId: string | null): Promise<string | null> {
  const result = await tx.query<{ name: string }>(
    `select name from contacts
      where not is_archived and lower(name) = lower($1) and id <> coalesce($2::bigint, 0)
      limit 1`,
    [name, exceptId],
  );
  return result.rows[0]?.name ?? null;
}

async function findByKey(tx: OrgTx, source: string, idempotencyKey: string): Promise<ContactRow | null> {
  const result = await tx.query<ContactRow>(
    `select ${COLUMNS} from contacts where command_source = $1 and idempotency_key = $2`,
    [source, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

/** Loads a contact and locks it until the transaction ends. */
async function lockContact(tx: OrgTx, contactIdInput: unknown): Promise<Contact> {
  const contactId = requireId(contactIdInput, "contactId");
  const result = await tx.query<ContactRow>(`select ${COLUMNS} from contacts where id = $1 for update`, [contactId]);
  if (!result.rows[0]) {
    throw new NotFoundError("Contact not found.");
  }
  return toContact(result.rows[0]);
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

async function readRow(tx: OrgTx, id: string): Promise<ContactRow> {
  const result = await tx.query<ContactRow>(`select ${COLUMNS} from contacts where id = $1`, [id]);
  return result.rows[0];
}

async function insertContact(tx: OrgTx, sql: string, values: unknown[]) {
  try {
    return await tx.query<{ id: string }>(sql, values);
  } catch (error) {
    throw hierarchyError(error) ?? error;
  }
}

export async function getContact(tx: OrgTx, contactIdInput: unknown): Promise<Contact> {
  const contactId = requireId(contactIdInput, "contactId");
  const result = await tx.query<ContactRow>(`select ${COLUMNS} from contacts where id = $1`, [contactId]);
  if (!result.rows[0]) {
    throw new NotFoundError("Contact not found.");
  }
  return toContact(result.rows[0]);
}

/** Contacts in name order, searched by name or email. Archived ones only if asked for. */
export async function listContacts(
  tx: OrgTx,
  options: { search?: unknown; includeArchived?: boolean } = {},
): Promise<Contact[]> {
  const search = optionalString(options.search, "search", { maxLength: 100 });
  const pattern = search === null ? null : `%${search.replace(/[\\%_]/g, "\\$&")}%`;
  const result = await tx.query<ContactRow>(
    `select ${COLUMNS} from contacts
      where ($1::boolean or not is_archived)
        and ($2::text is null or name ilike $2 or email ilike $2)
      order by lower(name), id`,
    [options.includeArchived ?? false, pattern],
  );
  return result.rows.map(toContact);
}

export async function createContact(
  tx: OrgTx,
  input: ContactInput & { source?: unknown; idempotencyKey: unknown; name: unknown },
  options: SaveOptions = {},
): Promise<{ created: boolean; contact: Contact }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const details: ContactDetails = {
    name: parseName(input.name),
    isCustomer: optionalBoolean(input.isCustomer, "isCustomer") ?? false,
    isSupplier: optionalBoolean(input.isSupplier, "isSupplier") ?? false,
    email: parseEmail(input.email),
    phone: parsePhone(input.phone),
    postalAddress: parsePostalAddress(input.postalAddress),
    gstNumber: parseGstNumber(input.gstNumber),
  };
  const isProspect = await prospectFlag(tx, input.isProspect, details, false);
  const rawCustom = parseCustomInput(input.customFields, "");
  const rawSalesperson = input.defaultSalespersonId === undefined || input.defaultSalespersonId === null || input.defaultSalespersonId === "" ? null : String(input.defaultSalespersonId);
  const currencyCode = parseContactCurrency(tx, input.currencyCode) ?? null;
  const billingCountry = parseCountry(input.billingCountry, "Billing country", HOME_COUNTRY) ?? HOME_COUNTRY;
  const deliveryCountry = parseCountry(input.deliveryCountry, "Delivery country", null) ?? null;
  const rawSalesTax = optionalString(input.defaultSalesTaxCode, "defaultSalesTaxCode", { maxLength: 20 })?.toUpperCase() ?? null;
  const rawPurchaseTax = optionalString(input.defaultPurchaseTaxCode, "defaultPurchaseTaxCode", { maxLength: 20 })?.toUpperCase() ?? null;
  const rawRecordType = input.recordTypeId === undefined || input.recordTypeId === null || input.recordTypeId === "" ? null : String(input.recordTypeId);
  const rawOwner = input.ownerUserId === undefined || input.ownerUserId === null || input.ownerUserId === "" ? null : input.ownerUserId;

  // Values that weren't sent stay out of the hash, so older requests hash the same.
  const hash = requestHash("contact", {
    ...details,
    ...(currencyCode === null ? {} : { currencyCode }),
    ...(billingCountry === HOME_COUNTRY ? {} : { billingCountry }),
    ...(deliveryCountry === null ? {} : { deliveryCountry }),
    ...(rawSalesTax === null ? {} : { defaultSalesTaxCode: rawSalesTax }),
    ...(rawPurchaseTax === null ? {} : { defaultPurchaseTaxCode: rawPurchaseTax }),
    ...defaultsForHash(input),
    ...(rawCustom === undefined ? {} : { customFields: rawCustom }),
    ...(rawSalesperson === null ? {} : { defaultSalespersonId: rawSalesperson }),
    ...(isProspect ? { isProspect } : {}),
    ...(rawRecordType === null ? {} : { recordTypeId: rawRecordType }),
    ...(rawOwner === null ? {} : { ownerUserId: rawOwner }),
    ...customerDetailsForHash(input),
    ...(input.supplierPaymentTermId === undefined ? {} : { supplierPaymentTermId: input.supplierPaymentTermId === "" ? null : input.supplierPaymentTermId }),
  });
  const existing = await findByKey(tx, source, idempotencyKey);
  if (existing) {
    assertSameRequest(existing.request_hash, hash, "contact");
    return { created: false, contact: toContact(existing) };
  }

  const customFields = await contactCustomValues(tx, rawCustom, { ...details, isProspect }, null);
  const defaultSalespersonId = (await resolveDefaultSalesperson(tx, input.defaultSalespersonId, null)) ?? null;
  const customer = await resolveCustomerDetails(tx, input, NO_CUSTOMER_DETAILS, { contactId: null, isCustomer: details.isCustomer });
  const supplierPaymentTermId = await resolveSupplierPaymentTerm(tx, input.supplierPaymentTermId, null, { isSupplier: details.isSupplier });
  const salesTax = (await resolveDefaultTaxCode(tx, rawSalesTax, null)) ?? null;
  const purchaseTax = (await resolveDefaultTaxCode(tx, rawPurchaseTax, null, "purchase")) ?? null;
  const recordType = await chooseRecordType(tx, "contact", rawRecordType, null);
  const ownerUserId = await parseOwner(tx, rawOwner);
  const ctx = await loadCustomFieldContext(tx);
  const uses = contactUses({ ...details, isProspect });
  await checkAgainstLayout(tx, {
    record: "contact",
    type: recordType,
    values: contactLayoutValues({ ...details, deliveryAddress: customer.deliveryAddress, ownerUserId }, customFields),
    before: { type: null, values: { standard: {}, custom: defaultValues([...ctx.fields.values()], "contact", uses, ctx) } },
    role: options.role,
    ctx,
    applies: contactFieldApplies(ctx, uses),
    standardApplies: (key) => standardFieldApplies("contact", key, details),
  });

  // No separate name check first: the original of a retry could commit between
  // it and the key check above. The unique indexes decide, and the key is
  // checked again before a name clash is reported.
  const inserted = await insertContact(
    tx,
    `insert into contacts (command_source, idempotency_key, request_hash, name, is_customer, is_supplier,
                           email, phone, postal_address, gst_number, custom_fields, default_salesperson_id, is_prospect,
                           delivery_address, payment_term_id, credit_limit, customer_group_id, price_level_id, parent_contact_id,
                           supplier_payment_term_id, currency_code, billing_country, delivery_country, default_sales_tax_code_id,
                           default_purchase_tax_code_id, record_type_id, owner_user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16::numeric, $17, $18, $19, $20, $21, $22, $23, $24, $25,
             $26, $27)
     on conflict do nothing
     returning ${OWN_COLUMNS}`,
    [
      source,
      idempotencyKey,
      hash,
      details.name,
      details.isCustomer,
      details.isSupplier,
      details.email,
      details.phone,
      details.postalAddress,
      details.gstNumber,
      JSON.stringify(customFields),
      defaultSalespersonId,
      isProspect,
      customer.deliveryAddress,
      customer.paymentTermId,
      customer.creditLimit,
      customer.customerGroupId,
      customer.priceLevelId,
      customer.parentContactId,
      supplierPaymentTermId,
      currencyCode,
      billingCountry,
      deliveryCountry,
      salesTax?.id ?? null,
      purchaseTax?.id ?? null,
      recordType.id,
      ownerUserId,
    ],
  );
  const defaultChanges = inserted.rows[0] ? await saveContactDefaults(tx, inserted.rows[0].id, input, NO_CONTACT_DEFAULTS) : {};
  const row = inserted.rows[0] ? await readRow(tx, inserted.rows[0].id) : undefined;
  if (!row) {
    // The command was already saved (possibly by a copy that committed after
    // the check above), or an active contact has the same name.
    const winner = await findByKey(tx, source, idempotencyKey);
    if (winner) {
      assertSameRequest(winner.request_hash, hash, "contact");
      return { created: false, contact: toContact(winner) };
    }
    throw nameTaken((await activeNameClash(tx, details.name, null)) ?? details.name);
  }
  await writeAuditEvent(tx, {
    eventType: "contact.created",
    entityType: "contact",
    entityId: row.id,
    details: {
      ...details,
      ...(Object.keys(customFields).length > 0 ? { customFields } : {}),
      ...(defaultSalespersonId ? { defaultSalespersonId } : {}),
      ...(isProspect ? { isProspect } : {}),
      ...(currencyCode ? { currencyCode } : {}),
      billingCountry,
      ...(deliveryCountry ? { deliveryCountry } : {}),
      ...(salesTax ? { defaultSalesTaxCode: salesTax.code } : {}),
      ...(purchaseTax ? { defaultPurchaseTaxCode: purchaseTax.code } : {}),
      ...Object.fromEntries(Object.entries(customer).filter(([, value]) => value !== null)),
      ...(supplierPaymentTermId ? { supplierPaymentTermId } : {}),
      recordType: recordType.name,
      ...(ownerUserId ? { ownerUserId } : {}),
      ...Object.fromEntries(Object.entries(defaultChanges).map(([key, change]) => [key, change.to])),
    },
  });
  return { created: true, contact: toContact(row) };
}

/**
 * Changes the fields that are sent; a blank optional field is cleared. An
 * edit that changes nothing isn't saved or audited.
 */
export async function updateContact(tx: OrgTx, contactIdInput: unknown, input: ContactInput, options: SaveOptions = {}): Promise<Contact> {
  const current = await lockContact(tx, contactIdInput);
  const before = detailsOf(current);
  const after: ContactDetails = {
    name: input.name === undefined ? before.name : parseName(input.name),
    isCustomer: optionalBoolean(input.isCustomer, "isCustomer") ?? before.isCustomer,
    isSupplier: optionalBoolean(input.isSupplier, "isSupplier") ?? before.isSupplier,
    email: input.email === undefined ? before.email : parseEmail(input.email),
    phone: input.phone === undefined ? before.phone : parsePhone(input.phone),
    postalAddress:
      input.postalAddress === undefined ? before.postalAddress : parsePostalAddress(input.postalAddress),
    gstNumber: input.gstNumber === undefined ? before.gstNumber : parseGstNumber(input.gstNumber),
  };
  const isProspect = await prospectFlag(tx, input.isProspect, after, current.isProspect);
  const customFields = await contactCustomValues(tx, parseCustomInput(input.customFields, ""), { ...after, isProspect }, current.customFields);
  const sentSalesperson = await resolveDefaultSalesperson(tx, input.defaultSalespersonId, current.defaultSalespersonId);
  const beforeCustomer = customerDetailsOf(current);
  const customer = await resolveCustomerDetails(tx, input, beforeCustomer, { contactId: current.id, isCustomer: after.isCustomer });
  const supplierPaymentTermId = await resolveSupplierPaymentTerm(tx, input.supplierPaymentTermId, current.supplierPaymentTermId, { isSupplier: after.isSupplier });

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of DETAIL_FIELDS) {
    if (before[field] !== after[field]) {
      changes[field] = { from: before[field], to: after[field] };
    }
  }
  // Custom field changes are in the history too (CF3).
  if (customValuesKey(current.customFields) !== customValuesKey(customFields)) {
    changes.customFields = { from: current.customFields, to: customFields };
  }
  const nextSalesperson = sentSalesperson === undefined ? current.defaultSalespersonId : sentSalesperson;
  if (isProspect !== current.isProspect) {
    changes.isProspect = { from: current.isProspect, to: isProspect };
  }
  if (nextSalesperson !== current.defaultSalespersonId) {
    changes.defaultSalespersonId = { from: current.defaultSalespersonId, to: nextSalesperson };
  }
  for (const field of CUSTOMER_DETAIL_FIELDS) {
    if (beforeCustomer[field] !== customer[field]) {
      changes[field] = { from: beforeCustomer[field], to: customer[field] };
    }
  }
  if (supplierPaymentTermId !== current.supplierPaymentTermId) {
    changes.supplierPaymentTermId = { from: current.supplierPaymentTermId, to: supplierPaymentTermId };
  }
  const sentCurrency = parseContactCurrency(tx, input.currencyCode);
  const nextCurrency = sentCurrency === undefined ? current.currencyCode : sentCurrency;
  if (nextCurrency !== current.currencyCode) {
    await assertCurrencyCanChange(tx, current);
    changes.currencyCode = { from: current.currencyCode ?? tx.baseCurrency, to: nextCurrency ?? tx.baseCurrency };
  }
  const billingCountry = parseCountry(input.billingCountry, "Billing country", HOME_COUNTRY) ?? current.billingCountry;
  if (billingCountry !== current.billingCountry) changes.billingCountry = { from: current.billingCountry, to: billingCountry };
  const sentDelivery = parseCountry(input.deliveryCountry, "Delivery country", null);
  const deliveryCountry = sentDelivery === undefined ? current.deliveryCountry : sentDelivery;
  if (deliveryCountry !== current.deliveryCountry) changes.deliveryCountry = { from: current.deliveryCountry, to: deliveryCountry };
  const sentSalesTax = await resolveDefaultTaxCode(tx, input.defaultSalesTaxCode, current.defaultSalesTaxCode);
  const salesTaxCode = sentSalesTax === undefined ? current.defaultSalesTaxCode : (sentSalesTax?.code ?? null);
  if (salesTaxCode !== current.defaultSalesTaxCode) changes.defaultSalesTaxCode = { from: current.defaultSalesTaxCode, to: salesTaxCode };
  const sentPurchaseTax = await resolveDefaultTaxCode(tx, input.defaultPurchaseTaxCode, current.defaultPurchaseTaxCode, "purchase");
  const purchaseTaxCode = sentPurchaseTax === undefined ? current.defaultPurchaseTaxCode : (sentPurchaseTax?.code ?? null);
  if (purchaseTaxCode !== current.defaultPurchaseTaxCode) {
    changes.defaultPurchaseTaxCode = { from: current.defaultPurchaseTaxCode, to: purchaseTaxCode };
  }
  // The CRM record type and owner (CRT5, CRT8).
  const recordType = await chooseRecordType(tx, "contact", input.recordTypeId, current.recordTypeId);
  if (recordType.id !== current.recordTypeId) changes.recordType = { from: current.recordTypeName, to: recordType.name };
  const ownerUserId = input.ownerUserId === undefined ? current.ownerUserId : await parseOwner(tx, input.ownerUserId);
  if (ownerUserId !== current.ownerUserId) changes.ownerUserId = { from: current.ownerUserId, to: ownerUserId };
  Object.assign(changes, await saveContactDefaults(tx, current.id, input, current));
  if (Object.keys(changes).length === 0) {
    return current;
  }
  const ctx = await loadCustomFieldContext(tx);
  const uses = contactUses({ ...after, isProspect });
  await checkAgainstLayout(tx, {
    record: "contact",
    type: recordType,
    values: contactLayoutValues({ ...after, deliveryAddress: customer.deliveryAddress, ownerUserId }, customFields),
    before: {
      type: recordType.id === current.recordTypeId ? recordType : await getRecordType(tx, current.recordTypeId),
      values: contactLayoutValues(current, current.customFields),
    },
    role: options.role,
    ctx,
    applies: contactFieldApplies(ctx, uses),
    standardApplies: (key) => standardFieldApplies("contact", key, after),
  });
  if (!current.isArchived && changes.name) {
    const clash = await activeNameClash(tx, after.name, current.id);
    if (clash) {
      throw nameTaken(clash);
    }
  }

  let row: ContactRow;
  try {
    await tx.query(
      `update contacts
          set name = $2, is_customer = $3, is_supplier = $4, email = $5, phone = $6,
              postal_address = $7, gst_number = $8, custom_fields = $9::jsonb, default_salesperson_id = $10, is_prospect = $11,
              delivery_address = $12, payment_term_id = $13, credit_limit = $14::numeric, customer_group_id = $15,
              price_level_id = $16, parent_contact_id = $17, supplier_payment_term_id = $18, currency_code = $19,
              billing_country = $20, delivery_country = $21,
              default_sales_tax_code_id = case when $22::boolean then $23::bigint else default_sales_tax_code_id end,
              default_purchase_tax_code_id = case when $24::boolean then $25::bigint else default_purchase_tax_code_id end,
              record_type_id = $26, owner_user_id = $27, updated_at = now()
        where id = $1`,
      [
        current.id,
        after.name,
        after.isCustomer,
        after.isSupplier,
        after.email,
        after.phone,
        after.postalAddress,
        after.gstNumber,
        JSON.stringify(customFields),
        nextSalesperson,
        isProspect,
        customer.deliveryAddress,
        customer.paymentTermId,
        customer.creditLimit,
        customer.customerGroupId,
        customer.priceLevelId,
        customer.parentContactId,
        supplierPaymentTermId,
        nextCurrency,
        billingCountry,
        deliveryCountry,
        sentSalesTax !== undefined,
        sentSalesTax?.id ?? null,
        sentPurchaseTax !== undefined,
        sentPurchaseTax?.id ?? null,
        recordType.id,
        ownerUserId,
      ],
    );
    row = await readRow(tx, current.id);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw nameTaken(after.name);
    }
    throw hierarchyError(error) ?? error;
  }
  await writeAuditEvent(tx, {
    eventType: "contact.updated",
    entityType: "contact",
    entityId: current.id,
    details: { changes },
  });
  return toContact(row);
}

async function setArchived(tx: OrgTx, contactIdInput: unknown, archived: boolean): Promise<Contact> {
  const current = await lockContact(tx, contactIdInput);
  if (current.isArchived === archived) {
    return current;
  }
  const refuseUnarchive = (clash: string) =>
    new ConflictError(
      `Can't unarchive "${current.name}": there's already an active contact called "${clash}". Rename one of them first.`,
    );
  if (!archived) {
    const clash = await activeNameClash(tx, current.name, current.id);
    if (clash) {
      throw refuseUnarchive(clash);
    }
  }

  let row: ContactRow;
  try {
    await tx.query(`update contacts set is_archived = $2, updated_at = now() where id = $1`, [current.id, archived]);
    row = await readRow(tx, current.id);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw refuseUnarchive(current.name);
    }
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: archived ? "contact.archived" : "contact.unarchived",
    entityType: "contact",
    entityId: current.id,
    details: { name: current.name },
  });
  return toContact(row);
}

export function archiveContact(tx: OrgTx, contactIdInput: unknown): Promise<Contact> {
  return setArchived(tx, contactIdInput, true);
}

/** Refused while another active contact has the same name. */
export function unarchiveContact(tx: OrgTx, contactIdInput: unknown): Promise<Contact> {
  return setArchived(tx, contactIdInput, false);
}

/** The defaults as sent, for the request hash; values not sent stay out, so older requests hash the same. */
function defaultsForHash(input: ContactDefaultsInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["defaultPurchaseAccountCode", "defaultSalesAccountCode", "defaultPurchaseTracking", "defaultSalesTracking"] as const) {
    const value = input[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "object" && Object.keys(value as object).length === 0) continue;
    out[key] = value;
  }
  return out;
}
