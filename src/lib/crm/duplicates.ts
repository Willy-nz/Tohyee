import { writeAuditEvent } from "@/lib/audit";
import type { CrmScope } from "@/lib/crm/access";
import { leadScopeSql } from "@/lib/crm/leads";
import { requireCrm } from "@/lib/crm/switch";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { optionalString, requireId, requireOneOf } from "@/lib/validation";

/**
 * Duplicate companies and people (decision 494, #216; Jess 10 Oct 2026:
 * "merge CRM-only; link if invoiced").
 *
 * Suggestions: companies whose names match once case, punctuation and
 * endings like "Ltd" are ignored, or that share an email address or a phone
 * number; people with the same email, or the same name at the same company.
 * Archived, merged and reviewed pairs aren't suggested.
 *
 * Merging a company moves its people, deals, tasks, activities, converted
 * leads and email links to the one kept, fills the kept one's empty email,
 * phone and address from it, and archives it pointing at the one kept; its
 * notes, files and history stay on it. Only a company with nothing in the
 * books (no invoices, bills, payments, orders, quotes, rules or anything
 * else that refers to it outside the CRM) can be merged away; when both have
 * records they can only be marked as the same customer. People merge the
 * same way within their company.
 */

/** The CRM's own references to a company, moved by a merge; any other reference is the books' and stops it. */
const COMPANY_MOVABLE = new Set([
  "crm_people.contact_id",
  "crm_opportunities.contact_id",
  "crm_tasks.contact_id",
  "crm_activities.contact_id",
  "crm_leads.converted_contact_id",
  "crm_participant_links.contact_id",
  "contacts.merged_into_contact_id",
  "crm_sent_emails.contact_id",
]);
const PERSON_MOVABLE = new Set([
  "crm_opportunities.point_of_contact_id",
  "crm_tasks.person_id",
  "crm_activities.person_id",
  "crm_leads.converted_person_id",
  "crm_participant_links.person_id",
  "crm_people.merged_into_person_id",
  "crm_sent_emails.person_id",
]);

export type DuplicateRecord = "company" | "person";

export type DuplicatePair = {
  record: DuplicateRecord;
  first: { id: string; name: string; detail: string | null; hasBooks: boolean };
  second: { id: string; name: string; detail: string | null; hasBooks: boolean };
  /** Why they look alike: "name", "email" or "phone". */
  reason: string;
  /** False when both have accounting records (companies) or they're at different companies (people). */
  canMerge: boolean;
};

/** "Kea Pets Ltd." and "kea pets limited" → "keapets". */
export function companyKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(ltd|limited|nz|new zealand|co|company|inc|incorporated|the|trust|llc|pty)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}

function phoneKey(phone: string | null): string | null {
  const digits = (phone ?? "").replace(/\D+/g, "").replace(/^64/, "0");
  return digits.length >= 7 ? digits : null;
}

/** The references to one row outside the CRM: table.column → how many. */
async function outsideReferences(tx: OrgTx, table: "contacts" | "crm_people", id: string, movable: Set<string>): Promise<string[]> {
  const columns = await tx.query<{ tbl: string; col: string }>(
    `select c.conrelid::regclass::text as tbl, a.attname as col
       from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      where c.contype = 'f' and c.confrelid = $1::regclass
      order by 1, 2`,
    [table],
  );
  const found: string[] = [];
  for (const { tbl, col } of columns.rows) {
    if (movable.has(`${tbl}.${col}`)) continue;
    if (!/^[a-z_][a-z0-9_]*$/.test(tbl) || !/^[a-z_][a-z0-9_]*$/.test(col)) continue;
    const used = await tx.query(`select 1 from ${tbl} where ${col} = $1 limit 1`, [id]);
    if ((used.rowCount ?? 0) > 0) found.push(tbl);
  }
  return found;
}

async function hasBooks(tx: OrgTx, contactId: string): Promise<boolean> {
  return (await outsideReferences(tx, "contacts", contactId, COMPANY_MOVABLE)).length > 0;
}

function ordered(a: string, b: string): [string, string] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

async function reviewed(tx: OrgTx, record: DuplicateRecord): Promise<Set<string>> {
  const rows = await tx.query<{ first_id: string; second_id: string }>(
    "select first_id::text, second_id::text from crm_duplicate_reviews where record = $1",
    [record],
  );
  return new Set(rows.rows.map((row) => `${row.first_id}:${row.second_id}`));
}

/** Likely duplicate companies and people, at most `limit` pairs of each. */
export async function listDuplicates(tx: OrgTx, options: { limit?: number } = {}): Promise<DuplicatePair[]> {
  const limit = options.limit ?? 100;
  const pairs: DuplicatePair[] = [];

  const companies = await tx.query<{ id: string; name: string; email: string | null; phone: string | null }>(
    "select id::text, name, email, phone from contacts where not is_archived and merged_into_contact_id is null order by contacts.id",
  );
  const skipCompanies = await reviewed(tx, "company");
  const booksCache = new Map<string, boolean>();
  const books = async (id: string) => {
    if (!booksCache.has(id)) booksCache.set(id, await hasBooks(tx, id));
    return booksCache.get(id)!;
  };
  const seen = new Set<string>();
  const groups = new Map<string, typeof companies.rows>();
  for (const row of companies.rows) {
    const keys = [
      ["name", companyKey(row.name)],
      ["email", row.email?.trim().toLowerCase() || ""],
      ["phone", phoneKey(row.phone) ?? ""],
    ];
    for (const [reason, value] of keys) {
      if (!value || (reason === "name" && value.length < 3)) continue;
      const key = `${reason}:${value}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
  }
  for (const [key, rows] of groups) {
    if (rows.length < 2) continue;
    const reason = key.split(":")[0];
    for (let i = 0; i < rows.length && pairs.length < limit; i += 1) {
      for (let j = i + 1; j < rows.length && pairs.length < limit; j += 1) {
        const [firstId, secondId] = ordered(rows[i].id, rows[j].id);
        const pairKey = `${firstId}:${secondId}`;
        if (seen.has(pairKey) || skipCompanies.has(pairKey)) continue;
        seen.add(pairKey);
        const byId = new Map(rows.map((row) => [row.id, row]));
        const first = byId.get(firstId)!;
        const second = byId.get(secondId)!;
        const firstBooks = await books(firstId);
        const secondBooks = await books(secondId);
        pairs.push({
          record: "company",
          first: { id: firstId, name: first.name, detail: first.email ?? first.phone, hasBooks: firstBooks },
          second: { id: secondId, name: second.name, detail: second.email ?? second.phone, hasBooks: secondBooks },
          reason,
          canMerge: !(firstBooks && secondBooks),
        });
      }
    }
  }

  const people = await tx.query<{ id: string; name: string; email: string | null; contact_id: string | null; company: string | null }>(
    `select p.id::text, concat_ws(' ', p.first_name, p.last_name) as name, p.email, p.contact_id::text, c.name as company
       from crm_people p left join contacts c on c.id = p.contact_id
      where not p.is_archived and p.merged_into_person_id is null
      order by p.id`,
  );
  const skipPeople = await reviewed(tx, "person");
  const personGroups = new Map<string, typeof people.rows>();
  for (const row of people.rows) {
    const keys: Array<[string, string]> = [["email", row.email?.trim().toLowerCase() || ""]];
    if (row.contact_id) keys.push(["name", `${row.contact_id}|${row.name.trim().toLowerCase().replace(/\s+/g, " ")}`]);
    for (const [reason, value] of keys) {
      if (!value) continue;
      const key = `${reason}:${value}`;
      personGroups.set(key, [...(personGroups.get(key) ?? []), row]);
    }
  }
  const seenPeople = new Set<string>();
  let personPairs = 0;
  for (const [key, rows] of personGroups) {
    if (rows.length < 2) continue;
    const reason = key.split(":")[0];
    for (let i = 0; i < rows.length && personPairs < limit; i += 1) {
      for (let j = i + 1; j < rows.length && personPairs < limit; j += 1) {
        const [firstId, secondId] = ordered(rows[i].id, rows[j].id);
        const pairKey = `${firstId}:${secondId}`;
        if (seenPeople.has(pairKey) || skipPeople.has(pairKey)) continue;
        seenPeople.add(pairKey);
        const byId = new Map(rows.map((row) => [row.id, row]));
        const first = byId.get(firstId)!;
        const second = byId.get(secondId)!;
        personPairs += 1;
        pairs.push({
          record: "person",
          first: { id: firstId, name: first.name, detail: [first.company, first.email].filter(Boolean).join(" · ") || null, hasBooks: false },
          second: { id: secondId, name: second.name, detail: [second.company, second.email].filter(Boolean).join(" · ") || null, hasBooks: false },
          reason,
          // People at two different companies are linked, not merged.
          canMerge: first.contact_id === second.contact_id,
        });
      }
    }
  }
  return pairs;
}

/** Companies, people and open leads like the one being added: shown before saving (decision 494). */
export async function similarRecords(
  tx: OrgTx,
  input: { name?: unknown; email?: unknown; phone?: unknown },
  scope?: CrmScope,
): Promise<{ companies: Array<{ id: string; name: string; reason: string }>; people: Array<{ id: string; name: string; company: string | null }>; leads: Array<{ id: string; name: string }> }> {
  const name = optionalString(input.name, "name", { maxLength: 200 });
  const email = optionalString(input.email, "email", { maxLength: 254 })?.toLowerCase() ?? null;
  const phone = phoneKey(optionalString(input.phone, "phone", { maxLength: 50 }));
  const key = name ? companyKey(name) : "";
  const companies: Array<{ id: string; name: string; reason: string }> = [];
  if (key.length >= 3 || email || phone) {
    const rows = await tx.query<{ id: string; name: string; email: string | null; phone: string | null }>(
      "select id::text, name, email, phone from contacts where not is_archived order by contacts.id",
    );
    for (const row of rows.rows) {
      const reason =
        key.length >= 3 && companyKey(row.name) === key
          ? "name"
          : email && row.email?.toLowerCase() === email
            ? "email"
            : phone && phoneKey(row.phone) === phone
              ? "phone"
              : null;
      if (reason) companies.push({ id: row.id, name: row.name, reason });
      if (companies.length >= 10) break;
    }
  }
  const people = email
    ? (
        await tx.query<{ id: string; name: string; company: string | null }>(
          `select p.id::text, concat_ws(' ', p.first_name, p.last_name) as name, c.name as company
             from crm_people p left join contacts c on c.id = p.contact_id
            where not p.is_archived and lower(p.email) = $1 order by p.id limit 10`,
          [email],
        )
      ).rows
    : [];
  // Only leads this person can see (decision 491): a rep isn't told about another rep's.
  const leadParams: unknown[] = [email];
  const leadScope = leadScopeSql(scope, leadParams);
  const leads = email
    ? (
        await tx.query<{ id: string; name: string }>(
          `select l.id::text, coalesce(nullif(concat_ws(' ', l.first_name, l.last_name), ''), l.company_name, l.email) as name
             from crm_leads l where lower(l.email) = $1 and l.status in ('new', 'working') and ${leadScope} order by l.id limit 10`,
          leadParams,
        )
      ).rows
    : [];
  return { companies, people, leads };
}

/** Marks a suggested pair as not duplicates, or as the same customer kept apart (both have accounting records). */
export async function reviewDuplicate(
  tx: OrgTx,
  input: { record?: unknown; firstId?: unknown; secondId?: unknown; decision?: unknown },
): Promise<void> {
  await requireCrm(tx);
  const record = requireOneOf(input.record, "record", ["company", "person"] as const);
  const decision = requireOneOf(input.decision, "decision", ["not_duplicate", "same_customer"] as const);
  const [firstId, secondId] = ordered(requireId(input.firstId, "firstId"), requireId(input.secondId, "secondId"));
  if (firstId === secondId) throw new ValidationError("Choose two different records.");
  const table = record === "company" ? "contacts" : "crm_people";
  const found = await tx.query(`select 1 from ${table} where id = any($1::bigint[])`, [[firstId, secondId]]);
  if ((found.rowCount ?? 0) !== 2) throw new NotFoundError("One of those records wasn't found.");
  await tx.query(
    `insert into crm_duplicate_reviews (record, first_id, second_id, decision, decided_by_email) values ($1, $2, $3, $4, $5)
     on conflict (record, first_id, second_id) do update set decision = excluded.decision, decided_by_email = excluded.decided_by_email, decided_at = now()`,
    [record, firstId, secondId, decision, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "crm.duplicate_reviewed",
    entityType: record === "company" ? "contact" : "crm_person",
    entityId: firstId,
    details: { record, otherId: secondId, decision },
  });
}

/**
 * Merges company `mergeId` into `keepId` (decision 494). Refused when the
 * one merged away has anything in the books: keep that one instead, or, if
 * both have, mark them as the same customer.
 */
export async function mergeCompanies(tx: OrgTx, input: { keepId?: unknown; mergeId?: unknown }): Promise<{ keptId: string; mergedId: string }> {
  await requireCrm(tx);
  const keepId = requireId(input.keepId, "keepId");
  const mergeId = requireId(input.mergeId, "mergeId");
  if (keepId === mergeId) throw new ValidationError("Choose two different companies.");
  const rows = await tx.query<{ id: string; name: string; email: string | null; phone: string | null; postal_address: string | null; is_archived: boolean; merged_into_contact_id: string | null }>(
    "select id::text, name, email, phone, postal_address, is_archived, merged_into_contact_id::text from contacts where id = any($1::bigint[]) order by contacts.id for update",
    [[keepId, mergeId]],
  );
  const keep = rows.rows.find((row) => row.id === keepId);
  const merge = rows.rows.find((row) => row.id === mergeId);
  if (!keep || !merge) throw new NotFoundError("One of those companies wasn't found.");
  if (merge.merged_into_contact_id || keep.merged_into_contact_id) throw new ConflictError("One of those companies has already been merged.");
  const books = await outsideReferences(tx, "contacts", mergeId, COMPANY_MOVABLE);
  if (books.length > 0) {
    throw new ConflictError(
      (await hasBooks(tx, keepId))
        ? `${merge.name} and ${keep.name} both have accounting records, so they can't be merged. Mark them as the same customer instead.`
        : `${merge.name} has accounting records, so it can't be merged away. Keep ${merge.name} and merge ${keep.name} into it.`,
    );
  }
  const moves: Array<[string, string]> = [
    ["crm_people", "contact_id"],
    ["crm_opportunities", "contact_id"],
    ["crm_tasks", "contact_id"],
    ["crm_activities", "contact_id"],
    ["crm_leads", "converted_contact_id"],
    ["crm_participant_links", "contact_id"],
    ["contacts", "merged_into_contact_id"],
    ["crm_sent_emails", "contact_id"],
  ];
  // One primary person per company (RC6): if the kept company has one, it stays primary.
  await tx.query(
    `update crm_people set is_primary = false
      where contact_id = $2 and is_primary and exists (select 1 from crm_people kept where kept.contact_id = $1 and kept.is_primary)`,
    [keepId, mergeId],
  );
  const moved: Record<string, number> = {};
  for (const [table, column] of moves) {
    const result = await tx.query(`update ${table} set ${column} = $1 where ${column} = $2`, [keepId, mergeId]);
    moved[table] = result.rowCount ?? 0;
  }
  await tx.query(
    `update contacts set email = coalesce(email, $2), phone = coalesce(phone, $3), postal_address = coalesce(postal_address, $4), updated_at = now()
      where id = $1`,
    [keepId, merge.email, merge.phone, merge.postal_address],
  );
  await tx.query("update contacts set is_archived = true, merged_into_contact_id = $2, updated_at = now() where id = $1", [mergeId, keepId]);
  await writeAuditEvent(tx, { eventType: "contact.merged", entityType: "contact", entityId: mergeId, details: { into: keepId, intoName: keep.name, moved } });
  await writeAuditEvent(tx, { eventType: "contact.merged_in", entityType: "contact", entityId: keepId, details: { from: mergeId, fromName: merge.name, moved } });
  return { keptId: keepId, mergedId: mergeId };
}

/** Merges person `mergeId` into `keepId`, at the same company (decision 494). */
export async function mergePeople(tx: OrgTx, input: { keepId?: unknown; mergeId?: unknown }): Promise<{ keptId: string; mergedId: string }> {
  await requireCrm(tx);
  const keepId = requireId(input.keepId, "keepId");
  const mergeId = requireId(input.mergeId, "mergeId");
  if (keepId === mergeId) throw new ValidationError("Choose two different people.");
  const rows = await tx.query<{ id: string; contact_id: string | null; email: string | null; phone: string | null; job_title: string | null; is_primary: boolean; merged_into_person_id: string | null }>(
    "select id::text, contact_id::text, email, phone, job_title, is_primary, merged_into_person_id::text from crm_people where id = any($1::bigint[]) order by crm_people.id for update",
    [[keepId, mergeId]],
  );
  const keep = rows.rows.find((row) => row.id === keepId);
  const merge = rows.rows.find((row) => row.id === mergeId);
  if (!keep || !merge) throw new NotFoundError("One of those people wasn't found.");
  if (keep.merged_into_person_id || merge.merged_into_person_id) throw new ConflictError("One of those people has already been merged.");
  if (keep.contact_id !== merge.contact_id) throw new ConflictError("Those people are at different companies, so they can't be merged. Mark them as not duplicates, or move one first.");
  const outside = await outsideReferences(tx, "crm_people", mergeId, PERSON_MOVABLE);
  if (outside.length > 0) throw new ConflictError("That person is used outside the CRM, so they can't be merged away. Keep them instead.");
  const moves: Array<[string, string]> = [
    ["crm_opportunities", "point_of_contact_id"],
    ["crm_tasks", "person_id"],
    ["crm_activities", "person_id"],
    ["crm_leads", "converted_person_id"],
    ["crm_participant_links", "person_id"],
    ["crm_people", "merged_into_person_id"],
    ["crm_sent_emails", "person_id"],
  ];
  const moved: Record<string, number> = {};
  for (const [table, column] of moves) {
    const result = await tx.query(`update ${table} set ${column} = $1 where ${column} = $2`, [keepId, mergeId]);
    moved[table] = result.rowCount ?? 0;
  }
  await tx.query("update crm_people set is_primary = false, is_archived = true, merged_into_person_id = $2, updated_at = now() where id = $1", [mergeId, keepId]);
  await tx.query(
    `update crm_people set email = coalesce(email, $2), phone = coalesce(phone, $3), job_title = coalesce(job_title, $4), is_primary = is_primary or $5, updated_at = now()
      where id = $1`,
    [keepId, merge.email, merge.phone, merge.job_title, merge.is_primary],
  );
  await writeAuditEvent(tx, { eventType: "crm.person_merged", entityType: "crm_person", entityId: mergeId, details: { into: keepId, moved } });
  await writeAuditEvent(tx, { eventType: "crm.person_merged_in", entityType: "crm_person", entityId: keepId, details: { from: mergeId, moved } });
  return { keptId: keepId, mergedId: mergeId };
}

export type CompanyLinks = {
  /** The company this one was merged into, if it was. */
  mergedInto: { id: string; name: string } | null;
  /** Companies marked as the same customer as this one (both have accounting records). */
  sameCustomer: Array<{ id: string; name: string }>;
};

/** Shown on a company's record page (decision 494). */
export async function companyLinks(tx: OrgTx, contactId: string): Promise<CompanyLinks> {
  const merged = await tx.query<{ id: string; name: string }>(
    "select m.id::text, m.name from contacts c join contacts m on m.id = c.merged_into_contact_id where c.id = $1",
    [contactId],
  );
  const same = await tx.query<{ id: string; name: string }>(
    `select c.id::text, c.name
       from crm_duplicate_reviews r
       join contacts c on c.id = case when r.first_id = $1 then r.second_id else r.first_id end
      where r.record = 'company' and r.decision = 'same_customer' and $1 in (r.first_id, r.second_id)
      order by c.name, c.id`,
    [contactId],
  );
  return { mergedInto: merged.rows[0] ?? null, sameCustomer: same.rows };
}
