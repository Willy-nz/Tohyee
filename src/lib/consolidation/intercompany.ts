import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { asRecord, requireArray, requireId, requireString } from "@/lib/validation";

/**
 * Intercompany settings in one organisation (CO2, decision 440), like
 * NetSuite's "Eliminate Intercompany Transactions" accounts and its
 * intercompany customers and vendors: the accounts that hold amounts with
 * another organisation in a consolidation group, and the contact that
 * stands for each other organisation (what's owed between them in
 * receivables and payables). Admins change them; anyone can see them.
 */

export type IntercompanySettings = {
  accounts: { accountId: string; code: string; name: string; counterpartOrganisationId: string }[];
  contacts: { contactId: string; name: string; counterpartOrganisationId: string }[];
};

export async function getIntercompany(tx: OrgTx): Promise<IntercompanySettings> {
  const accounts = await tx.query<{ account_id: string; code: string; name: string; counterpart_organisation_id: string }>(
    `select i.account_id::text, a.code, a.name, i.counterpart_organisation_id from intercompany_accounts i join accounts a on a.id = i.account_id order by a.code`,
  );
  const contacts = await tx.query<{ contact_id: string; name: string; counterpart_organisation_id: string }>(
    `select i.contact_id::text, c.name, i.counterpart_organisation_id from intercompany_contacts i join contacts c on c.id = i.contact_id order by c.name`,
  );
  return {
    accounts: accounts.rows.map((row) => ({ accountId: row.account_id, code: row.code, name: row.name, counterpartOrganisationId: row.counterpart_organisation_id })),
    contacts: contacts.rows.map((row) => ({ contactId: row.contact_id, name: row.name, counterpartOrganisationId: row.counterpart_organisation_id })),
  };
}

/**
 * Replaces them. The other organisation is named by its id on this server
 * and can't be this one. Bank, receivable and payable accounts aren't
 * marked: what's owed between members is found from the linked contacts.
 */
export async function setIntercompany(tx: OrgTx, input: { accounts?: unknown; contacts?: unknown }): Promise<IntercompanySettings> {
  const accounts = requireArray(input.accounts ?? [], "accounts", 200).map((raw, index) => {
    const entry = asRecord(raw, `Account ${index + 1}`);
    return { accountId: requireId(entry.accountId, "accountId"), counterpart: requireString(entry.counterpartOrganisationId, "The other organisation", { maxLength: 100 }) };
  });
  const contacts = requireArray(input.contacts ?? [], "contacts", 200).map((raw, index) => {
    const entry = asRecord(raw, `Contact ${index + 1}`);
    return { contactId: requireId(entry.contactId, "contactId"), counterpart: requireString(entry.counterpartOrganisationId, "The other organisation", { maxLength: 100 }) };
  });
  for (const entry of [...accounts, ...contacts]) {
    if (entry.counterpart === tx.organisationId) throw new ValidationError("An intercompany account or contact is with another organisation, not this one.");
  }
  if (new Set(accounts.map((entry) => entry.accountId)).size !== accounts.length) throw new ValidationError("An account is marked once.");
  if (new Set(contacts.map((entry) => entry.counterpart)).size !== contacts.length) throw new ValidationError("Link one contact to each other organisation.");
  for (const entry of accounts) {
    const found = await tx.query<{ code: string; account_type: string; system_key: string | null }>("select code, account_type, system_key from accounts where id = $1", [entry.accountId]);
    const account = found.rows[0];
    if (!account) throw new ValidationError("That account wasn't found.");
    if (account.account_type === "bank" || account.account_type === "credit_card" || ["accounts_receivable", "accounts_payable"].includes(account.system_key ?? "")) {
      throw new ValidationError(`${account.code} can't be an intercompany account: what's owed between organisations in receivables and payables comes from the linked contacts.`);
    }
  }
  for (const entry of contacts) {
    const found = await tx.query("select 1 from contacts where id = $1", [entry.contactId]);
    if ((found.rowCount ?? 0) === 0) throw new ValidationError("That contact wasn't found.");
  }
  const before = await getIntercompany(tx);
  await tx.query("delete from intercompany_accounts");
  await tx.query("delete from intercompany_contacts");
  for (const entry of accounts) {
    await tx.query("insert into intercompany_accounts (account_id, counterpart_organisation_id, updated_by_email) values ($1, $2, $3)", [entry.accountId, entry.counterpart, tx.actor.email]);
  }
  for (const entry of contacts) {
    await tx.query("insert into intercompany_contacts (contact_id, counterpart_organisation_id, updated_by_email) values ($1, $2, $3)", [entry.contactId, entry.counterpart, tx.actor.email]);
  }
  const after = await getIntercompany(tx);
  await writeAuditEvent(tx, {
    eventType: "intercompany.updated",
    entityType: "intercompany",
    entityId: "1",
    details: {
      before: { accounts: before.accounts.map((entry) => `${entry.code}:${entry.counterpartOrganisationId}`), contacts: before.contacts.map((entry) => `${entry.name}:${entry.counterpartOrganisationId}`) },
      after: { accounts: after.accounts.map((entry) => `${entry.code}:${entry.counterpartOrganisationId}`), contacts: after.contacts.map((entry) => `${entry.name}:${entry.counterpartOrganisationId}`) },
    },
  });
  return after;
}
