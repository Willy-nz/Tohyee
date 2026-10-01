import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { dec, toPlainString } from "@/lib/money/decimal";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { assertTotalsOneHundred, parseAllocationPercentage } from "@/lib/payroll/allocation-split";
import { advancedFeaturesOn } from "@/lib/tracking/service";
import { asRecord, optionalId, requireArray, requireIdempotencyKey } from "@/lib/validation";

/**
 * Employee cost allocation (examples PE3-PE6): where an employee's pay is
 * charged, split by % across Department, Class and Location values, a project
 * and an R&D activity from the RDTI register (R2). Lines total exactly
 * 100.00%. Each allocation starts on a date and is never changed; saving a
 * new one keeps the old, so moving someone between departments doesn't change
 * how their earlier pay was charged. Pay runs (P3) use `allocationOn` and
 * `splitByPercentages`.
 */

export type AllocationLine = {
  lineNumber: number;
  percentage: string;
  departmentId: string | null;
  departmentName: string | null;
  classId: string | null;
  className: string | null;
  locationId: string | null;
  locationName: string | null;
  projectId: string | null;
  projectName: string | null;
  rdActivityId: string | null;
  rdActivityCode: string | null;
  rdActivityName: string | null;
};

export type CostAllocation = {
  id: string;
  effectiveFrom: string;
  lines: AllocationLine[];
  createdAt: string;
  createdByEmail: string;
};

type AllocationRow = {
  id: string;
  employee_id: string;
  effective_from: string;
  created_at: string;
  created_by_email: string;
  request_hash: string;
};

type LineRow = {
  allocation_id: string;
  line_number: number;
  percentage: string;
  department_id: string | null;
  department_name: string | null;
  class_id: string | null;
  class_name: string | null;
  location_id: string | null;
  location_name: string | null;
  project_id: string | null;
  project_name: string | null;
  rd_activity_id: string | null;
  rd_activity_code: string | null;
  rd_activity_name: string | null;
};

const ALLOCATION_COLUMNS = "id, employee_id, effective_from::text, created_at, created_by_email, request_hash";

type TrackingKind = "department" | "class" | "location";
const TRACKING_FIELDS: ReadonlyArray<{ kind: TrackingKind; field: "departmentId" | "classId" | "locationId" }> = [
  { kind: "department", field: "departmentId" },
  { kind: "class", field: "classId" },
  { kind: "location", field: "locationId" },
];

async function loadAllocations(tx: OrgTx, rows: AllocationRow[]): Promise<CostAllocation[]> {
  if (rows.length === 0) return [];
  const lines = await tx.query<LineRow>(
    `select l.allocation_id, l.line_number, l.percentage::text,
            l.department_id::text, d.name as department_name,
            l.class_id::text, c.name as class_name,
            l.location_id::text, lo.name as location_name,
            l.project_id::text, p.name as project_name,
            l.rd_activity_id::text, r.code as rd_activity_code, r.name as rd_activity_name
       from payroll_cost_allocation_lines l
       left join tracking_values d on d.id = l.department_id
       left join tracking_values c on c.id = l.class_id
       left join tracking_values lo on lo.id = l.location_id
       left join projects p on p.id = l.project_id
       left join rd_activities r on r.id = l.rd_activity_id
      where l.allocation_id = any($1::uuid[])
      order by l.allocation_id, l.line_number`,
    [rows.map((row) => row.id)],
  );
  const byAllocation = new Map<string, AllocationLine[]>();
  for (const line of lines.rows) {
    const list = byAllocation.get(line.allocation_id) ?? [];
    list.push({
      lineNumber: line.line_number,
      percentage: toPlainString(dec(line.percentage)),
      departmentId: line.department_id,
      departmentName: line.department_name,
      classId: line.class_id,
      className: line.class_name,
      locationId: line.location_id,
      locationName: line.location_name,
      projectId: line.project_id,
      projectName: line.project_name,
      rdActivityId: line.rd_activity_id,
      rdActivityCode: line.rd_activity_code,
      rdActivityName: line.rd_activity_name,
    });
    byAllocation.set(line.allocation_id, list);
  }
  return rows.map((row) => ({
    id: row.id,
    effectiveFrom: row.effective_from,
    lines: byAllocation.get(row.id) ?? [],
    createdAt: row.created_at,
    createdByEmail: row.created_by_email,
  }));
}

async function employeeStartDate(tx: OrgTx, employeeId: string, forUpdate = false): Promise<string> {
  const result = await tx.query<{ start_date: string }>(
    `select start_date::text from payroll_employees where id = $1${forUpdate ? " for update" : ""}`,
    [employeeId],
  );
  if (!result.rows[0]) throw new NotFoundError("Employee not found.");
  return result.rows[0].start_date;
}

/** Every allocation the employee has had, oldest first (PE6). */
export async function listAllocations(tx: OrgTx, employeeId: string): Promise<CostAllocation[]> {
  await requirePayrollAccess(tx);
  await employeeStartDate(tx, employeeId);
  const rows = await tx.query<AllocationRow>(
    `select ${ALLOCATION_COLUMNS} from payroll_cost_allocations where employee_id = $1 order by effective_from, entry_number`,
    [employeeId],
  );
  return loadAllocations(tx, rows.rows);
}

/**
 * The allocation in effect on `date` (PE6): the one with the latest start on
 * or before it; for the same start, the one saved last. Null before the
 * first. For pay runs (P3).
 */
export async function allocationOn(tx: OrgTx, employeeId: string, dateInput: unknown): Promise<CostAllocation | null> {
  await requirePayrollAccess(tx);
  const date = parseIsoDate(dateInput, "Date");
  await employeeStartDate(tx, employeeId);
  const rows = await tx.query<AllocationRow>(
    `select ${ALLOCATION_COLUMNS} from payroll_cost_allocations
      where employee_id = $1 and effective_from <= $2
      order by effective_from desc, entry_number desc
      limit 1`,
    [employeeId, date],
  );
  return (await loadAllocations(tx, rows.rows))[0] ?? null;
}

/**
 * Each employee's primary department today: the Department on the biggest
 * line of the allocation in effect today (the first such line if two are
 * equal), or null. Shown in the employee list. Callers check payroll access.
 */
export async function primaryDepartments(
  tx: OrgTx,
  employeeIds: readonly string[],
): Promise<Map<string, { id: string; name: string } | null>> {
  if (employeeIds.length === 0) return new Map();
  const result = await tx.query<{ employee_id: string; department_id: string | null; department_name: string | null }>(
    `with current_allocation as (
       select distinct on (employee_id) id, employee_id
         from payroll_cost_allocations
        where employee_id = any($1::uuid[]) and effective_from <= $2
        order by employee_id, effective_from desc, entry_number desc
     )
     select distinct on (a.employee_id) a.employee_id, l.department_id::text, d.name as department_name
       from current_allocation a
       join payroll_cost_allocation_lines l on l.allocation_id = a.id
       left join tracking_values d on d.id = l.department_id
      order by a.employee_id, l.percentage desc, l.line_number`,
    [employeeIds, todayIsoDate()],
  );
  return new Map(
    result.rows.map((row) => [
      row.employee_id,
      row.department_id && row.department_name ? { id: row.department_id, name: row.department_name } : null,
    ]),
  );
}

type ParsedLine = {
  percentage: string;
  departmentId: string | null;
  classId: string | null;
  locationId: string | null;
  projectId: string | null;
  rdActivityId: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A line's R&D activity, from the RDTI register (R2). The pay run (P3) splits
 * pay by these lines; for the R&D claim (R3) a default split counts only when
 * the employee's allocation is 100% R&D, and otherwise needs a time record
 * (decision 34; RD7). The allocation only records where pay is charged.
 */
function optionalRdActivity(input: unknown, label: string): string | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input !== "string" || !UUID.test(input)) throw new ValidationError(`${label}: that isn't an R&D activity.`);
  return input.toLowerCase();
}

function parseLines(input: unknown): ParsedLine[] {
  const lines = requireArray(input, "lines", 100).map((raw, index) => {
    const label = `Line ${index + 1}`;
    const line = asRecord(raw, label);
    const parsed = {
      percentage: parseAllocationPercentage(line.percentage, label),
      departmentId: optionalId(line.departmentId, `${label} department`),
      classId: optionalId(line.classId, `${label} class`),
      locationId: optionalId(line.locationId, `${label} location`),
      projectId: optionalId(line.projectId, `${label} project`),
      rdActivityId: optionalRdActivity(line.rdActivityId, label),
    };
    if (!parsed.departmentId && !parsed.classId && !parsed.locationId && !parsed.projectId && !parsed.rdActivityId) {
      throw new ValidationError(`${label} needs a Department, Class, Location, project or R&D activity.`);
    }
    return parsed;
  });
  const seen = new Map<string, number>();
  lines.forEach((line, index) => {
    const same = [line.departmentId, line.classId, line.locationId, line.projectId, line.rdActivityId].join("|");
    const earlier = seen.get(same);
    if (earlier !== undefined) {
      throw new ValidationError(`Line ${index + 1} is the same as line ${earlier + 1}. Combine them into one line.`);
    }
    seen.set(same, index);
  });
  assertTotalsOneHundred(lines.map((line) => line.percentage));
  return lines;
}

async function checkLineTargets(tx: OrgTx, lines: ParsedLine[]): Promise<void> {
  const valueIds = lines.flatMap((line) => [line.departmentId, line.classId, line.locationId]).filter((id): id is string => id !== null);
  if (valueIds.length > 0) {
    if (!(await advancedFeaturesOn(tx))) {
      throw new ValidationError("Advanced reporting is off, so allocation lines can't have a Department, Class or Location.");
    }
    const values = await tx.query<{ id: string; name: string; is_active: boolean; kind: string }>(
      `select v.id::text, v.name, v.is_active, c.kind
         from tracking_values v join tracking_categories c on c.id = v.category_id
        where v.id = any($1::bigint[])`,
      [valueIds],
    );
    const categories = await tx.query<{ kind: TrackingKind; name: string }>(
      "select kind, name from tracking_categories where kind in ('department', 'class', 'location')",
    );
    const categoryName = new Map(categories.rows.map((row) => [row.kind, row.name]));
    const found = new Map(values.rows.map((row) => [row.id, row]));
    lines.forEach((line, index) => {
      for (const { kind, field } of TRACKING_FIELDS) {
        const id = line[field];
        if (id === null) continue;
        const value = found.get(id);
        if (!value || value.kind !== kind) {
          throw new ValidationError(`Line ${index + 1}: that isn't a ${categoryName.get(kind) ?? kind} value.`);
        }
        if (!value.is_active) throw new ValidationError(`Line ${index + 1}: ${value.name} is archived.`);
      }
    });
  }

  const projectIds = lines.map((line) => line.projectId).filter((id): id is string => id !== null);
  if (projectIds.length > 0) {
    const projects = await tx.query<{ id: string; name: string; status: string }>(
      "select id::text, name, status from projects where id = any($1::bigint[])",
      [projectIds],
    );
    const found = new Map(projects.rows.map((row) => [row.id, row]));
    lines.forEach((line, index) => {
      if (line.projectId === null) return;
      const project = found.get(line.projectId);
      if (!project) throw new ValidationError(`Line ${index + 1}: that project wasn't found.`);
      if (project.status !== "in_progress") throw new ValidationError(`Line ${index + 1}: ${project.name} is closed.`);
    });
  }

  const rdActivityIds = lines.map((line) => line.rdActivityId).filter((id): id is string => id !== null);
  if (rdActivityIds.length > 0) {
    const activities = await tx.query<{ id: string; code: string; status: string }>(
      "select id::text, code, status from rd_activities where id = any($1::uuid[]) for share",
      [rdActivityIds],
    );
    const found = new Map(activities.rows.map((row) => [row.id, row]));
    lines.forEach((line, index) => {
      if (line.rdActivityId === null) return;
      const activity = found.get(line.rdActivityId);
      if (!activity) throw new ValidationError(`Line ${index + 1}: that R&D activity wasn't found.`);
      if (activity.status !== "active") throw new ValidationError(`Line ${index + 1}: ${activity.code} is archived.`);
    });
  }
}

/** Saves a new allocation from `effectiveFrom` (PE3-PE6); earlier ones stay as they were. */
export async function addAllocation(
  tx: OrgTx,
  employeeId: string,
  input: Record<string, unknown>,
): Promise<{ created: boolean; allocation: CostAllocation }> {
  await requirePayrollAccess(tx);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const hash = requestHash("payroll_cost_allocation", { employeeId, effectiveFrom: input.effectiveFrom, lines: input.lines });
  const replay = async () => {
    const earlier = await tx.query<AllocationRow>(`select ${ALLOCATION_COLUMNS} from payroll_cost_allocations where idempotency_key = $1`, [
      idempotencyKey,
    ]);
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].request_hash, hash, "cost allocation");
    return { created: false, allocation: (await loadAllocations(tx, earlier.rows))[0] };
  };
  const earlier = await replay();
  if (earlier) return earlier;

  const startDate = await employeeStartDate(tx, employeeId, true);
  const effectiveFrom = parseIsoDate(input.effectiveFrom, "Effective from");
  if (effectiveFrom < startDate) {
    throw new ValidationError(`A cost allocation can't be before the employee's start date (${startDate}).`);
  }
  const lines = parseLines(input.lines);
  await checkLineTargets(tx, lines);

  const inserted = await tx.query<AllocationRow>(
    `insert into payroll_cost_allocations (employee_id, effective_from, idempotency_key, request_hash, created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (idempotency_key) do nothing
     returning ${ALLOCATION_COLUMNS}`,
    [employeeId, effectiveFrom, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
  );
  const row = inserted.rows[0];
  if (!row) {
    const winner = await replay();
    if (winner) return winner;
    throw new ConflictError("The cost allocation couldn't be saved. Try again with a new idempotency key.");
  }
  await tx.query(
    `insert into payroll_cost_allocation_lines (allocation_id, line_number, percentage, department_id, class_id, location_id, project_id, rd_activity_id)
     select $1, n, p, d, c, l, pr, rd
       from unnest($2::int[], $3::numeric[], $4::bigint[], $5::bigint[], $6::bigint[], $7::bigint[], $8::uuid[]) as t(n, p, d, c, l, pr, rd)`,
    [
      row.id,
      lines.map((_, index) => index + 1),
      lines.map((line) => line.percentage),
      lines.map((line) => line.departmentId),
      lines.map((line) => line.classId),
      lines.map((line) => line.locationId),
      lines.map((line) => line.projectId),
      lines.map((line) => line.rdActivityId),
    ],
  );
  await writeAuditEvent(tx, {
    eventType: "payroll_allocation.added",
    entityType: "payroll_employee",
    entityId: employeeId,
    details: { effectiveFrom, percentages: lines.map((line) => line.percentage) },
  });
  return { created: true, allocation: (await loadAllocations(tx, [row]))[0] };
}
