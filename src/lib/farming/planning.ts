import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { requireFarmAccess } from "@/lib/farming/access";
import { getMob } from "@/lib/farming/mobs";
import { requireFarming } from "@/lib/farming/paddocks";
import { BREEDING_TYPES, type BreedingType, birthsFrom, inCalfPercent, planRound, scanningPercent } from "@/lib/farming/planning-rules";
import { requestHash } from "@/lib/idempotency";
import { optionalId, optionalString, requireArray, requireId, requireOneOf } from "@/lib/validation";

/*
 * Breeding records and rotation planning (decisions 1439-1444; BR1-BR6,
 * common NZ practice, not yet reviewed). Records only: nothing here judges
 * a result or tells anyone where to graze.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requireFarmId(tx: OrgTx, input: unknown): Promise<string> {
  await requireFarming(tx);
  const farmId = requireId(input, "farmId");
  const farm = await tx.query("select 1 from farms where id = $1", [farmId]);
  if (!farm.rowCount) throw new NotFoundError("Farm not found.");
  await requireFarmAccess(tx, farmId);
  return farmId;
}

function count(input: unknown, label: string, required = true): number | null {
  if (input === undefined || input === null || input === "") {
    if (required) throw new ValidationError(`Say how many ${label}.`);
    return null;
  }
  const value = typeof input === "number" ? input : Number(String(input).replace(/,/g, "").trim());
  if (!Number.isInteger(value) || value < 0 || value > 100000) throw new ValidationError(`${label[0].toUpperCase()}${label.slice(1)} must be a whole number from 0 to 100,000.`);
  return value;
}

export type BreedingRecord = {
  id: string;
  mobId: string;
  mobName: string;
  recordType: BreedingType;
  onDate: string;
  untilOn: string | null;
  sire: string | null;
  sireMobId: string | null;
  head: number;
  technician: string | null;
  empty: number | null;
  singles: number | null;
  twins: number | null;
  triplets: number | null;
  inCalf: number | null;
  /** Scanning: per ewe scanned; and per ewe joined, when the latest joining before it is known. */
  scanningPercent: string | null;
  scanningPercentJoined: string | null;
  inCalfPercent: string | null;
  /** Joining: the first births expected, from the kind's average gestation. */
  birthsFrom: string | null;
  note: string | null;
  createdByEmail: string;
};

async function loadBreeding(tx: OrgTx, where: string, params: unknown[]): Promise<BreedingRecord[]> {
  const rows = await tx.query<{
    id: string;
    mob_id: string;
    mob_name: string | null;
    kind: string;
    record_type: BreedingType;
    on_date: string;
    until_on: string | null;
    sire: string | null;
    sire_mob_id: string | null;
    head: number;
    technician: string | null;
    empty: number | null;
    singles: number | null;
    twins: number | null;
    triplets: number | null;
    in_calf: number | null;
    note: string | null;
    created_by_email: string;
    joined: number | null;
  }>(
    `select b.id::text, b.mob_id::text, m.name as mob_name, m.kind, b.record_type, b.on_date::text, b.until_on::text, b.sire, b.sire_mob_id::text, b.head,
            b.technician, b.empty, b.singles, b.twins, b.triplets, b.in_calf, b.note, b.created_by_email,
            (select j.head from mob_breeding j where j.mob_id = b.mob_id and j.record_type = 'joining' and j.status = 'active' and j.on_date <= b.on_date
              order by j.on_date desc, j.id desc limit 1) as joined
       from mob_breeding b join mobs m on m.id = b.mob_id
      where b.status = 'active' and ${where}
      order by b.on_date desc, b.id desc limit 500`,
    params,
  );
  return rows.rows.map((row) => {
    const scan = row.record_type === "scanning" ? { head: row.head, singles: row.singles ?? 0, twins: row.twins ?? 0, triplets: row.triplets ?? 0 } : null;
    return {
      id: row.id,
      mobId: row.mob_id,
      mobName: row.mob_name ?? "Mob",
      recordType: row.record_type,
      onDate: row.on_date,
      untilOn: row.until_on,
      sire: row.sire,
      sireMobId: row.sire_mob_id,
      head: row.head,
      technician: row.technician,
      empty: row.empty,
      singles: row.singles,
      twins: row.twins,
      triplets: row.triplets,
      inCalf: row.in_calf,
      scanningPercent: scan ? scanningPercent(scan) : null,
      scanningPercentJoined: scan && row.joined ? scanningPercent(scan, row.joined) : null,
      inCalfPercent: row.record_type === "pregnancy_test" ? inCalfPercent(row.head, row.in_calf ?? 0) : null,
      birthsFrom: row.record_type === "joining" ? birthsFrom(row.kind, row.on_date) : null,
      note: row.note,
      createdByEmail: row.created_by_email,
    };
  });
}

/**
 * Records mating, AI, scanning or a pregnancy test for a mob (BR1-BR4).
 * Scanning is for sheep, goats and deer (empty, singles, twins, triplets or
 * more, adding up to the head scanned); a pregnancy test (in calf of
 * tested) for cattle. Farm staff can record them.
 */
export async function recordBreeding(tx: OrgTx, mobIdInput: unknown, input: Record<string, unknown>): Promise<BreedingRecord> {
  const { mob } = await getMob(tx, mobIdInput);
  if (input.farmId !== undefined && input.farmId !== null && input.farmId !== "" && requireId(input.farmId, "farmId") !== mob.farmId) {
    throw new ConflictError(`${mob.name} isn't on the farm this was recorded for. Nothing was saved.`);
  }
  if (mob.status !== "active") throw new ValidationError(`${mob.name} is closed.`);
  const recordType = requireOneOf(input.recordType, "What it is", BREEDING_TYPES);
  const cattle = mob.kind === "dairy_cattle" || mob.kind === "beef_cattle";
  if (recordType === "scanning" && cattle) throw new ValidationError("Cattle are pregnancy tested, not scanned for numbers. Record a pregnancy test.");
  if (recordType === "pregnancy_test" && !cattle) throw new ValidationError("Record scanning for sheep, goats and deer.");
  const onDate = input.onDate ? parseIsoDate(input.onDate, "Date") : todayIsoDate();
  const untilOn = recordType === "joining" && input.untilOn ? parseIsoDate(input.untilOn, "Out") : null;
  if (untilOn && untilOn < onDate) throw new ValidationError("The day out can't be before the day in.");
  const head = count(input.head ?? mob.head, "head")!;
  if (head < 1) throw new ValidationError("Say how many head.");
  const sire = optionalString(input.sire, "Sire", { maxLength: 150 });
  const sireMobId = optionalId(input.sireMobId, "sireMobId");
  if (sireMobId) {
    const sireMob = (await getMob(tx, sireMobId)).mob;
    if (sireMob.farmId !== mob.farmId) throw new ValidationError("The rams or bulls are on another farm.");
  }
  const technician = recordType === "ai" || recordType === "scanning" || recordType === "pregnancy_test" ? optionalString(input.technician, "Technician", { maxLength: 100 }) : null;
  let empty: number | null = null;
  let singles: number | null = null;
  let twins: number | null = null;
  let triplets: number | null = null;
  let inCalf: number | null = null;
  if (recordType === "scanning") {
    empty = count(input.empty, "empty")!;
    singles = count(input.singles, "singles")!;
    twins = count(input.twins, "twins")!;
    triplets = count(input.triplets, "triplets or more") ?? 0;
    if (empty + singles + twins + triplets !== head) throw new ValidationError(`Empty, singles, twins and triplets add up to ${empty + singles + twins + triplets}, not the ${head} scanned.`);
  }
  if (recordType === "pregnancy_test") {
    inCalf = count(input.inCalf, "in calf")!;
    if (inCalf > head) throw new ValidationError(`${inCalf} in calf is more than the ${head} tested.`);
  }
  const note = optionalString(input.note, "Note", { maxLength: 200 });
  const operationId = typeof input.operationId === "string" && UUID.test(input.operationId) ? input.operationId.toLowerCase() : null;
  if (input.operationId && !operationId) throw new ValidationError("operationId must be a UUID.");
  const hash = requestHash("mob_breeding", { mobId: mob.id, recordType, onDate, untilOn, head, sire, sireMobId, technician, empty, singles, twins, triplets, inCalf, note });
  if (operationId) {
    const earlier = await tx.query<{ id: string; request_hash: string | null; created_by_email: string }>("select id::text, request_hash, created_by_email from mob_breeding where operation_id = $1", [operationId]);
    if (earlier.rows[0]) {
      if (earlier.rows[0].request_hash !== hash || earlier.rows[0].created_by_email !== tx.actor.email) throw new ConflictError("This was already sent with different details. Nothing was changed.");
      return (await loadBreeding(tx, "b.id = $1", [earlier.rows[0].id]))[0];
    }
  }
  const row = await tx.query<{ id: string }>(
    `insert into mob_breeding (farm_id, mob_id, record_type, on_date, until_on, sire, sire_mob_id, head, technician, empty, singles, twins, triplets, in_calf, note, operation_id, request_hash, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) returning id::text`,
    [mob.farmId, mob.id, recordType, onDate, untilOn, sire, sireMobId, head, technician, empty, singles, twins, triplets, inCalf, note, operationId, operationId ? hash : null, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "farming.breeding_recorded", entityType: "mob_breeding", entityId: row.rows[0].id, details: { mobId: mob.id, recordType, onDate, head } });
  return (await loadBreeding(tx, "b.id = $1", [row.rows[0].id]))[0];
}

/** A mob's breeding records, or the farm's (newest first). */
export async function listBreeding(tx: OrgTx, input: { farmId?: unknown; mobId?: unknown }): Promise<BreedingRecord[]> {
  if (input.mobId) {
    const { mob } = await getMob(tx, input.mobId);
    return loadBreeding(tx, "b.mob_id = $1", [mob.id]);
  }
  const farmId = await requireFarmId(tx, input.farmId);
  return loadBreeding(tx, "b.farm_id = $1", [farmId]);
}

/** Removes a breeding record entered by mistake (kept, marked removed). */
export async function removeBreeding(tx: OrgTx, idInput: unknown): Promise<void> {
  await requireFarming(tx);
  const id = requireId(idInput, "breedingId");
  const row = await tx.query<{ farm_id: string }>("select farm_id::text from mob_breeding where id = $1 and status = 'active'", [id]);
  if (!row.rows[0]) throw new NotFoundError("Breeding record not found.");
  await requireFarmAccess(tx, row.rows[0].farm_id, "Breeding record not found.");
  await tx.query("update mob_breeding set status = 'removed' where id = $1", [id]);
  await writeAuditEvent(tx, { eventType: "farming.breeding_removed", entityType: "mob_breeding", entityId: id, details: {} });
}

// Rotation planning --------------------------------------------------------------------------------

export type PlannedMove = { id: string; mobId: string; mobName: string; paddockId: string; paddockName: string; plannedOn: string; days: number | null; status: "planned" | "done" | "cancelled" };

export type RotationPlan = {
  roundDays: number | null;
  planned: PlannedMove[];
  /** Each paddock's next planned move, for the map and paddock list (BR6). */
  nextByPaddock: Record<string, { mobName: string; plannedOn: string }>;
  /** Each mob's next planned paddock. */
  nextByMob: Record<string, { paddockName: string; plannedOn: string }>;
};

export async function rotationPlan(tx: OrgTx, input: { farmId: unknown }): Promise<RotationPlan> {
  const farmId = await requireFarmId(tx, input.farmId);
  const settings = await tx.query<{ round_days: number }>("select round_days from farm_rotation_settings where farm_id = $1", [farmId]);
  const rows = await tx.query<{ id: string; mob_id: string; mob_name: string | null; class_code: string; paddock_id: string; paddock_name: string; planned_on: string; days: number | null; status: PlannedMove["status"] }>(
    `select g.id::text, g.mob_id::text, m.name as mob_name, m.class_code, g.paddock_id::text, p.name as paddock_name, g.planned_on::text, g.days, g.status
       from grazing_plans g join mobs m on m.id = g.mob_id join paddocks p on p.id = g.paddock_id
      where g.farm_id = $1 and g.status = 'planned' and m.status = 'active' and p.status = 'active'
      order by g.planned_on, g.id`,
    [farmId],
  );
  const planned = rows.rows.map((row) => ({ id: row.id, mobId: row.mob_id, mobName: row.mob_name ?? row.class_code, paddockId: row.paddock_id, paddockName: row.paddock_name, plannedOn: row.planned_on, days: row.days, status: row.status }));
  const nextByPaddock: RotationPlan["nextByPaddock"] = {};
  const nextByMob: RotationPlan["nextByMob"] = {};
  for (const move of planned) {
    nextByPaddock[move.paddockId] ??= { mobName: move.mobName, plannedOn: move.plannedOn };
    nextByMob[move.mobId] ??= { paddockName: move.paddockName, plannedOn: move.plannedOn };
  }
  return { roundDays: settings.rows[0]?.round_days ?? null, planned, nextByPaddock, nextByMob };
}

/** Sets the farm's round length in days (BR6), or clears it. */
export async function setRoundLength(tx: OrgTx, input: { farmId: unknown; roundDays: unknown }): Promise<RotationPlan> {
  const farmId = await requireFarmId(tx, input.farmId);
  if (input.roundDays === null || input.roundDays === "" || input.roundDays === undefined) {
    await tx.query("delete from farm_rotation_settings where farm_id = $1", [farmId]);
  } else {
    const days = count(input.roundDays, "days in the round")!;
    if (days < 1 || days > 365) throw new ValidationError("A round is 1 to 365 days.");
    await tx.query(
      "insert into farm_rotation_settings (farm_id, round_days, updated_by_email) values ($1, $2, $3) on conflict (farm_id) do update set round_days = excluded.round_days, updated_by_email = excluded.updated_by_email, updated_at = now()",
      [farmId, days, tx.actor.email],
    );
  }
  await writeAuditEvent(tx, { eventType: "farming.round_length_set", entityType: "farm", entityId: farmId, details: { roundDays: input.roundDays ?? null } });
  return rotationPlan(tx, { farmId });
}

/**
 * Plans a mob's round (BR5): the paddocks in order from a start date, each
 * for its share of the round by area. The mob's earlier planned moves are
 * cancelled (kept). `preview` works it out without saving.
 */
export async function planMobRound(tx: OrgTx, input: { farmId: unknown; mobId: unknown; paddockIds: unknown; startOn: unknown; roundDays?: unknown; preview?: unknown }) {
  const farmId = await requireFarmId(tx, input.farmId);
  const { mob } = await getMob(tx, input.mobId);
  if (mob.farmId !== farmId) throw new ValidationError(`${mob.name} isn't on this farm.`);
  const ids = requireArray(input.paddockIds, "paddockIds", 200).map((value) => requireId(value, "paddockId"));
  if (!ids.length) throw new ValidationError("Choose the paddocks for the round.");
  if (new Set(ids).size !== ids.length) throw new ValidationError("A paddock is in the round twice.");
  const paddocks = await tx.query<{ id: string; name: string; hectares: string | null }>(
    `select p.id::text, p.name,
            coalesce(p.effective_ha, round((select b.mapped_ha from paddock_boundaries b where b.paddock_id = p.id order by b.id desc limit 1), 2))::text as hectares
       from paddocks p where p.farm_id = $1 and p.status = 'active' and p.id = any($2::bigint[])`,
    [farmId, ids],
  );
  if (paddocks.rows.length !== ids.length) throw new NotFoundError("A paddock in the round isn't on this farm.");
  const ordered = ids.map((id) => paddocks.rows.find((row) => row.id === id)!);
  const settings = await tx.query<{ round_days: number }>("select round_days from farm_rotation_settings where farm_id = $1", [farmId]);
  const roundDays = input.roundDays === undefined || input.roundDays === null || input.roundDays === "" ? settings.rows[0]?.round_days : count(input.roundDays, "days in the round");
  if (!roundDays) throw new ValidationError("Set the round length first.");
  if (roundDays < ordered.length) throw new ValidationError(`A ${roundDays}-day round can't cover ${ordered.length} paddocks: each gets at least a day.`);
  const startOn = parseIsoDate(input.startOn, "Start");
  const stops = planRound(ordered.map((row) => ({ paddockId: row.id, name: row.name, hectares: row.hectares })), startOn, roundDays);
  if (input.preview === true || input.preview === "true") return { stops, saved: false };
  await tx.query("update grazing_plans set status = 'cancelled' where mob_id = $1 and status = 'planned'", [mob.id]);
  for (const stop of stops) {
    await tx.query("insert into grazing_plans (farm_id, mob_id, paddock_id, planned_on, days, created_by_email) values ($1, $2, $3, $4, $5, $6)", [farmId, mob.id, stop.paddockId, stop.plannedOn, stop.days, tx.actor.email]);
  }
  await writeAuditEvent(tx, { eventType: "farming.round_planned", entityType: "mob", entityId: mob.id, details: { startOn, roundDays, paddocks: ids } });
  return { stops, saved: true };
}

/** Cancels one planned move. */
export async function cancelPlannedMove(tx: OrgTx, idInput: unknown): Promise<void> {
  await requireFarming(tx);
  const id = requireId(idInput, "planId");
  const row = await tx.query<{ farm_id: string }>("select farm_id::text from grazing_plans where id = $1 and status = 'planned'", [id]);
  if (!row.rows[0]) throw new NotFoundError("Planned move not found.");
  await requireFarmAccess(tx, row.rows[0].farm_id, "Planned move not found.");
  await tx.query("update grazing_plans set status = 'cancelled' where id = $1", [id]);
}
