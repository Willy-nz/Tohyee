import { writeAdminAuditEvent } from "@/lib/audit";
import { type Role, roleAtLeast } from "@/lib/auth/roles";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { coreQuery, type DbClient, withCoreTransaction } from "@/lib/db/transactions";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { dec, parseDecimalInput, toPlainString, add, cmp, ZERO_DECIMAL } from "@/lib/money/decimal";
import { getOrganisation, type OrganisationRecord } from "@/lib/organisations/registry";
import { asRecord, requireArray, requireId, requireOneOf, requireString } from "@/lib/validation";
import { parseIsoDate } from "@/lib/dates";
import type { ConsolidationAdjustment, ConsolidationGroup, RateKind } from "@/lib/consolidation/types";

/**
 * Consolidation groups (CO1, decisions 437-445): organisations on this
 * server reported together in the parent's currency. A group is made by
 * someone who's an admin or owner of every organisation in it, and seen by
 * anyone who's a member (viewer or above) of every one; stop being a member
 * of one and it's gone from view (Jess, 5 Oct 2026). Groups, their rate
 * changes, budget rates and elimination adjustments live in the core
 * database; nothing of a group is ever posted in an organisation's books.
 */

export type GroupUser = { id: string; email: string };

/** The signed-in person's role in each organisation. */
export async function rolesOf(userId: string): Promise<Map<string, Role>> {
  const found = await coreQuery<{ organisation_id: string; role: Role }>(
    `select m.organisation_id, m.role from organisation_members m join organisations o on o.id = m.organisation_id
      where m.user_id = $1 and o.is_active`,
    [userId],
  );
  return new Map(found.rows.map((row) => [row.organisation_id, row.role]));
}

type GroupRow = { id: string; name: string; parent_organisation_id: string; version: number; created_by_email: string; created_at: string; updated_at: string };

async function groupRows(where: string, params: unknown[]): Promise<ConsolidationGroup[]> {
  const groups = await coreQuery<GroupRow>(
    `select id::text, name, parent_organisation_id, version, created_by_email, created_at, updated_at from consolidation_groups
      where archived_at is null and ${where} order by lower(name), consolidation_groups.id`,
    params,
  );
  if (groups.rows.length === 0) return [];
  const members = await coreQuery<{ group_id: string; organisation_id: string; display_name: string; base_currency: string }>(
    `select m.group_id::text, m.organisation_id, o.display_name, o.base_currency from consolidation_group_members m
       join organisations o on o.id = m.organisation_id where m.group_id = any($1::bigint[]) order by o.display_name, o.id`,
    [groups.rows.map((row) => row.id)],
  );
  return groups.rows.map((row) => {
    const own = members.rows.filter((member) => member.group_id === row.id);
    const parent = own.find((member) => member.organisation_id === row.parent_organisation_id);
    return {
      id: row.id,
      name: row.name,
      parentOrganisationId: row.parent_organisation_id,
      currencyCode: parent?.base_currency ?? "",
      version: row.version,
      members: [
        ...own.filter((member) => member.organisation_id === row.parent_organisation_id),
        ...own.filter((member) => member.organisation_id !== row.parent_organisation_id),
      ].map((member) => ({ organisationId: member.organisation_id, name: member.display_name, currencyCode: member.base_currency })),
      createdByEmail: row.created_by_email,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

function hasEvery(roles: Map<string, Role>, group: ConsolidationGroup, minimum: Role): boolean {
  return group.members.every((member) => {
    const role = roles.get(member.organisationId);
    return role !== undefined && role !== "report_viewer" && roleAtLeast(role, minimum);
  });
}

/** The groups the person can see: a member (viewer or above) of every organisation in it. */
export async function listGroups(user: GroupUser): Promise<ConsolidationGroup[]> {
  const roles = await rolesOf(user.id);
  return (await groupRows("true", [])).filter((group) => hasEvery(roles, group, "viewer"));
}

/** A group the person can see, checking they have at least `minimum` in every organisation in it. */
export async function requireGroup(user: GroupUser, idInput: unknown, minimum: Role = "viewer"): Promise<ConsolidationGroup> {
  const id = requireId(idInput, "groupId");
  const [group] = await groupRows("id = $1", [id]);
  const roles = await rolesOf(user.id);
  // A group someone can't see is "not found", so its name isn't given away.
  if (!group || !hasEvery(roles, group, "viewer")) throw new NotFoundError("Consolidation group not found.");
  if (!hasEvery(roles, group, minimum)) {
    throw new ForbiddenError(
      minimum === "admin"
        ? "Only someone who's an admin or owner of every organisation in the group can do this."
        : "Only someone who's a bookkeeper or above in every organisation in the group can do this.",
    );
  }
  return group;
}

async function memberRecords(ids: string[]): Promise<OrganisationRecord[]> {
  const records: OrganisationRecord[] = [];
  for (const id of ids) {
    const record = await getOrganisation(id);
    if (!record || !record.isActive) throw new ValidationError(`There's no organisation "${id}" on this server.`);
    records.push(record);
  }
  return records;
}

function parseMembers(input: Record<string, unknown>): { name: string; parentOrganisationId: string; organisationIds: string[] } {
  const name = requireString(input.name, "The group's name", { maxLength: 100 });
  const parentOrganisationId = requireString(input.parentOrganisationId, "The parent organisation");
  const ids = requireArray(input.organisationIds, "organisationIds", 50).map((id) => requireString(id, "An organisation"));
  const organisationIds = [...new Set([parentOrganisationId, ...ids])];
  if (organisationIds.length < 2) throw new ValidationError("A group needs the parent and at least one other organisation.");
  return { name, parentOrganisationId, organisationIds };
}

/**
 * Makes a group (CO1). The parent's base currency and year end are the
 * group's; members can have other currencies and year ends. The person must
 * be an admin or owner of every organisation in it.
 */
export async function createGroup(user: GroupUser, input: Record<string, unknown>): Promise<ConsolidationGroup> {
  const parsed = parseMembers(input);
  const roles = await rolesOf(user.id);
  const records = await memberRecords(parsed.organisationIds);
  for (const record of records) {
    const role = roles.get(record.id);
    if (!role || !roleAtLeast(role, "admin")) {
      throw new ForbiddenError(`You need to be an admin or owner of ${record.displayName} to add it to a consolidation group.`);
    }
  }
  const id = await withCoreTransaction(async (client) => {
    const inserted = await client
      .query<{ id: string }>(
        "insert into consolidation_groups (name, parent_organisation_id, created_by_user_id, created_by_email) values ($1, $2, $3, $4) returning id::text",
        [parsed.name, parsed.parentOrganisationId, user.id, user.email],
      )
      .catch((error) => nameTaken(error, parsed.name));
    const groupId = inserted.rows[0].id;
    for (const organisationId of parsed.organisationIds) {
      await client.query("insert into consolidation_group_members (group_id, organisation_id, added_by_email) values ($1, $2, $3)", [groupId, organisationId, user.email]);
    }
    await writeAdminAuditEvent(client, { userId: user.id, email: user.email }, {
      eventType: "consolidation_group.created",
      entityType: "consolidation_group",
      entityId: groupId,
      details: { name: parsed.name, parentOrganisationId: parsed.parentOrganisationId, organisationIds: parsed.organisationIds },
    });
    return groupId;
  });
  return requireGroup(user, id);
}

function nameTaken(error: unknown, name: string): never {
  if ((error as { code?: string }).code === "23505") throw new ConflictError(`There's already a consolidation group called "${name}".`);
  throw error;
}

/** Changes a group's name and members (admins of every organisation, the old and the new). `version` is the one read. */
export async function updateGroup(user: GroupUser, idInput: unknown, input: Record<string, unknown>): Promise<ConsolidationGroup> {
  const current = await requireGroup(user, idInput, "admin");
  if (Number(input.version) !== current.version) throw new ConflictError("Someone else changed this group since you opened it. Reload it and try again.");
  const parsed = parseMembers({ ...input, parentOrganisationId: input.parentOrganisationId ?? current.parentOrganisationId });
  const roles = await rolesOf(user.id);
  for (const record of await memberRecords(parsed.organisationIds)) {
    const role = roles.get(record.id);
    if (!role || !roleAtLeast(role, "admin")) throw new ForbiddenError(`You need to be an admin or owner of ${record.displayName} to add it to a consolidation group.`);
  }
  await withCoreTransaction(async (client) => {
    await client
      .query("update consolidation_groups set name = $2, parent_organisation_id = $3, version = version + 1, updated_at = now() where id = $1", [current.id, parsed.name, parsed.parentOrganisationId])
      .catch((error) => nameTaken(error, parsed.name));
    await client.query("delete from consolidation_group_members where group_id = $1 and not (organisation_id = any($2::text[]))", [current.id, parsed.organisationIds]);
    for (const organisationId of parsed.organisationIds) {
      await client.query(
        "insert into consolidation_group_members (group_id, organisation_id, added_by_email) values ($1, $2, $3) on conflict do nothing",
        [current.id, organisationId, user.email],
      );
    }
    await writeAdminAuditEvent(client, { userId: user.id, email: user.email }, {
      eventType: "consolidation_group.updated",
      entityType: "consolidation_group",
      entityId: current.id,
      details: { name: parsed.name, parentOrganisationId: parsed.parentOrganisationId, organisationIds: parsed.organisationIds, before: current.members.map((member) => member.organisationId) },
    });
  });
  return requireGroup(user, current.id);
}

// ---------------------------------------------------------------- rates

export type RateOverride = { currencyCode: string; month: string; kind: RateKind; rate: string; reason: string; changedByEmail: string; changedAt: string };
export type BudgetRate = { currencyCode: string; month: string; rate: string; changedByEmail: string; changedAt: string };

export async function listRateOverrides(groupId: string): Promise<RateOverride[]> {
  const found = await coreQuery<{ currency_code: string; month: string; kind: RateKind; rate: string; reason: string; changed_by_email: string; changed_at: string }>(
    "select currency_code, month::text, kind, rate::text, reason, changed_by_email, changed_at from consolidation_rate_overrides where group_id = $1 order by currency_code, month, kind",
    [groupId],
  );
  return found.rows.map((row) => ({ currencyCode: row.currency_code, month: row.month, kind: row.kind, rate: toPlainString(dec(row.rate)), reason: row.reason, changedByEmail: row.changed_by_email, changedAt: row.changed_at }));
}

export async function listBudgetRates(groupId: string): Promise<BudgetRate[]> {
  const found = await coreQuery<{ currency_code: string; month: string; rate: string; changed_by_email: string; changed_at: string }>(
    "select currency_code, month::text, rate::text, changed_by_email, changed_at from consolidation_budget_rates where group_id = $1 order by currency_code, month",
    [groupId],
  );
  return found.rows.map((row) => ({ currencyCode: row.currency_code, month: row.month, rate: toPlainString(dec(row.rate)), changedByEmail: row.changed_by_email, changedAt: row.changed_at }));
}

function parseMonth(input: unknown): string {
  if (typeof input !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.trim())) throw new ValidationError("The month must be like 2026-10.");
  return `${input.trim()}-01`;
}

function foreignCurrency(group: ConsolidationGroup, input: unknown): string {
  const code = typeof input === "string" ? input.trim().toUpperCase() : "";
  if (!group.members.some((member) => member.currencyCode === code) || code === group.currencyCode) {
    throw new ValidationError(`${code || "That currency"} isn't a member's currency other than the group's ${group.currencyCode}.`);
  }
  return code;
}

/**
 * Changes a month's consolidation rate (NetSuite's edited consolidated
 * rates), with a reason, or with `rate` blank goes back to the worked-out
 * one. Admins of every organisation. The history keeps both.
 */
export async function setRateOverride(user: GroupUser, groupIdInput: unknown, input: Record<string, unknown>): Promise<RateOverride[]> {
  const group = await requireGroup(user, groupIdInput, "admin");
  const currency = foreignCurrency(group, input.currencyCode);
  const month = parseMonth(input.month);
  const kind = requireOneOf(input.kind, "kind", ["current", "average", "historical"] as const);
  await withCoreTransaction(async (client: DbClient) => {
    if (input.rate == null || input.rate === "") {
      await client.query("delete from consolidation_rate_overrides where group_id = $1 and currency_code = $2 and month = $3 and kind = $4", [group.id, currency, month, kind]);
    } else {
      const rate = parseDecimalInput(input.rate, "The rate", { maxScale: 8 });
      const reason = requireString(input.reason, "The reason", { maxLength: 200 });
      await client.query(
        `insert into consolidation_rate_overrides (group_id, currency_code, month, kind, rate, reason, changed_by_email) values ($1, $2, $3, $4, $5::numeric, $6, $7)
         on conflict (group_id, currency_code, month, kind) do update set rate = excluded.rate, reason = excluded.reason, changed_by_email = excluded.changed_by_email, changed_at = now()`,
        [group.id, currency, month, kind, rate, reason, user.email],
      );
    }
    await writeAdminAuditEvent(client, { userId: user.id, email: user.email }, {
      eventType: "consolidation_rate.changed",
      entityType: "consolidation_group",
      entityId: group.id,
      details: { currencyCode: currency, month, kind, rate: input.rate ?? null, reason: input.reason ?? null },
    });
  });
  return listRateOverrides(group.id);
}

/** Sets a month's budget exchange rate for a member currency (CO11), or removes it with `rate` blank. Admins of every organisation. */
export async function setBudgetRate(user: GroupUser, groupIdInput: unknown, input: Record<string, unknown>): Promise<BudgetRate[]> {
  const group = await requireGroup(user, groupIdInput, "admin");
  const currency = foreignCurrency(group, input.currencyCode);
  const month = parseMonth(input.month);
  await withCoreTransaction(async (client: DbClient) => {
    if (input.rate == null || input.rate === "") {
      await client.query("delete from consolidation_budget_rates where group_id = $1 and currency_code = $2 and month = $3", [group.id, currency, month]);
    } else {
      const rate = parseDecimalInput(input.rate, "The rate", { maxScale: 8 });
      await client.query(
        `insert into consolidation_budget_rates (group_id, currency_code, month, rate, changed_by_email) values ($1, $2, $3, $4::numeric, $5)
         on conflict (group_id, currency_code, month) do update set rate = excluded.rate, changed_by_email = excluded.changed_by_email, changed_at = now()`,
        [group.id, currency, month, rate, user.email],
      );
    }
    await writeAdminAuditEvent(client, { userId: user.id, email: user.email }, {
      eventType: "consolidation_budget_rate.changed",
      entityType: "consolidation_group",
      entityId: group.id,
      details: { currencyCode: currency, month, rate: input.rate ?? null },
    });
  });
  return listBudgetRates(group.id);
}

// ---------------------------------------------------------------- adjustments

export async function listAdjustments(groupId: string): Promise<ConsolidationAdjustment[]> {
  const heads = await coreQuery<{ id: string; adjustment_date: string; description: string; created_by_email: string; created_at: string }>(
    "select id::text, adjustment_date::text, description, created_by_email, created_at from consolidation_adjustments where group_id = $1 and removed_at is null order by consolidation_adjustments.adjustment_date, consolidation_adjustments.id",
    [groupId],
  );
  const lines = await coreQuery<{ adjustment_id: string; organisation_id: string; account_code: string; debit: string; credit: string }>(
    `select l.adjustment_id::text, l.organisation_id, l.account_code, l.debit::text, l.credit::text from consolidation_adjustment_lines l
      where l.adjustment_id = any($1::bigint[]) order by l.adjustment_id, l.line_order`,
    [heads.rows.map((row) => row.id)],
  );
  return heads.rows.map((row) => ({
    id: row.id,
    date: row.adjustment_date,
    description: row.description,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    lines: lines.rows
      .filter((line) => line.adjustment_id === row.id)
      .map((line) => ({ organisationId: line.organisation_id, accountCode: line.account_code, debit: toPlainString(dec(line.debit)), credit: toPlainString(dec(line.credit)) })),
  }));
}

/**
 * Adds an elimination adjustment (CO7): dated lines by organisation and
 * account code in the group's currency, debits equal to credits. Bookkeepers
 * or above of every organisation. Posts nothing in any organisation.
 */
export async function createAdjustment(user: GroupUser, groupIdInput: unknown, input: Record<string, unknown>): Promise<ConsolidationAdjustment[]> {
  const group = await requireGroup(user, groupIdInput, "bookkeeper");
  const date = parseIsoDate(input.date, "The date");
  const description = requireString(input.description, "The description", { maxLength: 200 });
  const raw = requireArray(input.lines, "lines", 100);
  if (raw.length < 2) throw new ValidationError("An adjustment needs at least two lines.");
  let debits = ZERO_DECIMAL;
  let credits = ZERO_DECIMAL;
  const lines: { organisationId: string; accountCode: string; debit: string; credit: string }[] = [];
  for (const [index, entry] of raw.entries()) {
    const line = asRecord(entry, `Line ${index + 1}`);
    const organisationId = requireString(line.organisationId, `Line ${index + 1}'s organisation`);
    const member = group.members.find((item) => item.organisationId === organisationId);
    if (!member) throw new ValidationError(`Line ${index + 1}: that organisation isn't in the group.`);
    const accountCode = requireString(line.accountCode, `Line ${index + 1}'s account`, { maxLength: 20 });
    const debit = line.debit == null || line.debit === "" ? "0" : parseDecimalInput(line.debit, `Line ${index + 1}'s debit`, { maxScale: 2, allowZero: true });
    const credit = line.credit == null || line.credit === "" ? "0" : parseDecimalInput(line.credit, `Line ${index + 1}'s credit`, { maxScale: 2, allowZero: true });
    if ((cmp(dec(debit), ZERO_DECIMAL) === 0) === (cmp(dec(credit), ZERO_DECIMAL) === 0)) throw new ValidationError(`Line ${index + 1} needs a debit or a credit.`);
    const record = (await getOrganisation(organisationId))!;
    const exists = await withOrganisationTransaction(record, { userId: user.id, email: user.email }, (tx) => tx.query("select 1 from accounts where lower(code) = lower($1)", [accountCode]), { readOnly: true });
    if ((exists.rowCount ?? 0) === 0) throw new ValidationError(`Line ${index + 1}: ${member.name} has no account ${accountCode}.`);
    debits = add(debits, dec(debit));
    credits = add(credits, dec(credit));
    lines.push({ organisationId, accountCode, debit, credit });
  }
  if (cmp(debits, credits) !== 0) throw new ValidationError(`The debits (${toPlainString(debits)}) and credits (${toPlainString(credits)}) must be equal.`);
  await withCoreTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      "insert into consolidation_adjustments (group_id, adjustment_date, description, created_by_email) values ($1, $2, $3, $4) returning id::text",
      [group.id, date, description, user.email],
    );
    for (const [index, line] of lines.entries()) {
      await client.query(
        "insert into consolidation_adjustment_lines (adjustment_id, line_order, organisation_id, account_code, debit, credit) values ($1, $2, $3, $4, $5::numeric, $6::numeric)",
        [inserted.rows[0].id, index + 1, line.organisationId, line.accountCode, line.debit, line.credit],
      );
    }
    await writeAdminAuditEvent(client, { userId: user.id, email: user.email }, {
      eventType: "consolidation_adjustment.created",
      entityType: "consolidation_group",
      entityId: group.id,
      details: { adjustmentId: inserted.rows[0].id, date, description, lines },
    });
  });
  return listAdjustments(group.id);
}

/** Removes an adjustment (kept, with who removed it). Bookkeepers or above of every organisation. */
export async function removeAdjustment(user: GroupUser, groupIdInput: unknown, adjustmentIdInput: unknown): Promise<ConsolidationAdjustment[]> {
  const group = await requireGroup(user, groupIdInput, "bookkeeper");
  const id = requireId(adjustmentIdInput, "adjustmentId");
  await withCoreTransaction(async (client) => {
    const updated = await client.query(
      "update consolidation_adjustments set removed_at = now(), removed_by_email = $3 where id = $1 and group_id = $2 and removed_at is null",
      [id, group.id, user.email],
    );
    if (updated.rowCount === 0) throw new NotFoundError("Adjustment not found.");
    await writeAdminAuditEvent(client, { userId: user.id, email: user.email }, { eventType: "consolidation_adjustment.removed", entityType: "consolidation_group", entityId: group.id, details: { adjustmentId: id } });
  });
  return listAdjustments(group.id);
}
