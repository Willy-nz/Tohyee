import { writeAuditEvent } from "@/lib/audit";
import { createContact, updateContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeLog } from "@/lib/sales-platforms/log";
import {
  CUSTOMER_MATCH_RESOLUTIONS,
  type CustomerMatch,
  SALES_PLATFORM_LABELS,
  type SalesPlatform,
} from "@/lib/sales-platforms/types";
import { asRecord, optionalString, requireId, requireOneOf, requireString } from "@/lib/validation";

/**
 * Same-name customers to check (#539, decisions 1269-1272, examples
 * SPC35-SPC37). When a store's customer has no email match and an active
 * contact already has the same name, the sync doesn't guess: it skips the
 * customer and keeps what the store said here. An admin then says either
 *
 * - **same person**: the customer is linked to that contact (only if the
 *   contact isn't archived or already linked to another of the store's
 *   customers). Nothing on the contact changes; later changes in the store
 *   are copied under the usual rules (SPC5), so the contact's own email is
 *   never replaced by the store's; or
 * - **different person**: a new contact is added for the customer, with a
 *   name that tells them apart (contact names are unique), and linked.
 *
 * Either way the sync log and audit trail say who decided, and the next
 * sync treats the customer as linked.
 */

/** The longest contact name (contacts/service.ts). */
const NAME_MAX = 150;
const LIST_LIMIT = 100;

export type MatchInput = {
  externalId: string;
  name: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  updatedAt: string | null;
  contactId: string;
};

/** Remembers (or refreshes) a customer to check. Called by the sync when it skips one for a same-name contact. */
export async function rememberCustomerMatch(tx: OrgTx, connectionId: string, match: MatchInput): Promise<void> {
  await tx.query(
    `insert into sales_platform_customer_matches (connection_id, external_id, name, email, phone, country, external_updated_at, contact_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (connection_id, external_id) do update
        set name = excluded.name, email = excluded.email, phone = excluded.phone, country = excluded.country,
            external_updated_at = excluded.external_updated_at, contact_id = excluded.contact_id, last_seen_at = now()`,
    [connectionId, match.externalId, match.name.slice(0, 500), match.email, match.phone?.slice(0, 100) ?? null, match.country, match.updatedAt, match.contactId],
  );
}

/** A customer that's now linked (by email, or after the name stopped clashing) has nothing left to check. */
export async function forgetCustomerMatch(tx: OrgTx, connectionId: string, externalId: string): Promise<void> {
  await tx.query("delete from sales_platform_customer_matches where connection_id = $1 and external_id = $2", [connectionId, externalId]);
}

/**
 * Why a customer with a same-name contact wasn't brought in (#539, decision
 * 1270). Neutral: it never suggests changing the contact's email, which
 * could link two different people.
 */
export function sameNameMessage(platform: string, customer: { name: string; email: string | null }, contactName: string): string {
  const who = customer.email ? `${customer.name} (${customer.email})` : customer.name;
  const why = customer.email
    ? `has the same name but a different email, so they may be different people`
    : `has the same name, and ${platform} has no email to tell whether they're the same person`;
  return `${platform} customer ${who} wasn't added: contact ${contactName} ${why}. Check who they are, then choose "Same person" or "Different person" under "Customers to check".`;
}

/**
 * Names to try for a different person's new contact, best first: the
 * store's name, then "(Shopify)", the email, or the store's customer
 * number, cut to fit 150 characters. Pure.
 */
export function separateNameCandidates(input: { name: string; email: string | null; platform: SalesPlatform; externalId: string }): string[] {
  const shop = SALES_PLATFORM_LABELS[input.platform];
  const base = input.name.trim().replace(/\s+/g, " ");
  const withSuffix = (suffix: string) => `${base.slice(0, Math.max(1, NAME_MAX - suffix.length - 3)).trimEnd()} (${suffix})`.slice(0, NAME_MAX);
  const suffixes = [shop, ...(input.email ? [input.email] : []), `${shop} ${input.externalId}`];
  return [...new Set(suffixes.map(withSuffix))];
}

async function takenNames(tx: OrgTx, names: string[]): Promise<Set<string>> {
  const result = await tx.query<{ name: string }>("select lower(name) as name from contacts where not is_archived and lower(name) = any($1::text[])", [
    names.map((name) => name.toLowerCase()),
  ]);
  return new Set(result.rows.map((row) => row.name));
}

/** The first candidate no active contact has; the last one (with the customer number) if all are taken. */
async function suggestName(tx: OrgTx, input: Parameters<typeof separateNameCandidates>[0]): Promise<string> {
  const candidates = separateNameCandidates(input);
  const taken = await takenNames(tx, candidates);
  return candidates.find((name) => !taken.has(name.toLowerCase())) ?? candidates[candidates.length - 1];
}

type ConnectionNow = { id: string; platform: SalesPlatform; status: string };

async function readConnection(tx: OrgTx, idInput: unknown, lock = false): Promise<ConnectionNow> {
  const id = requireId(idInput, "connectionId");
  const result = await tx.query<ConnectionNow>(`select id, platform, status from sales_platform_connections where id = $1${lock ? " for update" : ""}`, [id]);
  if (!result.rows[0]) throw new NotFoundError("That sales platform connection wasn't found.");
  return result.rows[0];
}

type MatchRow = {
  external_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  external_updated_at: string | null;
  contact_id: string;
  contact_name: string;
  contact_email: string | null;
  contact_phone: string | null;
  contact_archived: boolean;
  contact_linked_to: string | null;
  first_seen_at: string;
};

const MATCH_SELECT = `
  select m.external_id, m.name, m.email, m.phone, m.country, m.external_updated_at, m.contact_id::text as contact_id,
         c.name as contact_name, c.email as contact_email, c.phone as contact_phone, c.is_archived as contact_archived,
         (select o.external_id from sales_platform_mappings o
           where o.connection_id = m.connection_id and o.contact_id = m.contact_id and o.external_id <> m.external_id limit 1) as contact_linked_to,
         m.first_seen_at
    from sales_platform_customer_matches m
    join contacts c on c.id = m.contact_id`;

/** The customers to check, oldest first (viewers can read them, like the sync log). */
export async function listCustomerMatches(tx: OrgTx, connectionIdInput: unknown): Promise<{ matches: CustomerMatch[]; total: number }> {
  const connection = await readConnection(tx, connectionIdInput);
  const rows = await tx.query<MatchRow>(`${MATCH_SELECT} where m.connection_id = $1 order by m.first_seen_at, m.external_id limit ${LIST_LIMIT}`, [connection.id]);
  const total = await tx.query<{ n: string }>("select count(*)::text as n from sales_platform_customer_matches where connection_id = $1", [connection.id]);
  const matches: CustomerMatch[] = [];
  for (const row of rows.rows) {
    matches.push({
      externalId: row.external_id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      contactId: row.contact_id,
      contactName: row.contact_name,
      contactEmail: row.contact_email,
      contactPhone: row.contact_phone,
      contactArchived: row.contact_archived,
      contactLinkedTo: row.contact_linked_to,
      suggestedName: await suggestName(tx, { name: row.name, email: row.email, platform: connection.platform, externalId: row.external_id }),
      firstSeenAt: new Date(row.first_seen_at).toISOString(),
    });
  }
  return { matches, total: Number(total.rows[0].n) };
}

/** What the store last said, kept on the link so the next sync sees nothing new (SPC4) and copies only later changes (SPC5). */
function snapshotOf(row: MatchRow): Record<string, string | null> {
  return { name: row.name, email: row.email, phone: row.phone, ...(row.country ? { country: row.country } : {}) };
}

async function insertMapping(tx: OrgTx, connectionId: string, row: MatchRow, contactId: string): Promise<void> {
  await tx.query("savepoint sales_platform_match_link");
  try {
    await tx.query(
      `insert into sales_platform_mappings (connection_id, record_kind, external_id, contact_id, synced_values, external_updated_at)
       values ($1, 'customer', $2, $3, $4::jsonb, $5)`,
      [connectionId, row.external_id, contactId, JSON.stringify(snapshotOf(row)), row.external_updated_at],
    );
    await tx.query("release savepoint sales_platform_match_link");
  } catch (error) {
    await tx.query("rollback to savepoint sales_platform_match_link");
    // The unique links (one contact per store customer, one customer per contact) are the last word.
    if ((error as { code?: string }).code === "23505") {
      throw new ConflictError("That contact or customer was linked to something else meanwhile. Reload the page and check again.");
    }
    throw error;
  }
}

/**
 * Resolves one customer to check (admins). `resolution`: "same" links it
 * to the same-name contact, which `contactId` must name (so a stale page
 * can't link someone else); "different" adds a new contact under `name`
 * (or the suggested one).
 */
export async function resolveCustomerMatch(
  tx: OrgTx,
  connectionIdInput: unknown,
  body: Record<string, unknown>,
): Promise<{ resolution: "same" | "different"; contactId: string; contactName: string; message: string }> {
  const input = asRecord(body, "body");
  const connection = await readConnection(tx, connectionIdInput, true);
  if (connection.status === "disconnected") throw new ConflictError("This store is disconnected. Connect it again to bring its customers in.");
  const externalId = requireString(input.externalId, "externalId", { maxLength: 100 });
  const resolution = requireOneOf(input.resolution, "resolution", CUSTOMER_MATCH_RESOLUTIONS);
  const shop = SALES_PLATFORM_LABELS[connection.platform];
  const found = await tx.query<MatchRow>(`${MATCH_SELECT} where m.connection_id = $1 and m.external_id = $2 for update of m`, [connection.id, externalId]);
  const row = found.rows[0];
  if (!row) throw new NotFoundError(`${shop} customer ${externalId} has nothing left to check (it may have been sorted out already).`);
  const already = await tx.query("select 1 from sales_platform_mappings where connection_id = $1 and record_kind = 'customer' and external_id = $2", [
    connection.id,
    externalId,
  ]);
  if (already.rowCount) {
    await forgetCustomerMatch(tx, connection.id, externalId);
    throw new ConflictError(`${shop} customer ${row.name} is already linked to a contact.`);
  }
  const who = row.email ? `${row.name} (${row.email})` : row.name;

  if (resolution === "same") {
    const contactId = requireId(input.contactId, "contactId");
    if (contactId !== row.contact_id) throw new ConflictError(`Contact ${row.contact_name} is the one to confirm. Reload the page and check again.`);
    if (row.contact_archived) throw new ConflictError(`Contact ${row.contact_name} is archived, so it can't be linked. Restore it first, or add a new contact instead.`);
    if (row.contact_linked_to) {
      throw new ConflictError(
        `Contact ${row.contact_name} is already linked to ${shop} customer ${row.contact_linked_to}. One contact links to one ${shop} customer, so add a new contact instead.`,
      );
    }
    await insertMapping(tx, connection.id, row, contactId);
    // Marked as a customer, as a sync link does (SPC2); nothing else on the contact changes.
    const flags = await tx.query<{ is_customer: boolean }>("select is_customer from contacts where id = $1", [contactId]);
    if (!flags.rows[0]?.is_customer) await updateContact(tx, contactId, { isCustomer: true });
    await forgetCustomerMatch(tx, connection.id, externalId);
    const message = `Linked ${shop} customer ${who} to contact ${row.contact_name}: ${tx.actor.email} confirmed they're the same person. The contact's details weren't changed.`;
    await writeLog(tx, connection.id, { source: "connection", action: "linked", recordKind: "customer", externalId, contactId, message });
    await writeAuditEvent(tx, {
      eventType: "sales_platform.customer_linked",
      entityType: "sales_platform_connection",
      entityId: connection.id,
      details: { externalId, contactId, resolution: "same", contactEmailKept: row.contact_email !== null },
    });
    return { resolution, contactId, contactName: row.contact_name, message };
  }

  const typed = optionalString(input.name, "name", { maxLength: NAME_MAX })?.trim().replace(/\s+/g, " ");
  const name = typed || (await suggestName(tx, { name: row.name, email: row.email, platform: connection.platform, externalId }));
  if ((await takenNames(tx, [name])).size > 0) {
    throw new ValidationError(`There's already a contact called ${name}. Contact names are unique, so choose another name.`);
  }
  const { contact } = await createContact(tx, {
    idempotencyKey: `sp-${connection.id}-customer-${externalId}-separate`,
    source: "sales-platform",
    name,
    email: row.email,
    phone: row.phone,
    ...(row.country ? { billingCountry: row.country } : {}),
    isCustomer: true,
  });
  await insertMapping(tx, connection.id, row, contact.id);
  await forgetCustomerMatch(tx, connection.id, externalId);
  const message = `Added contact ${contact.name} for ${shop} customer ${who}: ${tx.actor.email} said they're not ${row.contact_name}.`;
  await writeLog(tx, connection.id, { source: "connection", action: "created", recordKind: "customer", externalId, contactId: contact.id, message });
  await writeAuditEvent(tx, {
    eventType: "sales_platform.customer_added_separately",
    entityType: "sales_platform_connection",
    entityId: connection.id,
    details: { externalId, contactId: contact.id, sameNameContactId: row.contact_id, resolution: "different" },
  });
  return { resolution, contactId: contact.id, contactName: contact.name, message };
}
