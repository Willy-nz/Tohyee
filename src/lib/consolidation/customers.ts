import { writeAdminAuditEvent } from "@/lib/audit";
import { type Role, roleAtLeast } from "@/lib/auth/roles";
import { type GroupUser, requireGroup, rolesOf } from "@/lib/consolidation/groups";
import { memberRecord, withSteward } from "@/lib/consolidation/steward";
import type { ConsolidationGroup } from "@/lib/consolidation/types";
import { invalidateGroupWorkspace } from "@/lib/consolidation/workspace-cache";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { withCoreTransaction } from "@/lib/db/transactions";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { asRecord, optionalString, requireArray, requireId, requireString } from "@/lib/validation";

/**
 * Customers across a group's organisations (decision 642; Codex, delegated
 * by owner, 20 October 2026). A group customer is a person's explicit link
 * between contacts in different member organisations, like NetSuite's
 * shared customers but without merging: each contact stays its own record
 * in its own organisation, and Tohyee never links two because their names
 * or emails match. Links are kept by the group's steward (decision 641);
 * names are read from each member each time, never copied.
 */

export type GroupCustomerLink = {
  id: string;
  organisationId: string;
  organisationName: string;
  contactId: string;
  /** Read from the member now; null when the contact can't be found there any more. */
  contactName: string | null;
  /** False once the organisation has left the group: shown, but left out of totals. */
  inGroup: boolean;
  linkedByEmail: string;
  linkedAt: string;
};

export type GroupCustomer = { id: string; name: string; createdByEmail: string; createdAt: string; links: GroupCustomerLink[] };

export type GroupCustomers = {
  customers: GroupCustomer[];
  /** Links to organisations that have left the group and that the person can't see: left out, and counted so nothing passes for complete. */
  hiddenLinks: number;
};

type CustomerRow = { id: string; name: string; created_by_email: string; created_at: string };
type LinkRow = { id: string; group_customer_id: string; organisation_id: string; contact_id: string; linked_by_email: string; linked_at: string };

async function contactNames(user: GroupUser, organisationId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const record = await memberRecord(organisationId);
  const found = await withOrganisationTransaction(
    record,
    { userId: user.id, email: user.email },
    (tx) => tx.query<{ id: string; name: string }>("select id::text, name from contacts where id = any($1::bigint[])", [ids]),
    { readOnly: true },
  );
  return new Map(found.rows.map((row) => [row.id, row.name]));
}

/** Who can see an organisation's figures: a viewer or above there (not a report viewer). */
export function sees(roles: Map<string, Role>, organisationId: string): boolean {
  const role = roles.get(organisationId);
  return role !== undefined && role !== "report_viewer" && roleAtLeast(role, "viewer");
}

/** A group's customers and their links, as the person may see them. */
export async function readGroupCustomers(user: GroupUser, group: ConsolidationGroup): Promise<GroupCustomers> {
  const { customers, links } = await withSteward(
    user,
    group,
    async (tx) => ({
      customers: (
        await tx.query<CustomerRow>(
          "select id::text, name, created_by_email, created_at from group_customers where group_id = $1 and removed_at is null order by lower(name), group_customers.id",
          [group.id],
        )
      ).rows,
      links: (
        await tx.query<LinkRow>(
          `select l.id::text, l.group_customer_id::text, l.organisation_id, l.contact_id::text, l.linked_by_email, l.linked_at
             from group_customer_links l where l.group_id = $1 and l.unlinked_at is null order by l.organisation_id, l.id`,
          [group.id],
        )
      ).rows,
    }),
    { readOnly: true },
  );
  const roles = await rolesOf(user.id);
  const current = new Map(group.members.map((member) => [member.organisationId, member.name]));
  const former = new Map(group.formerMembers.map((member) => [member.organisationId, member.name]));
  let hiddenLinks = 0;
  const visible = links.filter((link) => {
    if (current.has(link.organisation_id)) return true;
    if (former.has(link.organisation_id) && sees(roles, link.organisation_id)) return true;
    hiddenLinks += 1;
    return false;
  });
  const byOrganisation = new Map<string, string[]>();
  for (const link of visible) byOrganisation.set(link.organisation_id, [...(byOrganisation.get(link.organisation_id) ?? []), link.contact_id]);
  const names = new Map<string, Map<string, string>>();
  for (const [organisationId, ids] of byOrganisation) names.set(organisationId, await contactNames(user, organisationId, ids));
  return {
    hiddenLinks,
    customers: customers.map((row) => ({
      id: row.id,
      name: row.name,
      createdByEmail: row.created_by_email,
      createdAt: row.created_at,
      links: visible
        .filter((link) => link.group_customer_id === row.id)
        .map((link) => ({
          id: link.id,
          organisationId: link.organisation_id,
          organisationName: current.get(link.organisation_id) ?? former.get(link.organisation_id) ?? link.organisation_id,
          contactId: link.contact_id,
          contactName: names.get(link.organisation_id)?.get(link.contact_id) ?? null,
          inGroup: current.has(link.organisation_id),
          linkedByEmail: link.linked_by_email,
          linkedAt: link.linked_at,
        })),
    })),
  };
}

export async function listGroupCustomers(user: GroupUser, groupIdInput: unknown): Promise<GroupCustomers> {
  return readGroupCustomers(user, await requireGroup(user, groupIdInput));
}

type ParsedLink = { organisationId: string; contactId: string };

/** Checks each contact is in a member now and exists there. */
async function checkLinks(user: GroupUser, group: ConsolidationGroup, links: ParsedLink[]): Promise<void> {
  for (const link of links) {
    const member = group.members.find((item) => item.organisationId === link.organisationId);
    if (!member) throw new ValidationError("A linked contact must be in an organisation that's in the group now.");
    const names = await contactNames(user, link.organisationId, [link.contactId]);
    if (!names.has(link.contactId)) throw new ValidationError(`${member.name} has no such contact.`);
  }
}

function parseLink(entry: unknown, label: string): ParsedLink {
  const record = asRecord(entry, label);
  return { organisationId: requireString(record.organisationId, `${label}'s organisation`), contactId: requireId(record.contactId, `${label}'s contact`) };
}

function alreadyLinked(error: unknown): never {
  if ((error as { code?: string }).code === "23505") throw new ConflictError("That contact is already linked to a group customer. Unlink it there first.");
  throw error;
}

async function audit(user: GroupUser, group: ConsolidationGroup, eventType: string, details: Record<string, unknown>): Promise<void> {
  await withCoreTransaction((client) =>
    writeAdminAuditEvent(client, { userId: user.id, email: user.email }, { eventType, entityType: "consolidation_group", entityId: group.id, details }),
  );
}

/**
 * Makes a group customer from contacts in two or more member organisations
 * (`{ name, links: [{ organisationId, contactId }] }`). Bookkeepers or above
 * of every organisation in the group.
 */
export async function createGroupCustomer(user: GroupUser, groupIdInput: unknown, input: Record<string, unknown>): Promise<GroupCustomers> {
  const group = await requireGroup(user, groupIdInput, "bookkeeper");
  const name = requireString(input.name, "The name", { maxLength: 200 });
  const links = requireArray(input.links, "links", 50).map((entry, index) => parseLink(entry, `Link ${index + 1}`));
  if (new Set(links.map((link) => link.organisationId)).size < 2) throw new ValidationError("Link the customer's contact in at least two of the group's organisations.");
  if (new Set(links.map((link) => `${link.organisationId}|${link.contactId}`)).size !== links.length) throw new ValidationError("The same contact is in the list twice.");
  await checkLinks(user, group, links);
  await withSteward(user, group, async (tx) => {
    const made = await tx.query<{ id: string }>("insert into group_customers (group_id, name, created_by_email) values ($1, $2, $3) returning id::text", [group.id, name, user.email]);
    for (const link of links) {
      await tx
        .query("insert into group_customer_links (group_id, group_customer_id, organisation_id, contact_id, linked_by_email) values ($1, $2, $3, $4, $5)", [
          group.id,
          made.rows[0].id,
          link.organisationId,
          link.contactId,
          user.email,
        ])
        .catch(alreadyLinked);
    }
  });
  await audit(user, group, "consolidation_group.customer_linked", { name, links });
  invalidateGroupWorkspace(group.id);
  return readGroupCustomers(user, group);
}

/** Links one more contact to a group customer. Bookkeepers or above of every organisation. */
export async function addGroupCustomerLink(user: GroupUser, groupIdInput: unknown, customerIdInput: unknown, input: Record<string, unknown>): Promise<GroupCustomers> {
  const group = await requireGroup(user, groupIdInput, "bookkeeper");
  const customerId = requireId(customerIdInput, "customerId");
  const link = parseLink(input, "The link");
  await checkLinks(user, group, [link]);
  await withSteward(user, group, async (tx) => {
    const found = await tx.query("select 1 from group_customers where id = $1 and group_id = $2 and removed_at is null", [customerId, group.id]);
    if (found.rowCount === 0) throw new NotFoundError("Group customer not found.");
    await tx
      .query("insert into group_customer_links (group_id, group_customer_id, organisation_id, contact_id, linked_by_email) values ($1, $2, $3, $4, $5)", [
        group.id,
        customerId,
        link.organisationId,
        link.contactId,
        user.email,
      ])
      .catch(alreadyLinked);
  });
  await audit(user, group, "consolidation_group.customer_linked", { customerId, links: [link] });
  invalidateGroupWorkspace(group.id);
  return readGroupCustomers(user, group);
}

/** Unlinks a contact (kept, with who unlinked it). The contact itself is untouched. Bookkeepers or above of every organisation. */
export async function removeGroupCustomerLink(user: GroupUser, groupIdInput: unknown, customerIdInput: unknown, linkIdInput: unknown): Promise<GroupCustomers> {
  const group = await requireGroup(user, groupIdInput, "bookkeeper");
  const customerId = requireId(customerIdInput, "customerId");
  const linkId = requireId(linkIdInput, "linkId");
  await withSteward(user, group, async (tx) => {
    const updated = await tx.query(
      "update group_customer_links set unlinked_at = now(), unlinked_by_email = $4 where id = $1 and group_customer_id = $2 and group_id = $3 and unlinked_at is null",
      [linkId, customerId, group.id, user.email],
    );
    if (updated.rowCount === 0) throw new NotFoundError("Link not found.");
    const left = await tx.query("select 1 from group_customer_links where group_customer_id = $1 and unlinked_at is null", [customerId]);
    if (left.rowCount === 0) await tx.query("update group_customers set removed_at = now(), removed_by_email = $2 where id = $1", [customerId, user.email]);
  });
  await audit(user, group, "consolidation_group.customer_unlinked", { customerId, linkId });
  invalidateGroupWorkspace(group.id);
  return readGroupCustomers(user, group);
}

export type LinkableContact = { id: string; name: string; email: string | null; linkedTo: string | null };

/**
 * Contacts in one member to choose from when linking, by name or email.
 * Nothing is suggested from another organisation: the person searches and
 * picks (no automatic matching, decision 642).
 */
export async function searchMemberContacts(user: GroupUser, groupIdInput: unknown, input: { organisationId?: unknown; q?: unknown }): Promise<LinkableContact[]> {
  const group = await requireGroup(user, groupIdInput);
  const organisationId = requireString(input.organisationId, "The organisation");
  if (!group.members.some((member) => member.organisationId === organisationId)) throw new ValidationError("That organisation isn't in the group now.");
  const q = optionalString(input.q, "The search", { maxLength: 100 }) ?? "";
  const record = await memberRecord(organisationId);
  const found = await withOrganisationTransaction(
    record,
    { userId: user.id, email: user.email },
    (tx) =>
      tx.query<{ id: string; name: string; email: string | null }>(
        `select id::text, name, email from contacts where not is_archived and ($1 = '' or name ilike '%' || $1 || '%' or email ilike '%' || $1 || '%')
          order by lower(name), contacts.id limit 20`,
        [q],
      ),
    { readOnly: true },
  );
  const linked = await withSteward(
    user,
    group,
    (tx) =>
      tx.query<{ contact_id: string; name: string }>(
        `select l.contact_id::text, c.name from group_customer_links l join group_customers c on c.id = l.group_customer_id
          where l.group_id = $1 and l.organisation_id = $2 and l.unlinked_at is null`,
        [group.id, organisationId],
      ),
    { readOnly: true },
  );
  const linkedTo = new Map(linked.rows.map((row) => [row.contact_id, row.name]));
  return found.rows.map((row) => ({ id: row.id, name: row.name, email: row.email, linkedTo: linkedTo.get(row.id) ?? null }));
}
