import { writeAuditEvent } from "@/lib/audit";
import { requireCrm } from "@/lib/crm/switch";
import {
  type ForecastCategory,
  isForecastCategory,
  isStageType,
  MAX_STAGE_NAME,
  type OpportunityStageSetup,
  parseProbability,
  stageKeyFrom,
  stageRuleProblem,
  STAGE_TYPE_LABELS,
  type StageType,
} from "@/lib/crm/forecast-figures";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { optionalBoolean, requireArray, requireId, requireString } from "@/lib/validation";

/**
 * The organisation's opportunity stages and sales processes (examples
 * CRMS1-CRMS4, CRMS7; decisions 76-84), after Salesforce's Stage picklist
 * (type, probability, forecast category) and sales processes. Set-up is
 * for admins (the routes check the role) and needs the CRM on.
 */

export type { OpportunityStageSetup };

type StageRow = {
  id: string;
  key: string;
  name: string;
  sort_order: number;
  stage_type: StageType;
  probability: number;
  forecast_category: ForecastCategory;
  is_active: boolean;
  opportunity_count: number;
};

const STAGE_SELECT = `select s.id::text, s.key, s.name, s.sort_order, s.stage_type, s.probability, s.forecast_category, s.is_active,
    (select count(*)::int from crm_opportunities o where o.stage = s.key) as opportunity_count
  from crm_opportunity_stages s`;

function toStage(row: StageRow): OpportunityStageSetup {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    sortOrder: row.sort_order,
    type: row.stage_type,
    probability: row.probability,
    forecastCategory: row.forecast_category,
    isActive: row.is_active,
    opportunityCount: row.opportunity_count,
  };
}

/** Every stage, archived ones too, in order (CRMS2). */
export async function listStages(tx: OrgTx): Promise<OpportunityStageSetup[]> {
  const result = await tx.query<StageRow>(`${STAGE_SELECT} order by s.sort_order, s.id`);
  return result.rows.map(toStage);
}

export async function getStage(tx: OrgTx, idInput: unknown): Promise<OpportunityStageSetup> {
  const id = requireId(idInput, "stageId");
  const result = await tx.query<StageRow>(`${STAGE_SELECT} where s.id = $1`, [id]);
  if (!result.rows[0]) throw new NotFoundError("Stage not found.");
  return toStage(result.rows[0]);
}

/** A stage by its key, archived or not; null when there's none. */
export async function stageByKey(tx: OrgTx, key: string): Promise<OpportunityStageSetup | null> {
  const result = await tx.query<StageRow>(`${STAGE_SELECT} where s.key = $1`, [key]);
  return result.rows[0] ? toStage(result.rows[0]) : null;
}

function parseName(input: unknown): string {
  return requireString(input, "name", { maxLength: MAX_STAGE_NAME });
}

function parseType(input: unknown): StageType {
  if (!isStageType(input)) throw new ValidationError("The type must be open, won (Closed won) or lost (Closed lost).");
  return input;
}

function parseStageProbability(input: unknown): number {
  const value = parseProbability(input);
  if (value === null) throw new ValidationError("The probability must be a whole number from 0 to 100.");
  return value;
}

function parseCategory(input: unknown): ForecastCategory {
  if (!isForecastCategory(input)) throw new ValidationError("The forecast category must be pipeline, best_case, commit, closed or omitted.");
  return input;
}

function nameTaken(name: string): ConflictError {
  return new ConflictError(`There's already a stage called ${name.toLowerCase()}.`);
}

function isUniqueViolation(error: unknown, index?: string): boolean {
  const e = error as { code?: string; constraint?: string };
  return e.code === "23505" && (index === undefined || e.constraint === index);
}

async function lockStages(tx: OrgTx): Promise<void> {
  await tx.query("select pg_advisory_xact_lock(hashtext('crm_opportunity_stages'))");
}

/** The defaults a type's stage gets when they aren't given: Closed won 100% Closed, Closed lost 0% Omitted, Open 10% Pipeline. */
function typeDefaults(type: StageType): { probability: number; forecastCategory: ForecastCategory } {
  if (type === "won") return { probability: 100, forecastCategory: "closed" };
  if (type === "lost") return { probability: 0, forecastCategory: "omitted" };
  return { probability: 10, forecastCategory: "pipeline" };
}

/**
 * Adds a stage at the end of the list (CRMS2). Its key is made from its
 * name and never changes. A Closed won or Closed lost stage takes 100%
 * Closed or 0% Omitted unless something else is sent (which is refused).
 */
export async function createStage(
  tx: OrgTx,
  input: { name: unknown; type: unknown; probability?: unknown; forecastCategory?: unknown },
): Promise<OpportunityStageSetup> {
  await requireCrm(tx);
  const name = parseName(input.name);
  const type = parseType(input.type);
  const defaults = typeDefaults(type);
  const probability = input.probability === undefined || input.probability === null || input.probability === "" ? defaults.probability : parseStageProbability(input.probability);
  const forecastCategory = input.forecastCategory === undefined || input.forecastCategory === null || input.forecastCategory === "" ? defaults.forecastCategory : parseCategory(input.forecastCategory);
  const problem = stageRuleProblem(type, probability, forecastCategory);
  if (problem) throw new ValidationError(problem);
  await lockStages(tx);
  const taken = await tx.query("select 1 from crm_opportunity_stages where lower(name) = lower($1)", [name]);
  if (taken.rows[0]) throw nameTaken(name);
  const base = stageKeyFrom(name).slice(0, 36);
  const keys = new Set((await tx.query<{ key: string }>("select key from crm_opportunity_stages")).rows.map((row) => row.key));
  let key = base;
  for (let n = 2; keys.has(key); n += 1) key = `${base}_${n}`;
  const order = await tx.query<{ next: number }>("select coalesce(max(sort_order), 0) + 1 as next from crm_opportunity_stages");
  let id: string;
  try {
    const inserted = await tx.query<{ id: string }>(
      `insert into crm_opportunity_stages (key, name, sort_order, stage_type, probability, forecast_category)
       values ($1, $2, $3, $4, $5, $6) returning id::text`,
      [key, name, Number(order.rows[0].next), type, probability, forecastCategory],
    );
    id = inserted.rows[0].id;
  } catch (error) {
    if (isUniqueViolation(error, "crm_opportunity_stages_name_idx")) throw nameTaken(name);
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "crm.stage_created",
    entityType: "crm_opportunity_stage",
    entityId: id,
    details: { key, name, type, probability, forecastCategory },
  });
  return getStage(tx, id);
}

/**
 * Changes a stage (CRMS2, CRMS3): its name, type, default probability and
 * forecast category, whether it's active, and its place (`move`). Its key
 * never changes. Its type can't change while opportunities are in it, and
 * at least one active stage of each type must stay. A new default
 * probability doesn't change the opportunities already in the stage.
 */
export async function updateStage(
  tx: OrgTx,
  idInput: unknown,
  input: { name?: unknown; type?: unknown; probability?: unknown; forecastCategory?: unknown; isActive?: unknown; move?: unknown },
): Promise<OpportunityStageSetup> {
  await requireCrm(tx);
  const found = await getStage(tx, idInput);
  await lockStages(tx);
  const current = await getStage(tx, found.id);
  const name = input.name === undefined ? current.name : parseName(input.name);
  const type = input.type === undefined ? current.type : parseType(input.type);
  const typeChanged = type !== current.type;
  // A new type brings its own fixed figures unless others are sent.
  const base = typeChanged && type !== "open" ? typeDefaults(type) : { probability: current.probability, forecastCategory: current.forecastCategory };
  const probability = input.probability === undefined ? base.probability : parseStageProbability(input.probability);
  const forecastCategory =
    input.forecastCategory === undefined ? (typeChanged && type === "open" && current.forecastCategory === "closed" ? "pipeline" : base.forecastCategory) : parseCategory(input.forecastCategory);
  const isActive = optionalBoolean(input.isActive, "isActive") ?? current.isActive;
  if (input.move !== undefined && input.move !== "up" && input.move !== "down") throw new ValidationError('move must be "up" or "down".');
  const problem = stageRuleProblem(type, probability, forecastCategory);
  if (problem) throw new ValidationError(problem);
  if (typeChanged && current.opportunityCount > 0) throw new ConflictError(`${current.name} has opportunities, so its type can't change.`);
  if (current.isActive && (!isActive || typeChanged)) {
    const others = await tx.query("select 1 from crm_opportunity_stages where stage_type = $1 and is_active and id <> $2", [current.type, current.id]);
    if (!others.rows[0]) {
      throw new ConflictError(`${current.name} is the only active ${STAGE_TYPE_LABELS[current.type]} stage. Add or restore another first.`);
    }
  }
  if (name.toLowerCase() !== current.name.toLowerCase()) {
    const taken = await tx.query("select 1 from crm_opportunity_stages where lower(name) = lower($1) and id <> $2", [name, current.id]);
    if (taken.rows[0]) throw nameTaken(name);
  }

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (name !== current.name) changes.name = { from: current.name, to: name };
  if (typeChanged) changes.type = { from: current.type, to: type };
  if (probability !== current.probability) changes.probability = { from: current.probability, to: probability };
  if (forecastCategory !== current.forecastCategory) changes.forecastCategory = { from: current.forecastCategory, to: forecastCategory };
  if (isActive !== current.isActive) changes.isActive = { from: current.isActive, to: isActive };
  if (input.move !== undefined) {
    const stages = await listStages(tx);
    const index = stages.findIndex((stage) => stage.id === current.id);
    const other = stages[input.move === "up" ? index - 1 : index + 1];
    if (other) {
      const order = stages.map((stage) => stage.id);
      order[index] = other.id;
      order[stages.indexOf(other)] = current.id;
      for (const [position, id] of order.entries()) {
        await tx.query("update crm_opportunity_stages set sort_order = $2 where id = $1", [id, position + 1]);
      }
      changes.move = { from: index + 1, to: stages.indexOf(other) + 1 };
    }
  }
  if (Object.keys(changes).length === 0) return current;
  try {
    await tx.query(
      `update crm_opportunity_stages set name = $2, stage_type = $3, probability = $4, forecast_category = $5, is_active = $6, updated_at = now()
        where id = $1`,
      [current.id, name, type, probability, forecastCategory, isActive],
    );
  } catch (error) {
    if (isUniqueViolation(error, "crm_opportunity_stages_name_idx")) throw nameTaken(name);
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "crm.stage_updated",
    entityType: "crm_opportunity_stage",
    entityId: current.id,
    details: { key: current.key, name, changes },
  });
  return getStage(tx, current.id);
}

// ---------------------------------------------------------------------------
// Sales processes (CRMS7)

export type SalesProcess = {
  recordTypeId: string;
  recordTypeName: string;
  isActive: boolean;
  /** The stages it uses, in the stages' order; null means every active stage. */
  stageKeys: string[] | null;
};

/** Each opportunity record type's sales process. */
export async function listSalesProcesses(tx: OrgTx): Promise<SalesProcess[]> {
  const result = await tx.query<{ id: string; name: string; is_active: boolean; stage_keys: string[] | null }>(
    "select id::text, name, is_active, stage_keys from crm_record_types where record = 'opportunity' order by sort_order, id",
  );
  return result.rows.map((row) => ({ recordTypeId: row.id, recordTypeName: row.name, isActive: row.is_active, stageKeys: row.stage_keys }));
}

async function salesProcessOf(tx: OrgTx, recordTypeId: string): Promise<{ name: string; stageKeys: string[] | null }> {
  const result = await tx.query<{ name: string; stage_keys: string[] | null }>("select name, stage_keys from crm_record_types where id = $1", [recordTypeId]);
  return { name: result.rows[0]?.name ?? "", stageKeys: result.rows[0]?.stage_keys ?? null };
}

/**
 * Sets the stages an opportunity record type uses (CRMS7), or with null
 * takes the list off so it uses every active stage. A list needs at least
 * one active Open, Closed won and Closed lost stage.
 */
export async function setSalesProcess(tx: OrgTx, recordTypeIdInput: unknown, stageKeysInput: unknown): Promise<SalesProcess> {
  await requireCrm(tx);
  const recordTypeId = requireId(recordTypeIdInput, "recordTypeId");
  const type = await tx.query<{ record: string; name: string; stage_keys: string[] | null }>("select record, name, stage_keys from crm_record_types where id = $1", [recordTypeId]);
  if (!type.rows[0]) throw new NotFoundError("Record type not found.");
  if (type.rows[0].record !== "opportunity") throw new ValidationError("Only opportunity record types have a sales process.");
  await lockStages(tx);
  let stageKeys: string[] | null = null;
  if (stageKeysInput !== null) {
    const wanted = requireArray(stageKeysInput, "stageKeys", 100);
    const stages = await listStages(tx);
    const byKey = new Map(stages.map((stage) => [stage.key, stage]));
    const chosen = new Set<string>();
    for (const key of wanted) {
      if (typeof key !== "string" || !byKey.has(key)) throw new ValidationError(`There's no stage called ${String(key)}.`);
      if (chosen.has(key)) throw new ValidationError(`${byKey.get(key)!.name} is in the sales process more than once.`);
      chosen.add(key);
    }
    const active = stages.filter((stage) => chosen.has(stage.key) && stage.isActive);
    if (!(["open", "won", "lost"] as const).every((t) => active.some((stage) => stage.type === t))) {
      throw new ValidationError("A sales process needs at least one Open, one Closed won and one Closed lost stage.");
    }
    stageKeys = stages.filter((stage) => chosen.has(stage.key)).map((stage) => stage.key);
  }
  await tx.query("update crm_record_types set stage_keys = $2, updated_at = now() where id = $1", [recordTypeId, stageKeys]);
  await writeAuditEvent(tx, {
    eventType: "crm.sales_process_updated",
    entityType: "crm_record_type",
    entityId: recordTypeId,
    details: { name: type.rows[0].name, stageKeys, stageKeysFrom: type.rows[0].stage_keys },
  });
  return (await listSalesProcesses(tx)).find((process) => process.recordTypeId === recordTypeId)!;
}

/**
 * The stage an opportunity is to be in (CRMS3, CRMS7): the one asked for,
 * else the one it's in, else the first active Open stage of its record
 * type's process. A stage it's moving to must be active and in the
 * process; one it's already in (archived or not in the process) can stay.
 */
export async function chooseStage(
  tx: OrgTx,
  input: unknown,
  current: { key: string; recordTypeId: string } | null,
  recordTypeId: string,
): Promise<OpportunityStageSetup> {
  const process = await salesProcessOf(tx, recordTypeId);
  const inProcess = (key: string) => process.stageKeys === null || process.stageKeys.includes(key);
  if (input === undefined || input === null || input === "") {
    if (current) {
      const stage = await stageByKey(tx, current.key);
      if (!stage) throw new ConflictError(`There's no stage called ${current.key}.`);
      if (current.recordTypeId !== recordTypeId && !inProcess(stage.key)) {
        throw new ValidationError(`${stage.name} isn't in the ${process.name} sales process.`);
      }
      return stage;
    }
    const first = (await listStages(tx)).find((stage) => stage.isActive && stage.type === "open" && inProcess(stage.key));
    if (!first) throw new ConflictError(`There's no active Open stage in the ${process.name} sales process.`);
    return first;
  }
  if (typeof input !== "string") throw new ValidationError("The stage must be a stage's key, like new or won.");
  const stage = await stageByKey(tx, input);
  if (!stage) {
    const keys = (await listStages(tx)).filter((s) => s.isActive).map((s) => s.key);
    throw new ValidationError(`There's no stage called ${input}. The stages are ${keys.join(", ")}.`);
  }
  const staying = current !== null && current.key === stage.key;
  if (!staying && !stage.isActive) throw new ValidationError(`${stage.name} is archived, so it can't be chosen.`);
  if (!inProcess(stage.key) && (!staying || current.recordTypeId !== recordTypeId)) {
    throw new ValidationError(`${stage.name} isn't in the ${process.name} sales process.`);
  }
  return stage;
}
