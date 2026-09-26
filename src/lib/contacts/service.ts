import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
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
 * Customers and suppliers. Invoices and bills will use them later; for now
 * they're a list the organisation keeps. Contacts are archived, never deleted.
 */
export type Contact = {
  id: string;
  name: string;
  isCustomer: boolean;
  isSupplier: boolean;
  email: string | null;
  phone: string | null;
  postalAddress: string | null;
  /** Digits only, e.g. "123456789". */
  gstNumber: string | null;
  isArchived: boolean;
};

/** The details a person enters. An edit leaves out anything it doesn't change. */
export type ContactInput = {
  name?: unknown;
  isCustomer?: unknown;
  isSupplier?: unknown;
  email?: unknown;
  phone?: unknown;
  postalAddress?: unknown;
  gstNumber?: unknown;
};

type ContactDetails = Omit<Contact, "id" | "isArchived">;

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
  is_archived: boolean;
};

const COLUMNS =
  "id, request_hash, name, is_customer, is_supplier, email, phone, postal_address, gst_number, is_archived";

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
    isArchived: row.is_archived,
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

function assertCustomerOrSupplier(details: ContactDetails): ContactDetails {
  if (!details.isCustomer && !details.isSupplier) {
    throw new ValidationError("A contact must be a customer, a supplier or both.");
  }
  return details;
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
): Promise<{ created: boolean; contact: Contact }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const details = assertCustomerOrSupplier({
    name: parseName(input.name),
    isCustomer: optionalBoolean(input.isCustomer, "isCustomer") ?? false,
    isSupplier: optionalBoolean(input.isSupplier, "isSupplier") ?? false,
    email: parseEmail(input.email),
    phone: parsePhone(input.phone),
    postalAddress: parsePostalAddress(input.postalAddress),
    gstNumber: parseGstNumber(input.gstNumber),
  });

  const hash = requestHash("contact", details);
  const existing = await findByKey(tx, source, idempotencyKey);
  if (existing) {
    assertSameRequest(existing.request_hash, hash, "contact");
    return { created: false, contact: toContact(existing) };
  }

  // No separate name check first: the original of a retry could commit between
  // it and the key check above. The unique indexes decide, and the key is
  // checked again before a name clash is reported.
  const inserted = await tx.query<ContactRow>(
    `insert into contacts (command_source, idempotency_key, request_hash, name, is_customer, is_supplier,
                           email, phone, postal_address, gst_number)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict do nothing
     returning ${COLUMNS}`,
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
    ],
  );
  const row = inserted.rows[0];
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
    details,
  });
  return { created: true, contact: toContact(row) };
}

/**
 * Changes the fields that are sent; a blank optional field is cleared. An
 * edit that changes nothing isn't saved or audited.
 */
export async function updateContact(tx: OrgTx, contactIdInput: unknown, input: ContactInput): Promise<Contact> {
  const current = await lockContact(tx, contactIdInput);
  const before = detailsOf(current);
  const after = assertCustomerOrSupplier({
    name: input.name === undefined ? before.name : parseName(input.name),
    isCustomer: optionalBoolean(input.isCustomer, "isCustomer") ?? before.isCustomer,
    isSupplier: optionalBoolean(input.isSupplier, "isSupplier") ?? before.isSupplier,
    email: input.email === undefined ? before.email : parseEmail(input.email),
    phone: input.phone === undefined ? before.phone : parsePhone(input.phone),
    postalAddress:
      input.postalAddress === undefined ? before.postalAddress : parsePostalAddress(input.postalAddress),
    gstNumber: input.gstNumber === undefined ? before.gstNumber : parseGstNumber(input.gstNumber),
  });

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of DETAIL_FIELDS) {
    if (before[field] !== after[field]) {
      changes[field] = { from: before[field], to: after[field] };
    }
  }
  if (Object.keys(changes).length === 0) {
    return current;
  }
  if (!current.isArchived && changes.name) {
    const clash = await activeNameClash(tx, after.name, current.id);
    if (clash) {
      throw nameTaken(clash);
    }
  }

  let row: ContactRow;
  try {
    const updated = await tx.query<ContactRow>(
      `update contacts
          set name = $2, is_customer = $3, is_supplier = $4, email = $5, phone = $6,
              postal_address = $7, gst_number = $8, updated_at = now()
        where id = $1
        returning ${COLUMNS}`,
      [
        current.id,
        after.name,
        after.isCustomer,
        after.isSupplier,
        after.email,
        after.phone,
        after.postalAddress,
        after.gstNumber,
      ],
    );
    row = updated.rows[0];
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw nameTaken(after.name);
    }
    throw error;
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
    const updated = await tx.query<ContactRow>(
      `update contacts set is_archived = $2, updated_at = now() where id = $1 returning ${COLUMNS}`,
      [current.id, archived],
    );
    row = updated.rows[0];
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
