import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { requireBoolean, requireIdempotencyKey, requireOneOf, requireString } from "@/lib/validation";

/**
 * Pay groups and employee groups (example PR8). A pay group is the people
 * paid together on one frequency ("Weekly wages", "Monthly salaries"); pay
 * runs (P3) will pick employees by pay group. An employee group is for
 * reporting ("Wellington office"). Groups are archived, never deleted.
 */

export const PAY_FREQUENCIES = ["weekly", "fortnightly", "four_weekly", "monthly"] as const;
export type PayFrequency = (typeof PAY_FREQUENCIES)[number];

export const PAY_FREQUENCY_WORDS: Record<PayFrequency, string> = {
  weekly: "weekly",
  fortnightly: "fortnightly",
  four_weekly: "four-weekly",
  monthly: "monthly",
};

export type PayGroup = { id: string; name: string; payFrequency: PayFrequency; isArchived: boolean; employeeCount: number };
export type EmployeeGroup = { id: string; name: string; isArchived: boolean; employeeCount: number };

type GroupKind = "pay" | "employee";

const TABLES: Record<GroupKind, { table: string; column: string; noun: string }> = {
  pay: { table: "payroll_pay_groups", column: "pay_group_id", noun: "pay group" },
  employee: { table: "payroll_employee_groups", column: "employee_group_id", noun: "employee group" },
};

type GroupRow = {
  id: string;
  name: string;
  pay_frequency?: PayFrequency;
  is_archived: boolean;
  employee_count: string;
  request_hash: string;
};

function columns(kind: GroupKind): string {
  const { column } = TABLES[kind];
  return `g.id, g.name, ${kind === "pay" ? "g.pay_frequency, " : ""}g.is_archived, g.request_hash,
    (select count(*) from payroll_employees e where e.${column} = g.id and not e.is_archived)::text as employee_count`;
}

function toPayGroup(row: GroupRow): PayGroup {
  return {
    id: row.id,
    name: row.name,
    payFrequency: row.pay_frequency as PayFrequency,
    isArchived: row.is_archived,
    employeeCount: Number(row.employee_count),
  };
}

function toEmployeeGroup(row: GroupRow): EmployeeGroup {
  return { id: row.id, name: row.name, isArchived: row.is_archived, employeeCount: Number(row.employee_count) };
}

async function findGroup(tx: OrgTx, kind: GroupKind, id: unknown, forUpdate = false): Promise<GroupRow> {
  const { table, noun } = TABLES[kind];
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError(`That ${noun} wasn't found.`);
  if (forUpdate) await tx.query(`select 1 from ${table} where id = $1 for update`, [id]);
  const result = await tx.query<GroupRow>(`select ${columns(kind)} from ${table} g where g.id = $1`, [id]);
  if (!result.rows[0]) throw new NotFoundError(`That ${noun} wasn't found.`);
  return result.rows[0];
}

async function assertNameFree(tx: OrgTx, kind: GroupKind, name: string, exceptId: string | null): Promise<void> {
  const { table, noun } = TABLES[kind];
  const clash = await tx.query(`select 1 from ${table} where lower(name) = lower($1) and ($2::uuid is null or id <> $2)`, [
    name,
    exceptId,
  ]);
  if (clash.rows[0]) throw new ConflictError(`There's already a ${noun} called ${name}.`);
}

function parseName(input: unknown): string {
  return requireString(input, "Name", { maxLength: 100 });
}

async function createGroup(tx: OrgTx, kind: GroupKind, input: Record<string, unknown>): Promise<{ created: boolean; row: GroupRow }> {
  await requirePayrollAccess(tx);
  const { table, noun } = TABLES[kind];
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const hash = requestHash(`payroll_${kind}_group`, input);
  const replay = async () => {
    const earlier = await tx.query<GroupRow>(`select ${columns(kind)} from ${table} g where g.idempotency_key = $1`, [idempotencyKey]);
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].request_hash, hash, noun);
    return { created: false, row: earlier.rows[0] };
  };
  const earlier = await replay();
  if (earlier) return earlier;

  const name = parseName(input.name);
  const payFrequency = kind === "pay" ? requireOneOf(input.payFrequency, "Pay frequency", PAY_FREQUENCIES) : null;
  await assertNameFree(tx, kind, name, null);
  const inserted = await tx.query<{ id: string }>(
    kind === "pay"
      ? `insert into payroll_pay_groups (idempotency_key, request_hash, name, pay_frequency) values ($1, $2, $3, $4)
         on conflict (idempotency_key) do nothing returning id`
      : `insert into payroll_employee_groups (idempotency_key, request_hash, name) values ($1, $2, $3)
         on conflict (idempotency_key) do nothing returning id`,
    kind === "pay" ? [idempotencyKey, hash, name, payFrequency] : [idempotencyKey, hash, name],
  );
  const id = inserted.rows[0]?.id;
  if (!id) {
    const winner = await replay();
    if (winner) return winner;
    throw new ConflictError(`The ${noun} couldn't be saved. Try again with a new idempotency key.`);
  }
  await writeAuditEvent(tx, {
    eventType: `payroll_${kind}_group.created`,
    entityType: `payroll_${kind}_group`,
    entityId: id,
    details: payFrequency ? { name, payFrequency } : { name },
  });
  return { created: true, row: await findGroup(tx, kind, id) };
}

async function updateGroup(tx: OrgTx, kind: GroupKind, id: string, input: Record<string, unknown>): Promise<GroupRow> {
  await requirePayrollAccess(tx);
  const { table } = TABLES[kind];
  const current = await findGroup(tx, kind, id, true);
  const name = input.name === undefined ? current.name : parseName(input.name);
  const isArchived = input.isArchived === undefined ? current.is_archived : requireBoolean(input.isArchived, "isArchived");
  const payFrequency =
    kind === "pay" && input.payFrequency !== undefined
      ? requireOneOf(input.payFrequency, "Pay frequency", PAY_FREQUENCIES)
      : current.pay_frequency;
  if (name.toLowerCase() !== current.name.toLowerCase()) await assertNameFree(tx, kind, name, id);
  if (kind === "pay" && payFrequency !== current.pay_frequency) {
    const members = await tx.query("select 1 from payroll_employees where pay_group_id = $1 limit 1", [id]);
    if (members.rows[0]) {
      throw new ValidationError("A pay group's frequency can't change while employees are in it. Move them to another pay group first.");
    }
  }
  if (kind === "pay") {
    await tx.query("update payroll_pay_groups set name = $2, pay_frequency = $3, is_archived = $4, updated_at = now() where id = $1", [
      id,
      name,
      payFrequency,
      isArchived,
    ]);
  } else {
    await tx.query(`update ${table} set name = $2, is_archived = $3, updated_at = now() where id = $1`, [id, name, isArchived]);
  }
  const changedFields = Object.keys(input).filter((field) => field !== "organisationId" && field !== "kind");
  await writeAuditEvent(tx, {
    eventType: `payroll_${kind}_group.updated`,
    entityType: `payroll_${kind}_group`,
    entityId: id,
    details: { changedFields },
  });
  return findGroup(tx, kind, id);
}

export async function createPayGroup(tx: OrgTx, input: Record<string, unknown>): Promise<{ created: boolean; group: PayGroup }> {
  const { created, row } = await createGroup(tx, "pay", input);
  return { created, group: toPayGroup(row) };
}

export async function createEmployeeGroup(
  tx: OrgTx,
  input: Record<string, unknown>,
): Promise<{ created: boolean; group: EmployeeGroup }> {
  const { created, row } = await createGroup(tx, "employee", input);
  return { created, group: toEmployeeGroup(row) };
}

export async function updatePayGroup(tx: OrgTx, id: string, input: Record<string, unknown>): Promise<{ group: PayGroup }> {
  return { group: toPayGroup(await updateGroup(tx, "pay", id, input)) };
}

export async function updateEmployeeGroup(tx: OrgTx, id: string, input: Record<string, unknown>): Promise<{ group: EmployeeGroup }> {
  return { group: toEmployeeGroup(await updateGroup(tx, "employee", id, input)) };
}

export async function listPayrollGroups(
  tx: OrgTx,
  options: { includeArchived?: boolean } = {},
): Promise<{ payGroups: PayGroup[]; employeeGroups: EmployeeGroup[] }> {
  await requirePayrollAccess(tx);
  const list = async (kind: GroupKind) =>
    (
      await tx.query<GroupRow>(
        `select ${columns(kind)} from ${TABLES[kind].table} g
          where ($1::boolean or not g.is_archived)
          order by lower(g.name), g.id`,
        [options.includeArchived ?? false],
      )
    ).rows;
  return {
    payGroups: (await list("pay")).map(toPayGroup),
    employeeGroups: (await list("employee")).map(toEmployeeGroup),
  };
}

/** Checks a group an employee is being put in exists and isn't archived (unless they're already in it). */
export async function checkGroupForEmployee(
  tx: OrgTx,
  kind: GroupKind,
  id: string,
  currentId: string | null,
): Promise<{ name: string; payFrequency: PayFrequency | null }> {
  const { table, noun } = TABLES[kind];
  const result = await tx.query<{ name: string; pay_frequency?: PayFrequency; is_archived: boolean }>(
    `select name, ${kind === "pay" ? "pay_frequency, " : ""}is_archived from ${table} where id = $1 for share`,
    [id],
  );
  const group = result.rows[0];
  if (!group) throw new ValidationError(`That ${noun} wasn't found.`);
  if (group.is_archived && id !== currentId) throw new ValidationError(`${group.name} is archived.`);
  return { name: group.name, payFrequency: group.pay_frequency ?? null };
}
