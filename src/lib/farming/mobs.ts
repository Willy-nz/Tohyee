import { randomUUID } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { roleAtLeast } from "@/lib/auth/roles";
import { parseBankDate } from "@/lib/bank/formats/common";
import { parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { requireFarmAccess, visibleFarmIds } from "@/lib/farming/access";
import {
  BOOKKEEPER_ACTIONS,
  CREATED_HOW,
  type CreatedHow,
  classFrom,
  type Gain,
  isBirthClass,
  kindFrom,
  MOB_ACTIONS,
  type MobAction,
  type MobEventType,
  MOVEMENT_FOR_ACTION,
  mobName,
  weightGain,
} from "@/lib/farming/mob-rules";
import { requireFarming } from "@/lib/farming/paddocks";
import { fileRows, importSource } from "@/lib/farming/soil";
import { factorsWith, type StockUnitFactor, type Stocking, stocking } from "@/lib/farming/stock-units";
import { type Withholding, withholdingText } from "@/lib/farming/treatment-rules";
import { mobWithholdings, paddockWithholdings } from "@/lib/farming/withholding";
import { requestHash } from "@/lib/idempotency";
import { className, findClass, KIND_NAMES, LIVESTOCK_KINDS, type LivestockKind } from "@/lib/livestock/classes";
import { getLivestockSettings, getMovement, recordMovement } from "@/lib/livestock/movements";
import { add, cmp, dec, parseDecimalInput, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { asRecord, optionalId, optionalString, requireArray, requireId, requireOneOf } from "@/lib/validation";

/*
 * Mobs (decisions 1421-1430; examples MOB1-MOB10, common NZ practice, not
 * yet reviewed). A mob is a group of animals of one IRD class on one farm.
 * Where it is comes from its open grazing: a move closes that grazing and
 * opens one in the new paddock (MOB2). Sold, died, born, bought and class
 * changes make (or link) the livestock movement the books count by, when
 * Livestock is on, so the head count is never kept twice (MOB3-MOB7).
 * Everything that happens is a mob event, kept for good.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_HEAD = 100000;
const MAX_IMPORT_ROWS = 2000;

export type MobWeight = { date: string; averageKg: string; weighedHead: number | null; gain: Gain | null };

export type Mob = {
  id: string;
  farmId: string;
  name: string;
  /** The name typed, if any (else the class is the name). */
  ownName: string | null;
  kind: LivestockKind;
  kindName: string;
  classCode: string;
  className: string;
  head: number;
  tagColour: string | null;
  status: "active" | "closed";
  closedOn: string | null;
  paddock: { id: string; name: string; inOn: string; grazingId: string } | null;
  lastWeight: MobWeight | null;
  stockUnits: string | null;
  createdOn: string;
  /** Safe dates from its treatments' withholding (decision 1432); null with none recorded. */
  withholding: Withholding | null;
};

export type MobEvent = {
  id: string;
  mobId: string;
  mobName: string;
  kind: string;
  eventType: MobEventType;
  eventDate: string;
  headChange: number;
  headAfter: number;
  createdHow: string | null;
  fromClassCode: string | null;
  toClassCode: string | null;
  otherMobId: string | null;
  otherMobName: string | null;
  fromPaddockName: string | null;
  toPaddockName: string | null;
  grazingId: string | null;
  livestockMovementId: string | null;
  amount: string | null;
  averageKg: string | null;
  weighedHead: number | null;
  note: string | null;
  createdByEmail: string;
  createdAt: string;
};

export type ActionResult = { mob: Mob; events: MobEvent[]; livestock: "recorded" | "linked" | "off" | "none"; message: string };

function optionalOperationId(input: unknown): string | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input !== "string" || !UUID.test(input)) throw new ValidationError("operationId must be a UUID.");
  return input.toLowerCase();
}

function requireHead(input: unknown, label = "Head", min = 1): number {
  const value = typeof input === "number" ? input : Number(String(input ?? "").replace(/,/g, "").trim() || "NaN");
  if (!Number.isInteger(value) || value < min || value > MAX_HEAD) throw new ValidationError(`${label} must be a whole number from ${min} to ${MAX_HEAD.toLocaleString("en-NZ")}.`);
  return value;
}

function requireBooksRole(tx: OrgTx, what: string) {
  const role = tx.actor.role;
  if (role && !roleAtLeast(role, "bookkeeper")) throw new ForbiddenError(`${what} changes the books' head count. It needs the bookkeeper role or higher.`);
}

async function requireFarmId(tx: OrgTx, input: unknown): Promise<string> {
  await requireFarming(tx);
  const farmId = requireId(input, "farmId");
  const farm = await tx.query("select 1 from farms where id = $1", [farmId]);
  if (!farm.rowCount) throw new NotFoundError("Farm not found.");
  await requireFarmAccess(tx, farmId);
  return farmId;
}

type PaddockRow = { id: string; farm_id: string; name: string; status: string; hectares: string | null };

async function requirePaddock(tx: OrgTx, input: unknown, farmId: string): Promise<PaddockRow> {
  const id = requireId(input, "paddockId");
  const row = await tx.query<PaddockRow>(
    `select p.id::text, p.farm_id::text, p.name, p.status,
            coalesce(p.effective_ha, round((select b.mapped_ha from paddock_boundaries b where b.paddock_id = p.id order by b.id desc limit 1), 2))::text as hectares
       from paddocks p where p.id = $1`,
    [id],
  );
  const paddock = row.rows[0];
  if (!paddock || paddock.farm_id !== farmId) throw new NotFoundError("Paddock not found on this farm.");
  if (paddock.status !== "active") throw new ValidationError(`${paddock.name} is retired.`);
  return paddock;
}

// Loading -------------------------------------------------------------------------------------------

type MobRow = {
  id: string;
  farm_id: string;
  name: string | null;
  kind: LivestockKind;
  class_code: string;
  head: number;
  tag_colour: string | null;
  status: "active" | "closed";
  closed_on: string | null;
  created_on: string;
  paddock_id: string | null;
  paddock_name: string | null;
  in_on: string | null;
  grazing_id: string | null;
};

async function loadFactors(tx: OrgTx): Promise<StockUnitFactor[]> {
  const rows = await tx.query<{ kind: string; class_code: string; factor: string }>("select kind, class_code, factor::text from stock_unit_factors");
  return factorsWith(rows.rows.map((row) => ({ kind: row.kind, classCode: row.class_code, factor: row.factor })));
}

async function loadMobs(tx: OrgTx, where: string, params: unknown[]): Promise<Mob[]> {
  const rows = await tx.query<MobRow>(
    `select m.id::text, m.farm_id::text, m.name, m.kind, m.class_code, m.head, m.tag_colour, m.status, m.closed_on::text,
            (select min(e.event_date) from mob_events e where e.mob_id = m.id)::text as created_on,
            g.paddock_id::text, p.name as paddock_name, g.in_on::text, g.id::text as grazing_id
       from mobs m
       left join grazings g on g.mob_id = m.id and g.status = 'active' and g.out_on is null
       left join paddocks p on p.id = g.paddock_id
      where ${where}
      order by m.status, lower(coalesce(m.name, m.class_code)), m.id`,
    params,
  );
  const ids = rows.rows.map((row) => row.id);
  const weights = ids.length
    ? await tx.query<{ mob_id: string; event_date: string; average_kg: string; weighed_head: number | null }>(
        `select w.mob_id::text, w.event_date::text, w.average_kg::text, w.weighed_head from (
           select e.*, row_number() over (partition by e.mob_id order by e.event_date desc, e.id desc) as n
             from mob_events e where e.event_type = 'weighed' and e.mob_id = any($1::bigint[])) w
          where w.n <= 2 order by w.mob_id, w.n`,
        [ids],
      )
    : { rows: [] };
  const factors = await loadFactors(tx);
  const withholdings = new Map<string, Withholding>();
  for (const farmId of new Set(rows.rows.map((row) => row.farm_id))) for (const [mobId, value] of await mobWithholdings(tx, farmId)) withholdings.set(mobId, value);
  return rows.rows.map((row) => {
    const own = weights.rows.filter((weight) => weight.mob_id === row.id);
    const last = own[0];
    const before = own[1];
    const su = stocking([{ head: row.head, kind: row.kind, classCode: row.class_code }], null, factors);
    return {
      id: row.id,
      farmId: row.farm_id,
      name: mobName({ name: row.name, kind: row.kind, classCode: row.class_code }),
      ownName: row.name,
      kind: row.kind,
      kindName: KIND_NAMES[row.kind] ?? row.kind,
      classCode: row.class_code,
      className: className(row.kind, row.class_code),
      head: row.head,
      tagColour: row.tag_colour,
      status: row.status,
      closedOn: row.closed_on,
      paddock: row.paddock_id ? { id: row.paddock_id, name: row.paddock_name!, inOn: row.in_on!, grazingId: row.grazing_id! } : null,
      lastWeight: last
        ? {
            date: last.event_date,
            averageKg: last.average_kg,
            weighedHead: last.weighed_head,
            gain: before ? weightGain({ date: before.event_date, averageKg: before.average_kg }, { date: last.event_date, averageKg: last.average_kg }) : null,
          }
        : null,
      stockUnits: su.stockUnits,
      createdOn: row.created_on ?? "",
      withholding: withholdings.has(row.id) ? { meatSafeOn: withholdings.get(row.id)!.meatSafeOn, milkSafeFrom: withholdings.get(row.id)!.milkSafeFrom } : null,
    };
  });
}

type EventRow = {
  id: string;
  mob_id: string;
  mob_name: string | null;
  kind: string;
  class_code: string;
  event_type: MobEventType;
  event_date: string;
  head_change: number;
  head_after: number;
  created_how: string | null;
  from_class_code: string | null;
  to_class_code: string | null;
  other_mob_id: string | null;
  other_name: string | null;
  other_kind: string | null;
  other_class: string | null;
  from_paddock: string | null;
  to_paddock: string | null;
  grazing_id: string | null;
  livestock_movement_id: string | null;
  amount: string | null;
  average_kg: string | null;
  weighed_head: number | null;
  note: string | null;
  created_by_email: string;
  created_at: string;
};

export async function loadEvents(tx: OrgTx, where: string, params: unknown[], limit = 500): Promise<MobEvent[]> {
  const rows = await tx.query<EventRow>(
    `select e.id::text, e.mob_id::text, m.name as mob_name, m.kind, m.class_code, e.event_type, e.event_date::text, e.head_change, e.head_after,
            e.created_how, e.from_class_code, e.to_class_code, e.other_mob_id::text, o.name as other_name, o.kind as other_kind, o.class_code as other_class,
            fp.name as from_paddock, tp.name as to_paddock, e.grazing_id::text, e.livestock_movement_id::text, e.amount::text, e.average_kg::text,
            e.weighed_head, e.note, e.created_by_email, e.created_at::text
       from mob_events e join mobs m on m.id = e.mob_id
       left join mobs o on o.id = e.other_mob_id
       left join paddocks fp on fp.id = e.from_paddock_id
       left join paddocks tp on tp.id = e.to_paddock_id
      where ${where}
      order by e.event_date desc, e.id desc limit ${Math.trunc(limit)}`,
    params,
  );
  return rows.rows.map((row) => ({
    id: row.id,
    mobId: row.mob_id,
    mobName: mobName({ name: row.mob_name, kind: row.kind, classCode: row.class_code }),
    kind: row.kind,
    eventType: row.event_type,
    eventDate: row.event_date,
    headChange: row.head_change,
    headAfter: row.head_after,
    createdHow: row.created_how,
    fromClassCode: row.from_class_code,
    toClassCode: row.to_class_code,
    otherMobId: row.other_mob_id,
    otherMobName: row.other_mob_id ? mobName({ name: row.other_name, kind: row.other_kind ?? "", classCode: row.other_class ?? "" }) : null,
    fromPaddockName: row.from_paddock,
    toPaddockName: row.to_paddock,
    grazingId: row.grazing_id,
    livestockMovementId: row.livestock_movement_id,
    amount: row.amount,
    averageKg: row.average_kg,
    weighedHead: row.weighed_head,
    note: row.note,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
  }));
}

/** The farm's mobs (active first; closed ones with `includeClosed`). */
export async function listMobs(tx: OrgTx, input: { farmId: unknown; includeClosed?: unknown }): Promise<Mob[]> {
  const farmId = await requireFarmId(tx, input.farmId);
  const closed = input.includeClosed === true || input.includeClosed === "true" || input.includeClosed === "1";
  return loadMobs(tx, `m.farm_id = $1 ${closed ? "" : "and m.status = 'active'"}`, [farmId]);
}

async function mobRow(tx: OrgTx, idInput: unknown, lock = false): Promise<Mob> {
  await requireFarming(tx);
  const id = requireId(idInput, "mobId");
  if (lock) await tx.query("select 1 from mobs where id = $1 for update", [id]);
  const mob = (await loadMobs(tx, "m.id = $1", [id]))[0];
  if (!mob) throw new NotFoundError("Mob not found.");
  await requireFarmAccess(tx, mob.farmId, "Mob not found.");
  return mob;
}

export async function getMob(tx: OrgTx, idInput: unknown): Promise<{ mob: Mob; events: MobEvent[]; weights: MobWeight[] }> {
  const mob = await mobRow(tx, idInput);
  const events = await loadEvents(tx, "e.mob_id = $1", [mob.id], 300);
  const weighed = events.filter((event) => event.eventType === "weighed").reverse();
  const weights = weighed
    .map((event, index) => ({
      date: event.eventDate,
      averageKg: event.averageKg!,
      weighedHead: event.weighedHead,
      gain: index > 0 ? weightGain({ date: weighed[index - 1].eventDate, averageKg: weighed[index - 1].averageKg! }, { date: event.eventDate, averageKg: event.averageKg! }) : null,
    }))
    .reverse();
  return { mob, events, weights };
}

// Writing -------------------------------------------------------------------------------------------

type EventInput = {
  mobId: string;
  farmId: string;
  eventType: MobEventType;
  eventDate: string;
  headChange?: number;
  headAfter: number;
  createdHow?: string | null;
  fromClassCode?: string | null;
  toClassCode?: string | null;
  otherMobId?: string | null;
  fromPaddockId?: string | null;
  toPaddockId?: string | null;
  grazingId?: string | null;
  livestockMovementId?: string | null;
  amount?: string | null;
  averageKg?: string | null;
  weighedHead?: number | null;
  note?: string | null;
  operationId?: string | null;
  requestHash?: string | null;
};

async function addEvent(tx: OrgTx, input: EventInput): Promise<string> {
  try {
    const row = await tx.query<{ id: string }>(
      `insert into mob_events (mob_id, farm_id, event_type, event_date, head_change, head_after, created_how, from_class_code, to_class_code, other_mob_id,
         from_paddock_id, to_paddock_id, grazing_id, livestock_movement_id, amount, average_kg, weighed_head, note, operation_id, request_hash, created_by_email)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::numeric, $16::numeric, $17, $18, $19, $20, $21) returning id::text`,
      [
        input.mobId,
        input.farmId,
        input.eventType,
        input.eventDate,
        input.headChange ?? 0,
        input.headAfter,
        input.createdHow ?? null,
        input.fromClassCode ?? null,
        input.toClassCode ?? null,
        input.otherMobId ?? null,
        input.fromPaddockId ?? null,
        input.toPaddockId ?? null,
        input.grazingId ?? null,
        input.livestockMovementId ?? null,
        input.amount ?? null,
        input.averageKg ?? null,
        input.weighedHead ?? null,
        input.note ?? null,
        input.operationId ?? null,
        input.requestHash ?? null,
        tx.actor.email,
      ],
    );
    return row.rows[0].id;
  } catch (error) {
    if ((error as { code?: string }).code === "23505" && String((error as { constraint?: string }).constraint ?? "").includes("movement")) {
      throw new ConflictError("That livestock movement is already linked to a mob. A sale or purchase is only counted once.");
    }
    throw error;
  }
}

/** The event an operation id already made (a sync sent again): the same details are done; different ones are refused. */
async function replayedEvent(tx: OrgTx, operationId: string | null, hash: string): Promise<string | null> {
  if (!operationId) return null;
  const row = await tx.query<{ mob_id: string; request_hash: string | null; created_by_email: string }>("select mob_id::text, request_hash, created_by_email from mob_events where operation_id = $1", [operationId]);
  const found = row.rows[0];
  if (!found) {
    const made = await tx.query<{ id: string; request_hash: string | null; created_by_email: string }>("select id::text, request_hash, created_by_email from mobs where operation_id = $1", [operationId]);
    if (!made.rows[0]) return null;
    if (made.rows[0].created_by_email !== tx.actor.email || made.rows[0].request_hash !== hash) throw new ConflictError("This was already sent with different details. Nothing was changed: check it and record it again.");
    return made.rows[0].id;
  }
  if (found.created_by_email !== tx.actor.email || found.request_hash !== hash) throw new ConflictError("This was already sent with different details. Nothing was changed: check it and record it again.");
  return found.mob_id;
}

async function openGrazing(tx: OrgTx, mob: Mob, paddock: PaddockRow, onDate: string, head: number): Promise<string> {
  const freeText = await tx.query<{ mob: string }>("select mob from grazings where paddock_id = $1 and status = 'active' and out_on is null and mob_id is null", [paddock.id]);
  if (freeText.rows[0]) {
    throw new ConflictError(`${paddock.name} has "${freeText.rows[0].mob}" in it, recorded without a mob record. Record its day out, or make it a mob record first.`);
  }
  const row = await tx.query<{ id: string }>(
    "insert into grazings (farm_id, paddock_id, mob, head, in_on, mob_id, created_by_email) values ($1, $2, $3, $4, $5, $6, $7) returning id::text",
    [mob.farmId, paddock.id, mob.name.slice(0, 100), head || null, onDate, mob.id, tx.actor.email],
  );
  return row.rows[0].id;
}

async function closeOpenGrazing(tx: OrgTx, mob: Mob, onDate: string): Promise<void> {
  if (!mob.paddock) return;
  if (onDate < mob.paddock.inOn) throw new ValidationError(`${mob.name} went into ${mob.paddock.name} on ${mob.paddock.inOn}. The date can't be before that.`);
  await tx.query("update grazings set out_on = $2 where id = $1 and out_on is null", [mob.paddock.grazingId, onDate]);
}

async function setHead(tx: OrgTx, mob: Mob, head: number, onDate: string): Promise<void> {
  if (head === 0) {
    await closeOpenGrazing(tx, mob, onDate);
    await tx.query("update mobs set head = 0, status = 'closed', closed_on = $2 where id = $1", [mob.id, onDate]);
    return;
  }
  await tx.query("update mobs set head = $2 where id = $1", [mob.id, head]);
  if (mob.paddock) await tx.query("update grazings set head = $2 where id = $1", [mob.paddock.grazingId, head]);
}

type Linked = { movementId: string | null; livestock: ActionResult["livestock"] };

/**
 * The livestock movement for a head change (MOB3-MOB7): an existing one
 * linked (it must be the same kind, class, type and head, and not voided),
 * or a new one recorded, when Livestock is on. Off, nothing is recorded in
 * the books and the screen says so.
 */
async function movementFor(
  tx: OrgTx,
  input: { type: "sale" | "purchase" | "death" | "birth" | "reclass"; mob: Mob; head: number; date: string; amount: string | null; toClassCode?: string; movementId: unknown; key: string; note: string | null },
): Promise<Linked> {
  const settings = await getLivestockSettings(tx);
  const existingId = optionalId(input.movementId, "movementId");
  if (!settings.enabled) {
    if (existingId) throw new ValidationError("Livestock is off, so there's no movement to link.");
    return { movementId: null, livestock: "off" };
  }
  if (existingId) {
    const movement = await getMovement(tx, existingId);
    if (movement.voided) throw new ValidationError("That livestock movement is voided.");
    if (movement.movementType !== input.type) throw new ValidationError(`That livestock movement isn't a ${input.type}.`);
    if (movement.kind !== input.mob.kind || movement.classCode !== input.mob.classCode) throw new ValidationError(`That livestock movement is for ${className(movement.kind, movement.classCode)}, not ${input.mob.className}.`);
    if (movement.head !== input.head) throw new ValidationError(`That livestock movement is for ${movement.head} head, not ${input.head}.`);
    if (movement.movementDate !== input.date) throw new ValidationError(`That livestock movement is dated ${movement.movementDate}. Use the same date.`);
    return { movementId: movement.id, livestock: "linked" };
  }
  const { movement } = await recordMovement(tx, {
    source: "mobs",
    idempotencyKey: input.key,
    movementType: input.type,
    movementDate: input.date,
    kind: input.mob.kind,
    classCode: input.mob.classCode,
    toClassCode: input.toClassCode,
    head: input.head,
    amount: input.amount,
    note: input.note ?? `${input.mob.name} (mob)`,
  });
  return { movementId: movement.id, livestock: "recorded" };
}

const LIVESTOCK_WORDS: Record<ActionResult["livestock"], string> = {
  recorded: " The livestock head count was updated too.",
  linked: " It's linked to the livestock movement you chose.",
  off: " Livestock is off, so the books' head count wasn't changed.",
  none: "",
};

function optionalAmount(input: unknown): string | null {
  return input === undefined || input === null || input === "" ? null : parseDecimalInput(input, "Amount", { maxScale: 2, allowZero: true });
}

function eventDate(input: unknown): string {
  return input === undefined || input === null || input === "" ? todayIsoDate() : parseIsoDate(input, "The date");
}

/**
 * Adds a mob (MOB1): name (optional), kind, IRD class, head, tag colour and
 * paddock. "Already on the farm" changes no head count (it's in the opening
 * or counted already); "bought" and "born" record the purchase or birth.
 */
export async function createMob(tx: OrgTx, input: Record<string, unknown>): Promise<ActionResult> {
  const farmId = await requireFarmId(tx, input.farmId);
  const name = optionalString(input.name, "Name", { maxLength: 100 });
  const kind = requireOneOf(input.kind, "Kind of stock", LIVESTOCK_KINDS);
  const classCode = typeof input.classCode === "string" ? input.classCode : "";
  if (!findClass(kind, classCode)) throw new ValidationError(`Choose a class of ${KIND_NAMES[kind].toLowerCase()}.`);
  const head = requireHead(input.head);
  const tagColour = optionalString(input.tagColour, "Tag colour", { maxLength: 30 });
  const how = (input.how === undefined || input.how === null || input.how === "" ? "on_farm" : requireOneOf(input.how, "How they came", CREATED_HOW)) as CreatedHow;
  if (how === "bought") requireBooksRole(tx, "Adding bought stock");
  if (how === "born" && !isBirthClass(kind, classCode)) throw new ValidationError(`Births go into the youngest classes. ${className(kind, classCode)} isn't one.`);
  const date = eventDate(input.onDate);
  const amount = how === "bought" ? optionalAmount(input.amount) : null;
  const note = optionalString(input.note, "Note", { maxLength: 500 });
  const paddockId = optionalId(input.paddockId, "paddockId");
  const operationId = optionalOperationId(input.operationId);
  const hash = requestHash("mob_create", { farmId, name, kind, classCode, head, tagColour, how, date, amount, paddockId, note, movementId: input.movementId ?? null });
  const again = await replayedEvent(tx, operationId, hash);
  if (again) return { mob: await mobRow(tx, again), events: await loadEvents(tx, "e.mob_id = $1", [again], 5), livestock: "none", message: "Already recorded." };
  if (name) {
    const taken = await tx.query("select 1 from mobs where farm_id = $1 and status = 'active' and lower(name) = lower($2)", [farmId, name]);
    if (taken.rowCount) throw new ConflictError(`There's already a mob called ${name} on this farm.`);
  }
  const paddock = paddockId ? await requirePaddock(tx, paddockId, farmId) : null;
  const row = await tx.query<{ id: string }>(
    "insert into mobs (farm_id, name, kind, class_code, head, tag_colour, operation_id, request_hash, created_by_email) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id::text",
    [farmId, name, kind, classCode, head, tagColour, operationId, operationId ? hash : null, tx.actor.email],
  );
  const mob = await mobRow(tx, row.rows[0].id);
  const linked: Linked =
    how === "on_farm"
      ? { movementId: null, livestock: "none" }
      : await movementFor(tx, { type: how === "bought" ? "purchase" : "birth", mob, head, date, amount, movementId: input.movementId, key: `mob-create-${operationId ?? randomUUID()}`, note });
  const grazingId = paddock ? await openGrazing(tx, mob, paddock, date, head) : null;
  await addEvent(tx, { mobId: mob.id, farmId, eventType: "created", eventDate: date, headChange: head, headAfter: head, createdHow: how, toPaddockId: paddock?.id ?? null, grazingId, livestockMovementId: linked.movementId, amount, note });
  await writeAuditEvent(tx, { eventType: "farming.mob_added", entityType: "mob", entityId: mob.id, details: { farmId, name, kind, classCode, head, how, paddockId: paddock?.id ?? null } });
  const result = await mobRow(tx, mob.id);
  return { mob: result, events: await loadEvents(tx, "e.mob_id = $1", [mob.id], 5), livestock: linked.livestock, message: `${result.name} added.${LIVESTOCK_WORDS[linked.livestock]}` };
}

/**
 * One action on a mob (MOB2-MOB9): move, weigh, deaths, births, split,
 * merge, sell, buy, reclass or count. `operationId` makes a phone's resend
 * find the first (decision 912).
 */
export async function mobAction(tx: OrgTx, mobIdInput: unknown, input: Record<string, unknown>): Promise<ActionResult> {
  const action = requireOneOf(input.action, "action", MOB_ACTIONS) as MobAction;
  if (BOOKKEEPER_ACTIONS.includes(action)) requireBooksRole(tx, action === "sell" ? "Selling" : action === "buy" ? "Adding bought stock" : "Changing class");
  const operationId = optionalOperationId(input.operationId);
  const { organisationId: _organisationId, operationId: _operationId, ...rest } = input;
  void _organisationId;
  void _operationId;
  const hash = requestHash("mob_action", { mobId: String(mobIdInput), ...rest });
  const again = await replayedEvent(tx, operationId, hash);
  if (again) return { mob: await mobRow(tx, mobIdInput), events: [], livestock: "none", message: "Already recorded." };
  const mob = await mobRow(tx, mobIdInput, true);
  if (input.farmId !== undefined && input.farmId !== null && input.farmId !== "" && requireId(input.farmId, "farmId") !== mob.farmId) {
    throw new ConflictError(`${mob.name} isn't on the farm this was recorded for. Nothing was saved: check the farm and try again.`);
  }
  if (mob.status !== "active") throw new ValidationError(`${mob.name} is closed.`);
  const date = eventDate(input.onDate);
  if (mob.createdOn && date < mob.createdOn) throw new ValidationError(`${mob.name} was added on ${mob.createdOn}. The date can't be before that.`);
  const note = optionalString(input.note, "Note", { maxLength: 500 });
  const base = { mobId: mob.id, farmId: mob.farmId, eventDate: date, note, operationId, requestHash: operationId ? hash : null };
  const key = `mob-${operationId ?? randomUUID()}`;
  let livestock: ActionResult["livestock"] = "none";
  let message = "";

  switch (action) {
    case "move": {
      const to = input.toPaddockId === undefined || input.toPaddockId === null || input.toPaddockId === "" ? null : await requirePaddock(tx, input.toPaddockId, mob.farmId);
      if (to && mob.paddock?.id === to.id) throw new ValidationError(`${mob.name} is already in ${to.name}.`);
      if (!to && !mob.paddock) throw new ValidationError(`${mob.name} isn't in a paddock. Choose where it's going.`);
      await closeOpenGrazing(tx, mob, date);
      const grazingId = to ? await openGrazing(tx, mob, to, date, mob.head) : null;
      // The move it was planned as is done (decision 1443).
      if (to && grazingId) {
        await tx.query(
          `update grazing_plans set status = 'done', done_grazing_id = $3
            where id = (select g.id from grazing_plans g where g.mob_id = $1 and g.paddock_id = $2 and g.status = 'planned' order by g.planned_on, g.id limit 1)`,
          [mob.id, to.id, grazingId],
        );
      }
      await addEvent(tx, { ...base, eventType: "moved", headAfter: mob.head, fromPaddockId: mob.paddock?.id ?? null, toPaddockId: to?.id ?? null, grazingId });
      message = to ? `${mob.name} moved to ${to.name}.` : `${mob.name} is out of ${mob.paddock!.name}.`;
      // Warn, don't block (decision 1433): the paddock was sprayed and isn't safe to graze yet.
      const sprayed = to ? (await paddockWithholdings(tx, mob.farmId, date)).get(to.id) : null;
      if (sprayed) message += ` Warning: ${to!.name} isn't safe to graze until ${sprayed.until}${sprayed.product ? ` (sprayed with ${sprayed.product})` : ""}.`;
      break;
    }
    case "weigh": {
      const averageKg = parseDecimalInput(input.averageKg, "Average weight", { maxScale: 1 });
      if (cmp(dec(averageKg), ZERO_DECIMAL) <= 0 || cmp(dec(averageKg), dec("2000")) > 0) throw new ValidationError("Average weight must be more than 0 and at most 2,000 kg.");
      const weighedHead = input.weighedHead === undefined || input.weighedHead === null || input.weighedHead === "" ? null : requireHead(input.weighedHead, "Head weighed");
      if (weighedHead && weighedHead > mob.head) throw new ValidationError(`${mob.name} has ${mob.head} head; ${weighedHead} can't be weighed.`);
      await addEvent(tx, { ...base, eventType: "weighed", headAfter: mob.head, averageKg, weighedHead });
      message = `Weight recorded for ${mob.name}.`;
      break;
    }
    case "count": {
      const head = requireHead(input.head, "Head counted");
      if (head === mob.head) throw new ValidationError(`${mob.name} already has ${head} head.`);
      await setHead(tx, mob, head, date);
      await addEvent(tx, { ...base, eventType: "counted", headChange: head - mob.head, headAfter: head });
      message = `${mob.name} now has ${head} head. The books' head count isn't changed by a count: record deaths, sales or births for those.`;
      break;
    }
    case "deaths":
    case "sell": {
      const head = requireHead(input.head);
      if (head > mob.head) throw new ValidationError(`${mob.name} has ${mob.head} head.`);
      const amount = action === "sell" ? optionalAmount(input.amount) : null;
      const linked = await movementFor(tx, { type: MOVEMENT_FOR_ACTION[action]!, mob, head, date, amount, movementId: input.movementId, key, note });
      livestock = linked.livestock;
      const after = mob.head - head;
      await addEvent(tx, { ...base, eventType: action === "sell" ? "sold" : "died", headChange: -head, headAfter: after, livestockMovementId: linked.movementId, amount });
      await setHead(tx, mob, after, date);
      message = `${head} ${action === "sell" ? "sold" : "died"} from ${mob.name}${after === 0 ? `; ${mob.name} is closed` : ""}.`;
      // A sale within a withholding period is a warning, not a block (decision 1433): the person knows where the stock is going.
      const held = action === "sell" ? withholdingText(mob.withholding, date) : null;
      if (held) message += ` Warning: ${mob.name} is within a withholding period (${held.replace(/^Withholding: /, "")}).`;
      break;
    }
    case "births":
    case "buy": {
      const head = requireHead(input.head);
      if (mob.head + head > MAX_HEAD) throw new ValidationError("A mob can have at most 100,000 head.");
      if (action === "births" && !isBirthClass(mob.kind, mob.classCode)) {
        throw new ValidationError(`Births go into the youngest classes. ${mob.className} isn't one: add a new mob for the young stock.`);
      }
      const amount = action === "buy" ? optionalAmount(input.amount) : null;
      const linked = await movementFor(tx, { type: MOVEMENT_FOR_ACTION[action]!, mob, head, date, amount, movementId: input.movementId, key, note });
      livestock = linked.livestock;
      await addEvent(tx, { ...base, eventType: action === "buy" ? "bought" : "born", headChange: head, headAfter: mob.head + head, livestockMovementId: linked.movementId, amount });
      await setHead(tx, mob, mob.head + head, date);
      message = `${head} ${action === "buy" ? "bought" : "born"} into ${mob.name}.`;
      break;
    }
    case "reclass": {
      const toClassCode = typeof input.toClassCode === "string" ? input.toClassCode : "";
      if (!findClass(mob.kind, toClassCode)) throw new ValidationError(`Choose a class of ${mob.kindName.toLowerCase()}.`);
      if (toClassCode === mob.classCode) throw new ValidationError("That's the class it's in now.");
      const linked = await movementFor(tx, { type: "reclass", mob, head: mob.head, date, amount: null, toClassCode, movementId: input.movementId, key, note });
      livestock = linked.livestock;
      await tx.query("update mobs set class_code = $2 where id = $1", [mob.id, toClassCode]);
      await addEvent(tx, { ...base, eventType: "reclass", headAfter: mob.head, fromClassCode: mob.classCode, toClassCode, livestockMovementId: linked.movementId });
      message = `${mob.name} is now ${className(mob.kind, toClassCode).toLowerCase()}.`;
      break;
    }
    case "split": {
      const head = requireHead(input.head);
      if (head >= mob.head) throw new ValidationError(`A split takes some of ${mob.name}'s ${mob.head} head, not all of them.`);
      const name = optionalString(input.name, "New mob's name", { maxLength: 100 });
      if (name) {
        const taken = await tx.query("select 1 from mobs where farm_id = $1 and status = 'active' and lower(name) = lower($2)", [mob.farmId, name]);
        if (taken.rowCount) throw new ConflictError(`There's already a mob called ${name} on this farm.`);
      }
      const to = input.toPaddockId ? await requirePaddock(tx, input.toPaddockId, mob.farmId) : mob.paddock ? await requirePaddock(tx, mob.paddock.id, mob.farmId) : null;
      const made = await tx.query<{ id: string }>(
        "insert into mobs (farm_id, name, kind, class_code, head, tag_colour, created_by_email) values ($1, $2, $3, $4, $5, $6, $7) returning id::text",
        [mob.farmId, name, mob.kind, mob.classCode, head, optionalString(input.tagColour, "Tag colour", { maxLength: 30 }) ?? mob.tagColour, tx.actor.email],
      );
      const newMob = await mobRow(tx, made.rows[0].id);
      const grazingId = to ? await openGrazing(tx, newMob, to, date, head) : null;
      await addEvent(tx, { ...base, eventType: "split_out", headChange: -head, headAfter: mob.head - head, otherMobId: newMob.id });
      await addEvent(tx, { mobId: newMob.id, farmId: mob.farmId, eventDate: date, eventType: "split_in", headChange: head, headAfter: head, createdHow: "split", otherMobId: mob.id, toPaddockId: to?.id ?? null, grazingId, note });
      await setHead(tx, mob, mob.head - head, date);
      message = `${head} split from ${mob.name} into ${newMob.name}${to ? ` in ${to.name}` : ""}.`;
      break;
    }
    case "merge": {
      const intoId = requireId(input.intoMobId, "intoMobId");
      if (intoId === mob.id) throw new ValidationError("Choose another mob to merge into.");
      const into = await mobRow(tx, intoId, true);
      if (into.farmId !== mob.farmId) throw new ValidationError("Mobs on different farms can't be merged.");
      if (into.status !== "active") throw new ValidationError(`${into.name} is closed.`);
      if (into.kind !== mob.kind || into.classCode !== mob.classCode) {
        throw new ValidationError(`${mob.name} is ${mob.className.toLowerCase()} and ${into.name} is ${into.className.toLowerCase()}. Change one's class first: a mob is one class.`);
      }
      if (into.head + mob.head > MAX_HEAD) throw new ValidationError("A mob can have at most 100,000 head.");
      await addEvent(tx, { ...base, eventType: "merged_out", headChange: -mob.head, headAfter: 0, otherMobId: into.id });
      await addEvent(tx, { mobId: into.id, farmId: into.farmId, eventDate: date, eventType: "merged_in", headChange: mob.head, headAfter: into.head + mob.head, otherMobId: mob.id, note });
      await setHead(tx, into, into.head + mob.head, date);
      await setHead(tx, mob, 0, date);
      message = `${mob.name} merged into ${into.name}, which now has ${into.head + mob.head} head.`;
      break;
    }
  }
  await writeAuditEvent(tx, { eventType: `farming.mob_${action}`, entityType: "mob", entityId: mob.id, details: { ...rest, onDate: date } });
  return { mob: await mobRow(tx, mob.id), events: await loadEvents(tx, "e.mob_id = $1", [mob.id], 5), livestock, message: `${message}${LIVESTOCK_WORDS[livestock]}` };
}

/** Renames a mob or changes its tag colour (name and tag aren't history). */
export async function updateMob(tx: OrgTx, idInput: unknown, input: { name?: unknown; tagColour?: unknown }): Promise<Mob> {
  const mob = await mobRow(tx, idInput, true);
  const name = input.name === undefined ? mob.ownName : optionalString(input.name, "Name", { maxLength: 100 });
  const tagColour = input.tagColour === undefined ? mob.tagColour : optionalString(input.tagColour, "Tag colour", { maxLength: 30 });
  if (name && name.toLowerCase() !== (mob.ownName ?? "").toLowerCase()) {
    const taken = await tx.query("select 1 from mobs where farm_id = $1 and status = 'active' and lower(name) = lower($2) and id <> $3", [mob.farmId, name, mob.id]);
    if (taken.rowCount) throw new ConflictError(`There's already a mob called ${name} on this farm.`);
  }
  await tx.query("update mobs set name = $2, tag_colour = $3 where id = $1", [mob.id, name, tagColour]);
  await writeAuditEvent(tx, { eventType: "farming.mob_updated", entityType: "mob", entityId: mob.id, details: { name, tagColour } });
  return mobRow(tx, mob.id);
}

// Stocking rate -------------------------------------------------------------------------------------

export type PaddockStocking = Stocking & { paddockId: string; name: string; mobs: string[] };
export type FarmStocking = {
  farm: Stocking;
  /** Head in paddocks recorded with only a mob name: no class, so no stock units. */
  untypedHead: number;
  paddocks: PaddockStocking[];
  factors: StockUnitFactor[];
};

/**
 * Stocking rate now (MOB10): stock units and head per effective hectare,
 * for each paddock with mobs in it, and the farm (every active mob over the
 * farm's active paddocks' area).
 */
export async function farmStocking(tx: OrgTx, input: { farmId: unknown }): Promise<FarmStocking> {
  const farmId = await requireFarmId(tx, input.farmId);
  const factors = await loadFactors(tx);
  const mobs = await loadMobs(tx, "m.farm_id = $1 and m.status = 'active'", [farmId]);
  const paddocks = await tx.query<{ id: string; name: string; hectares: string | null }>(
    `select p.id::text, p.name,
            coalesce(p.effective_ha, round((select b.mapped_ha from paddock_boundaries b where b.paddock_id = p.id order by b.id desc limit 1), 2))::text as hectares
       from paddocks p where p.farm_id = $1 and p.status = 'active' order by p.name, p.id`,
    [farmId],
  );
  let area = ZERO_DECIMAL;
  for (const paddock of paddocks.rows) if (paddock.hectares) area = add(area, dec(paddock.hectares));
  const untyped = await tx.query<{ head: string | null }>("select sum(head)::text as head from grazings where farm_id = $1 and status = 'active' and out_on is null and mob_id is null", [farmId]);
  const all = mobs.map((mob) => ({ head: mob.head, kind: mob.kind, classCode: mob.classCode }));
  return {
    farm: stocking(all, paddocks.rows.length ? toFixedString(area, 2) : null, factors),
    untypedHead: Number(untyped.rows[0]?.head ?? 0),
    paddocks: paddocks.rows
      .map((paddock) => {
        const here = mobs.filter((mob) => mob.paddock?.id === paddock.id);
        return { paddockId: paddock.id, name: paddock.name, mobs: here.map((mob) => mob.name), ...stocking(here.map((mob) => ({ head: mob.head, kind: mob.kind, classCode: mob.classCode })), paddock.hectares, factors) };
      })
      .filter((paddock) => paddock.mobs.length > 0),
    factors,
  };
}

export async function listStockUnitFactors(tx: OrgTx): Promise<StockUnitFactor[]> {
  await requireFarming(tx);
  return loadFactors(tx);
}

/** Changes stock unit factors (admins); a blank factor goes back to Tohyee's default. */
export async function setStockUnitFactors(tx: OrgTx, input: { lines: unknown }): Promise<StockUnitFactor[]> {
  await requireFarming(tx);
  for (const raw of requireArray(input.lines, "lines", 100)) {
    const line = asRecord(raw, "A factor");
    const kind = requireOneOf(line.kind, "kind", LIVESTOCK_KINDS);
    const classCode = typeof line.classCode === "string" ? line.classCode : "";
    if (!findClass(kind, classCode)) throw new ValidationError(`${KIND_NAMES[kind]} has no class "${classCode}".`);
    if (line.factor === undefined || line.factor === null || line.factor === "") {
      await tx.query("delete from stock_unit_factors where kind = $1 and class_code = $2", [kind, classCode]);
      continue;
    }
    const factor = parseDecimalInput(line.factor, `${className(kind, classCode)} stock units`, { maxScale: 2 });
    if (cmp(dec(factor), ZERO_DECIMAL) <= 0 || cmp(dec(factor), dec("50")) > 0) throw new ValidationError("A stock unit factor is more than 0 and at most 50.");
    await tx.query(
      "insert into stock_unit_factors (kind, class_code, factor, updated_by_email) values ($1, $2, $3::numeric, $4) on conflict (kind, class_code) do update set factor = excluded.factor, updated_by_email = excluded.updated_by_email, updated_at = now()",
      [kind, classCode, factor, tx.actor.email],
    );
  }
  await writeAuditEvent(tx, { eventType: "farming.stock_unit_factors_set", entityType: "stock_unit_factors", entityId: "1", details: { lines: input.lines } });
  return loadFactors(tx);
}

// Grazings typed with a mob name ------------------------------------------------------------------

export type UntypedMob = { mob: string; openIn: string[]; head: number | null; grazings: number };

/** Mob names typed on grazings with no mob record, for "Make mob records" (MOB9). */
export async function untypedMobs(tx: OrgTx, input: { farmId: unknown }): Promise<UntypedMob[]> {
  const farmId = await requireFarmId(tx, input.farmId);
  const rows = await tx.query<{ mob: string; open_in: string[] | null; head: number | null; grazings: number }>(
    `select (array_agg(g.mob order by g.in_on, g.id))[1] as mob, array_remove(array_agg(case when g.out_on is null then p.name end order by p.name), null) as open_in,
            (array_agg(g.head order by g.in_on desc, g.id desc))[1] as head, count(*)::int as grazings
       from grazings g join paddocks p on p.id = g.paddock_id
      where g.farm_id = $1 and g.status = 'active' and g.mob_id is null
      group by lower(g.mob) order by lower(g.mob)`,
    [farmId],
  );
  return rows.rows.map((row) => ({ mob: row.mob, openIn: row.open_in ?? [], head: row.head, grazings: row.grazings }));
}

/**
 * Makes a mob record from a mob name typed on grazings (MOB9): the mob gets
 * the name, a kind, class and head, and every grazing on the farm typed
 * with that name (ignoring case) becomes the mob's. A mob name in two
 * paddocks now is refused: a mob is in one place.
 */
export async function mobFromGrazings(tx: OrgTx, input: Record<string, unknown>): Promise<ActionResult> {
  const farmId = await requireFarmId(tx, input.farmId);
  const typed = typeof input.mob === "string" ? input.mob.trim() : "";
  if (!typed) throw new ValidationError("Choose a mob name from the grazings.");
  const grazings = await tx.query<{ id: string; paddock_id: string; paddock: string; out_on: string | null; head: number | null; in_on: string }>(
    `select g.id::text, g.paddock_id::text, p.name as paddock, g.out_on::text, g.head, g.in_on::text
       from grazings g join paddocks p on p.id = g.paddock_id
      where g.farm_id = $1 and g.status = 'active' and g.mob_id is null and lower(g.mob) = lower($2) for update of g`,
    [farmId, typed],
  );
  if (!grazings.rows.length) throw new NotFoundError(`No grazings on this farm are typed "${typed}" without a mob record.`);
  const open = grazings.rows.filter((row) => row.out_on === null);
  if (open.length > 1) throw new ConflictError(`"${typed}" is in ${open.map((row) => row.paddock).join(" and ")} now. A mob is in one paddock: record a day out for one, or rename one, first.`);
  const kind = requireOneOf(input.kind, "Kind of stock", LIVESTOCK_KINDS);
  const classCode = typeof input.classCode === "string" ? input.classCode : "";
  if (!findClass(kind, classCode)) throw new ValidationError(`Choose a class of ${KIND_NAMES[kind].toLowerCase()}.`);
  const head = requireHead(input.head ?? open[0]?.head ?? grazings.rows[0].head);
  const name = typed.slice(0, 100);
  const taken = await tx.query("select 1 from mobs where farm_id = $1 and status = 'active' and lower(name) = lower($2)", [farmId, name]);
  if (taken.rowCount) throw new ConflictError(`There's already a mob called ${name} on this farm.`);
  const made = await tx.query<{ id: string }>("insert into mobs (farm_id, name, kind, class_code, head, created_by_email) values ($1, $2, $3, $4, $5, $6) returning id::text", [farmId, name, kind, classCode, head, tx.actor.email]);
  const mobId = made.rows[0].id;
  await tx.query("update grazings set mob_id = $1 where id = any($2::bigint[])", [mobId, grazings.rows.map((row) => row.id)]);
  const first = grazings.rows.reduce((min, row) => (row.in_on < min ? row.in_on : min), grazings.rows[0].in_on);
  await addEvent(tx, { mobId, farmId, eventType: "created", eventDate: first, headChange: head, headAfter: head, createdHow: "grazing", toPaddockId: open[0]?.paddock_id ?? null, grazingId: open[0]?.id ?? null, note: `Made from ${grazings.rows.length} grazing${grazings.rows.length === 1 ? "" : "s"} typed "${typed}"` });
  await writeAuditEvent(tx, { eventType: "farming.mob_from_grazings", entityType: "mob", entityId: mobId, details: { farmId, mob: typed, grazings: grazings.rows.length, kind, classCode, head } });
  return { mob: await mobRow(tx, mobId), events: [], livestock: "none", message: `${name} is a mob record now, with its ${grazings.rows.length} grazing${grazings.rows.length === 1 ? "" : "s"}.` };
}

// Import --------------------------------------------------------------------------------------------

export type MobImportRow = {
  line: number;
  name: string | null;
  kind: LivestockKind | null;
  classCode: string | null;
  head: number | null;
  paddockId: string | null;
  paddockName: string | null;
  tagColour: string | null;
  onDate: string | null;
  error: string | null;
};
export type MobImportPreview = { fileName: string; headings: string[]; rows: MobImportRow[]; counts: { mobs: number; errors: number }; alreadyImportedOn: string | null };
type ImportInput = { fileName: unknown; content?: unknown; contentBase64?: unknown };

const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function readMobImport(tx: OrgTx, farmId: string, input: ImportInput) {
  const fileName = typeof input.fileName === "string" && input.fileName.trim() ? input.fileName.trim().slice(0, 200) : "";
  if (!fileName) throw new ValidationError("Choose a file.");
  const { rows: table, sha256 } = await fileRows(fileName, input);
  const start = table.findIndex((cells) => cells.filter((cell) => cell.trim()).length >= 2);
  if (start < 0 || table.length < start + 2) throw new ValidationError("The file needs a heading row and at least one mob.");
  if (table.length - start - 1 > MAX_IMPORT_ROWS) throw new ValidationError(`The file has more than ${MAX_IMPORT_ROWS} mobs.`);
  const headings = table[start].map((cell) => cell.trim());
  const find = (...tests: Array<(heading: string) => boolean>) => {
    for (const test of tests) {
      const index = headings.findIndex((heading) => test(norm(heading)));
      if (index >= 0) return index;
    }
    return null;
  };
  const columns = {
    name: find((h) => h === "mob" || h === "name" || h === "mob name"),
    kind: find((h) => h === "kind" || h === "species" || h === "stock" || h === "type"),
    class: find((h) => h === "class" || h.includes("class")),
    head: find((h) => h === "head" || h === "number" || h === "count" || h.includes("head")),
    paddock: find((h) => h === "paddock" || h.startsWith("paddock")),
    tag: find((h) => h.includes("tag") || h.includes("colour") || h.includes("color")),
    date: find((h) => h === "date" || h.includes("date")),
  };
  if (columns.kind === null || columns.class === null || columns.head === null) throw new ValidationError("The file needs kind (or species), class and head columns.");
  const paddocks = await tx.query<{ id: string; name: string }>("select id::text, name from paddocks where farm_id = $1 and status = 'active'", [farmId]);
  const existing = await tx.query<{ name: string }>("select lower(name) as name from mobs where farm_id = $1 and status = 'active' and name is not null", [farmId]);
  const names = new Set(existing.rows.map((row) => row.name));
  const earlier = await tx.query<{ created_at: string }>("select created_at::text from farm_imports where farm_id = $1 and kind = 'mobs' and sha256 = $2", [farmId, sha256]);
  const rows: MobImportRow[] = table
    .slice(start + 1)
    .map((cells, offset) => ({ cells, line: start + offset + 2 }))
    .filter(({ cells }) => cells.some((cell) => cell.trim()))
    .map(({ cells, line }) => {
      const cell = (index: number | null) => (index === null ? "" : (cells[index] ?? "").trim());
      const name = cell(columns.name).slice(0, 100) || null;
      const kindText = cell(columns.kind);
      const kind = kindFrom(kindText);
      const classText = cell(columns.class);
      const classCode = kind ? classFrom(kind, classText) : null;
      const headText = cell(columns.head).replace(/,/g, "");
      const head = /^\d+$/.test(headText) && Number(headText) >= 1 && Number(headText) <= MAX_HEAD ? Number(headText) : null;
      const paddockText = cell(columns.paddock);
      const paddock = paddockText ? (paddocks.rows.find((row) => row.name.toLowerCase() === paddockText.toLowerCase()) ?? null) : null;
      const dateText = cell(columns.date);
      const onDate = dateText ? parseBankDate(dateText) : todayIsoDate();
      let error: string | null = null;
      if (!kind) error = kindText ? `"${kindText}" isn't a kind of stock Tohyee knows.` : "No kind of stock.";
      else if (!classCode) error = classText ? `"${classText}" isn't a class of ${KIND_NAMES[kind].toLowerCase()}. Use the IRD class name.` : "No class.";
      else if (head === null) error = headText ? `"${headText}" isn't a whole number of head.` : "No head.";
      else if (paddockText && !paddock) error = `No paddock called "${paddockText}" on this farm.`;
      else if (!onDate) error = `"${dateText}" isn't a date.`;
      else if (name && names.has(name.toLowerCase())) error = `There's already a mob called ${name}.`;
      if (!error && name) names.add(name.toLowerCase());
      return { line, name, kind, classCode, head, paddockId: paddock?.id ?? null, paddockName: paddock?.name ?? (paddockText || null), tagColour: cell(columns.tag).slice(0, 30) || null, onDate, error };
    });
  // Two mobs can share a paddock; that's fine (decision 1422).
  return { fileName, sha256, headings, rows, alreadyImportedOn: earlier.rows[0]?.created_at ?? null };
}

export async function previewMobImport(tx: OrgTx, farmIdInput: unknown, input: ImportInput): Promise<MobImportPreview> {
  const farmId = await requireFarmId(tx, farmIdInput);
  const read = await readMobImport(tx, farmId, input);
  const errors = read.rows.filter((row) => row.error).length;
  return { fileName: read.fileName, headings: read.headings, rows: read.rows, counts: { mobs: read.rows.length - errors, errors }, alreadyImportedOn: read.alreadyImportedOn };
}

/** Imports mobs already on the farm (MOB1: no head count changes), each into its paddock if one is given. */
export async function importMobs(tx: OrgTx, farmIdInput: unknown, input: ImportInput): Promise<{ imported: number; skipped: number }> {
  const farmId = await requireFarmId(tx, farmIdInput);
  await tx.query("select 1 from farms where id = $1 for update", [farmId]);
  const read = await readMobImport(tx, farmId, input);
  if (read.alreadyImportedOn) throw new ConflictError(`This file was already imported on ${read.alreadyImportedOn.slice(0, 10)}.`);
  const good = read.rows.filter((row) => !row.error);
  if (!good.length) throw new ValidationError("There are no mobs without errors to import.");
  const source = importSource(read.fileName).slice(0, 500);
  for (const row of good) {
    const made = await tx.query<{ id: string }>("insert into mobs (farm_id, name, kind, class_code, head, tag_colour, created_by_email) values ($1, $2, $3, $4, $5, $6, $7) returning id::text", [
      farmId,
      row.name,
      row.kind,
      row.classCode,
      row.head,
      row.tagColour,
      tx.actor.email,
    ]);
    const mob = await mobRow(tx, made.rows[0].id);
    const grazingId = row.paddockId ? await openGrazing(tx, mob, await requirePaddock(tx, row.paddockId, farmId), row.onDate!, row.head!) : null;
    await addEvent(tx, { mobId: mob.id, farmId, eventType: "created", eventDate: row.onDate!, headChange: row.head!, headAfter: row.head!, createdHow: "import", toPaddockId: row.paddockId, grazingId, note: source });
  }
  const summary = { imported: good.length, skipped: read.rows.length - good.length };
  await tx.query("insert into farm_imports (farm_id, kind, file_name, sha256, summary, created_by_email) values ($1, 'mobs', $2, $3, $4::jsonb, $5)", [farmId, read.fileName, read.sha256, JSON.stringify(summary), tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "farming.mobs_imported", entityType: "farm", entityId: farmId, details: { fileName: read.fileName, ...summary } });
  return summary;
}

/** Every farm's mobs the person can see (for the AI and other farms' views). */
export async function allMobs(tx: OrgTx): Promise<Mob[]> {
  await requireFarming(tx);
  const visible = await visibleFarmIds(tx);
  return visible === null ? loadMobs(tx, "m.status = 'active'", []) : loadMobs(tx, "m.status = 'active' and m.farm_id = any($1::bigint[])", [visible]);
}

export type LinkableMovement = { id: string; movementDate: string; head: number; amount: string | null; invoiceNumber: string | null; billReference: string | null };

/**
 * Livestock movements a mob's sale or purchase could link to (MOB7): the
 * same type, kind and class, not voided and not linked to a mob yet, from
 * the last 120 days. Empty when Livestock is off.
 */
export async function linkableMovements(tx: OrgTx, mobIdInput: unknown, input: { type: unknown }): Promise<LinkableMovement[]> {
  const mob = await mobRow(tx, mobIdInput);
  const type = requireOneOf(input.type, "type", ["sale", "purchase"] as const);
  if (!(await getLivestockSettings(tx)).enabled) return [];
  const rows = await tx.query<{ id: string; movement_date: string; head: number; amount: string | null; invoice_number: string | null; bill_reference: string | null }>(
    `select m.id::text, m.movement_date::text, m.head, m.amount::text, i.invoice_number, b.supplier_invoice_number as bill_reference
       from livestock_movements m
       left join sales_invoice_lines il on il.id = m.sales_invoice_line_id
       left join sales_invoices i on i.id = il.invoice_id
       left join bill_lines bl on bl.id = m.bill_line_id
       left join bills b on b.id = bl.bill_id
      where m.movement_type = $1 and m.kind = $2 and m.class_code = $3 and m.voided_at is null
        and m.movement_date >= $4::date - 120
        and not exists (select 1 from mob_events e where e.livestock_movement_id = m.id)
      order by m.movement_date desc, m.id desc limit 50`,
    [type, mob.kind, mob.classCode, todayIsoDate()],
  );
  return rows.rows.map((row) => ({ id: row.id, movementDate: row.movement_date, head: row.head, amount: row.amount, invoiceNumber: row.invoice_number, billReference: row.bill_reference }));
}
