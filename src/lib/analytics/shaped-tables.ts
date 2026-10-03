import { writeAuditEvent } from "@/lib/audit";
import type { Actor, OrgTx } from "@/lib/db/org-transaction";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { buildShapeQuery, parseShapeSteps, type ShapeColumn, type ShapeStep } from "@/lib/analytics/shaping";
import { dropTable, listTables, previewSelect, replaceTableFromSelect, type CsvLoadResult } from "@/lib/analytics/engine";
import type { OrganisationRecord } from "@/lib/organisations/registry";

export type ShapedLoadRun = {
  id: string;
  shapeId: string | null;
  sourceId: string | null;
  sourceName: string;
  tableName: string;
  fileName: string;
  trigger: "schedule" | "manual";
  status: "running" | "ok" | "failed";
  startedAt: string;
  finishedAt: string | null;
  rowsLoaded: string | null;
  milliseconds: number | null;
  error: string | null;
  requestedByEmail: string | null;
};

export type ShapedTable = {
  id: string;
  name: string;
  tableName: string;
  baseTable: string;
  steps: ShapeStep[];
  createdByEmail: string;
  createdAt: string;
  updatedByEmail: string;
  updatedAt: string;
  lastLoad: ShapedLoadRun | null;
};

type ShapeRow = {
  id: string;
  name: string;
  table_name: string;
  base_table: string;
  steps: unknown;
  created_by_email: string;
  created_at: Date;
  updated_by_email: string;
  updated_at: Date;
};

type DefinitionRow = Pick<ShapeRow, "id" | "table_name" | "base_table" | "steps">;

type RunRow = {
  id: string;
  shape_id: string | null;
  source_id: string | null;
  source_name: string;
  table_name: string;
  file_name: string;
  trigger: "schedule" | "manual";
  status: "running" | "ok" | "failed";
  started_at: Date;
  finished_at: Date | null;
  rows_loaded: string | null;
  milliseconds: number | null;
  error: string | null;
  requested_by_email: string | null;
};

const SHAPE_COLUMNS = "id::text, name, table_name, base_table, steps, created_by_email, created_at, updated_by_email, updated_at";
const RUN_COLUMNS =
  "id::text, shaped_table_id::text as shape_id, source_id::text, source_name, table_name, file_name, trigger, status, started_at, finished_at, rows_loaded::text, milliseconds, error, requested_by_email";

async function requireAnalytics(tx: OrgTx): Promise<void> {
  const result = await tx.query<{ analytics_enabled: boolean }>("select analytics_enabled from organisation_settings where id = true");
  if (result.rows[0]?.analytics_enabled !== true) throw new ConflictError("Analytics is off. An admin can turn it on in Settings › Modules.");
}

function toRun(row: RunRow): ShapedLoadRun {
  return {
    id: row.id,
    shapeId: row.shape_id,
    sourceId: row.source_id,
    sourceName: row.source_name,
    tableName: row.table_name,
    fileName: row.file_name,
    trigger: row.trigger,
    status: row.status,
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    rowsLoaded: row.rows_loaded,
    milliseconds: row.milliseconds,
    error: row.error,
    requestedByEmail: row.requested_by_email,
  };
}

async function getShapeRow(tx: OrgTx, id: string): Promise<ShapeRow> {
  const result = await tx.query<ShapeRow>(`select ${SHAPE_COLUMNS} from analytics_shaped_tables where id = $1`, [/^\d{1,18}$/.test(id) ? id : "0"]);
  if (!result.rows[0]) throw new NotFoundError("That shaped table wasn't found.");
  return result.rows[0];
}

async function lastRuns(tx: OrgTx): Promise<Map<string, ShapedLoadRun>> {
  const result = await tx.query<RunRow>(
    `select distinct on (shaped_table_id) ${RUN_COLUMNS} from analytics_load_runs
      where shaped_table_id is not null order by shaped_table_id, started_at desc, id desc`,
  );
  return new Map(result.rows.map((row) => [row.shape_id!, toRun(row)]));
}

function toShape(row: ShapeRow, lastLoad: ShapedLoadRun | null): ShapedTable {
  return {
    id: row.id,
    name: row.name,
    tableName: row.table_name,
    baseTable: row.base_table,
    steps: parseShapeSteps(row.steps),
    createdByEmail: row.created_by_email,
    createdAt: new Date(row.created_at).toISOString(),
    updatedByEmail: row.updated_by_email,
    updatedAt: new Date(row.updated_at).toISOString(),
    lastLoad,
  };
}

export async function listShapedTables(tx: OrgTx): Promise<ShapedTable[]> {
  await requireAnalytics(tx);
  const result = await tx.query<ShapeRow>(`select ${SHAPE_COLUMNS} from analytics_shaped_tables order by name, id`);
  const runs = await lastRuns(tx);
  return result.rows.map((row) => toShape(row, runs.get(row.id) ?? null));
}

export async function getShapedTable(tx: OrgTx, id: string): Promise<ShapedTable> {
  await requireAnalytics(tx);
  const row = await getShapeRow(tx, id);
  const runs = await lastRuns(tx);
  return toShape(row, runs.get(row.id) ?? null);
}

function dependencies(baseTable: string, steps: ShapeStep[]): string[] {
  return [...new Set([baseTable, ...steps.flatMap((step) => (step.type === "merge" || step.type === "append" ? [step.table] : []))])];
}

function hasDependencyCycle(definitions: Array<DefinitionRow & { steps: unknown }>): boolean {
  const byName = new Map(definitions.map((shape) => [shape.table_name, shape]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): boolean => {
    if (visiting.has(name)) return true;
    if (visited.has(name)) return false;
    const shape = byName.get(name);
    if (!shape) return false;
    visiting.add(name);
    const needs = dependencies(shape.base_table, parseShapeSteps(shape.steps));
    if (needs.some((dependency) => visit(dependency))) return true;
    visiting.delete(name);
    visited.add(name);
    return false;
  };
  return [...byName.keys()].some(visit);
}

async function validateDefinition(
  tx: OrgTx,
  input: Record<string, unknown>,
  current?: ShapedTable,
): Promise<{ name: string; tableName: string; baseTable: string; steps: ShapeStep[] }> {
  const name = input.name === undefined && current ? current.name : typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 100) throw new ValidationError("Give the shaped table a name (up to 100 characters).");
  const tableName = input.tableName === undefined && current ? current.tableName : typeof input.tableName === "string" ? input.tableName : "";
  if (current && tableName !== current.tableName) throw new ValidationError("A shaped table's output name can't change.");
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(tableName) || tableName.startsWith("tohyee_") || tableName.startsWith("_tohyee")) {
    throw new ValidationError("The output table name must start with a letter, use lower-case letters, digits and _, and not start with tohyee_.");
  }
  const baseTable = input.baseTable === undefined && current ? current.baseTable : typeof input.baseTable === "string" ? input.baseTable : "";
  const steps = parseShapeSteps(input.steps === undefined && current ? current.steps : input.steps);
  const existing = await tx.query<Array<{ id: string; table_name: string; base_table: string; steps: unknown }>[number]>(
    "select id::text, table_name, base_table, steps from analytics_shaped_tables",
  );
  const duplicate = await tx.query<{ table_name: string }>("select table_name from analytics_sources where table_name = $1", [tableName]);
  if (duplicate.rows.length > 0) throw new ConflictError(`A CSV source already loads into ${tableName}.`);
  if (existing.rows.some((shape) => shape.table_name === tableName && shape.id !== current?.id)) {
    throw new ConflictError(`Another shaped table already uses ${tableName}.`);
  }
  const tables = await listTables(tx.organisationId);
  if (!tables.has(baseTable)) throw new ValidationError(`There's no loaded table called ${baseTable}. Load it before shaping it.`);
  if (tables.has(tableName) && tableName !== current?.tableName) throw new ConflictError(`A loaded table already uses ${tableName}.`);
  const candidate = { id: current?.id ?? "new", table_name: tableName, base_table: baseTable, steps };
  const definitions = existing.rows.filter((shape) => shape.id !== current?.id).concat(candidate);
  if (hasDependencyCycle(definitions)) throw new ValidationError("Shaped tables can't depend on themselves or form a cycle.");
  const available = new Map([...tables].map(([table, columns]) => [table, columns.map((column) => ({ name: column.name, type: column.type }))]));
  buildShapeQuery({ baseTable, tables: available, steps });
  return { name, tableName, baseTable, steps };
}

export async function createShapedTable(tx: OrgTx, input: Record<string, unknown>): Promise<ShapedTable> {
  await requireAnalytics(tx);
  const values = await validateDefinition(tx, input);
  const result = await tx.query<{ id: string }>(
    `insert into analytics_shaped_tables (name, table_name, base_table, steps, created_by_email, updated_by_email)
     values ($1, $2, $3, $4::jsonb, $5, $5) returning id::text`,
    [values.name, values.tableName, values.baseTable, JSON.stringify(values.steps), tx.actor.email],
  );
  const id = result.rows[0].id;
  await writeAuditEvent(tx, {
    eventType: "analytics.shaped_table_created",
    entityType: "analytics_shaped_table",
    entityId: id,
    details: { name: values.name, tableName: values.tableName, baseTable: values.baseTable, steps: values.steps.length },
  });
  return getShapedTable(tx, id);
}

export async function updateShapedTable(tx: OrgTx, id: string, input: Record<string, unknown>): Promise<ShapedTable> {
  await requireAnalytics(tx);
  const current = await getShapedTable(tx, id);
  const values = await validateDefinition(tx, input, current);
  await tx.query(
    `update analytics_shaped_tables set name = $2, base_table = $3, steps = $4::jsonb, updated_by_email = $5, updated_at = now()
      where id = $1`,
    [current.id, values.name, values.baseTable, JSON.stringify(values.steps), tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "analytics.shaped_table_updated",
    entityType: "analytics_shaped_table",
    entityId: current.id,
    details: { name: values.name, baseTable: values.baseTable, steps: values.steps.length },
  });
  return getShapedTable(tx, current.id);
}

/** The shaped tables built on a table (as their base, or merged or appended), by name. */
export async function shapesUsing(tx: OrgTx, tableName: string, exceptId?: string): Promise<string[]> {
  const result = await tx.query<{ id: string; name: string; base_table: string; steps: unknown }>(
    "select id::text, name, base_table, steps from analytics_shaped_tables order by name",
  );
  return result.rows
    .filter((shape) => shape.id !== exceptId && dependencies(shape.base_table, parseShapeSteps(shape.steps)).includes(tableName))
    .map((shape) => shape.name);
}

export async function removeShapedTable(organisation: OrganisationRecord, actor: Actor, id: string): Promise<void> {
  const tableName = await withOrganisationTransaction(organisation, actor, async (tx) => {
    await requireAnalytics(tx);
    const current = await getShapedTable(tx, id);
    const users = await shapesUsing(tx, current.tableName, current.id);
    if (users.length > 0) throw new ConflictError(`${users.join(", ")} ${users.length === 1 ? "uses" : "use"} this table. Change or remove ${users.length === 1 ? "it" : "them"} first.`);
    const running = await tx.query("select 1 from analytics_load_runs where shaped_table_id = $1 and status = 'running'", [current.id]);
    if (running.rows.length > 0) throw new ConflictError("That table is rebuilding. Try again when it's finished.");
    await tx.query("delete from analytics_shaped_tables where id = $1", [current.id]);
    await writeAuditEvent(tx, {
      eventType: "analytics.shaped_table_deleted",
      entityType: "analytics_shaped_table",
      entityId: current.id,
      details: { name: current.name, tableName: current.tableName },
    });
    return current.tableName;
  });
  await dropTable(organisation.id, tableName);
}

export async function previewShapedTable(
  organisationId: string,
  baseTable: string,
  steps: unknown,
  throughStep?: number,
): Promise<{ columns: ShapeColumn[]; rows: Array<Record<string, string | null>> }> {
  const tables = await listTables(organisationId);
  const available = new Map([...tables].map(([table, columns]) => [table, columns.map((column) => ({ name: column.name, type: column.type }))]));
  const built = buildShapeQuery({ baseTable, tables: available, steps, throughStep });
  return { columns: built.columns, rows: await previewSelect(organisationId, built.sql, built.params) };
}

async function recordShapeLoad(
  organisation: OrganisationRecord,
  actor: Actor,
  id: string,
  trigger: "schedule" | "manual",
): Promise<{ runId: string; shape: ShapedTable }> {
  return withOrganisationTransaction(organisation, actor, async (tx) => {
    await requireAnalytics(tx);
    await tx.query(
      `update analytics_load_runs set status = 'failed', finished_at = now(), error = 'The rebuild was cut off (the server stopped).'
        where shaped_table_id = $1 and status = 'running' and started_at < now() - interval '1 hour'`,
      [/^\d{1,18}$/.test(id) ? id : "0"],
    );
    const shape = await getShapedTable(tx, id);
    const busy = await tx.query("select 1 from analytics_load_runs where shaped_table_id = $1 and status = 'running'", [shape.id]);
    if (busy.rows.length > 0) throw new ConflictError("That shaped table is already rebuilding.");
    const result = await tx.query<{ id: string }>(
      `insert into analytics_load_runs (shaped_table_id, source_name, table_name, file_name, trigger, requested_by_email)
       values ($1, $2, $3, $4, $5, $6) returning id::text`,
      [shape.id, shape.name, shape.tableName, shape.baseTable, trigger, trigger === "manual" ? actor.email : null],
    );
    return { runId: result.rows[0].id, shape };
  });
}

export async function runShapedTable(
  organisation: OrganisationRecord,
  actor: Actor,
  id: string,
  trigger: "schedule" | "manual",
): Promise<ShapedLoadRun> {
  const started = await recordShapeLoad(organisation, actor, id, trigger);
  let outcome: CsvLoadResult | null = null;
  let error: string | null = null;
  try {
    const tables = await listTables(organisation.id);
    const available = new Map([...tables].map(([table, columns]) => [table, columns.map((column) => ({ name: column.name, type: column.type }))]));
    const built = buildShapeQuery({ baseTable: started.shape.baseTable, tables: available, steps: started.shape.steps });
    outcome = await replaceTableFromSelect(organisation.id, started.shape.tableName, built.sql, built.params);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return withOrganisationTransaction(organisation, actor, async (tx) => {
    const result = await tx.query<RunRow>(
      `update analytics_load_runs set status = $2, finished_at = now(), rows_loaded = $3, milliseconds = $4, error = $5
        where id = $1 returning ${RUN_COLUMNS}`,
      [started.runId, error ? "failed" : "ok", outcome ? String(outcome.rows) : null, outcome?.milliseconds ?? null, error],
    );
    return toRun(result.rows[0]);
  });
}

export async function rebuildShapedTablesForTables(
  organisation: OrganisationRecord,
  actor: Actor,
  changedTables: string[],
  trigger: "schedule" | "manual",
  /** Changed tables that failed to rebuild: the shapes on them are skipped, with the reason. */
  failedTables: string[] = [],
): Promise<ShapedLoadRun[]> {
  const definitions = await withOrganisationTransaction(organisation, actor, async (tx) => {
    await requireAnalytics(tx);
    const result = await tx.query<DefinitionRow>(`select id::text, table_name, base_table, steps from analytics_shaped_tables`);
    return result.rows.map((row) => ({ ...row, steps: parseShapeSteps(row.steps) }));
  });
  const byName = new Map(definitions.map((shape) => [shape.table_name, shape]));
  const impacted = new Set(changedTables);
  const selected = new Set<string>();
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const shape of definitions) {
      if (!selected.has(shape.id) && dependencies(shape.base_table, shape.steps).some((name) => impacted.has(name))) {
        selected.add(shape.id);
        impacted.add(shape.table_name);
        expanded = true;
      }
    }
  }
  const ordered: typeof definitions = [];
  const visited = new Set<string>();
  const visit = (shape: (typeof definitions)[number]) => {
    if (visited.has(shape.id)) return;
    visited.add(shape.id);
    for (const dependency of dependencies(shape.base_table, shape.steps)) {
      const upstream = byName.get(dependency);
      if (upstream && selected.has(upstream.id)) visit(upstream);
    }
    ordered.push(shape);
  };
  for (const shape of definitions) if (selected.has(shape.id)) visit(shape);
  const runs: ShapedLoadRun[] = [];
  const failed = new Set<string>(failedTables);
  for (const shape of ordered) {
    // Built on a table that just failed to rebuild: left as it was rather than built from stale data.
    const brokenUpstream = dependencies(shape.base_table, shape.steps).find((name) => failed.has(name));
    const run = brokenUpstream
      ? await recordSkippedShape(organisation, actor, shape.id, trigger, `Not rebuilt: ${brokenUpstream} failed to rebuild.`)
      : await runShapedTable(organisation, actor, shape.id, trigger);
    if (run.status === "failed") failed.add(shape.table_name);
    runs.push(run);
  }
  return runs;
}

async function recordSkippedShape(
  organisation: OrganisationRecord,
  actor: Actor,
  id: string,
  trigger: "schedule" | "manual",
  reason: string,
): Promise<ShapedLoadRun> {
  const started = await recordShapeLoad(organisation, actor, id, trigger);
  return withOrganisationTransaction(organisation, actor, async (tx) => {
    const result = await tx.query<RunRow>(
      `update analytics_load_runs set status = 'failed', finished_at = now(), error = $2 where id = $1 returning ${RUN_COLUMNS}`,
      [started.runId, reason],
    );
    return toRun(result.rows[0]);
  });
}

/** Rebuilds one shaped table now, then the shaped tables built on it. Returns the first table's run. */
export async function runShapedTableAndDependents(organisation: OrganisationRecord, actor: Actor, id: string): Promise<ShapedLoadRun> {
  const run = await runShapedTable(organisation, actor, id, "manual");
  await rebuildShapedTablesForTables(organisation, actor, [run.tableName], "manual", run.status === "ok" ? [] : [run.tableName]);
  return run;
}

export async function rebuildShapedTablesForTable(
  organisation: OrganisationRecord,
  actor: Actor,
  table: string,
  trigger: "schedule" | "manual",
): Promise<ShapedLoadRun[]> {
  return rebuildShapedTablesForTables(organisation, actor, [table], trigger);
}
