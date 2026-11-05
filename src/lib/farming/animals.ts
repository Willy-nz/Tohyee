import { writeAuditEvent } from "@/lib/audit";
import { roleAtLeast } from "@/lib/auth/roles";
import { parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { requireFarmAccess, visibleFarmIds } from "@/lib/farming/access";
import { animalsIn, animalsOut, taggedCount } from "@/lib/farming/animal-mobs";
import { ANIMAL_SEXES, type AnimalSex, type AnimalStatus } from "@/lib/farming/animal-rules";
import { type Gain, weightGain } from "@/lib/farming/mob-rules";
import { addEvent, mobRow, setHead } from "@/lib/farming/mobs";
import { requireFarming } from "@/lib/farming/paddocks";
import { requestHash } from "@/lib/idempotency";
import { KIND_NAMES, LIVESTOCK_KINDS, type LivestockKind } from "@/lib/livestock/classes";
import { cmp, dec, parseDecimalInput, ZERO_DECIMAL } from "@/lib/money/decimal";
import { optionalId, optionalString, requireId, requireOneOf, requireString } from "@/lib/validation";

/*
 * The animal register (decisions 1481-1486; examples AN1-AN8, common NZ
 * practice, not yet reviewed). An animal is on one farm with a kind, a
 * visual tag and optionally an EID or NAIT number (a field only: nothing is
 * sent to NAIT, issue #513). It's in at most one mob at a time, with the
 * history kept. The mob's head is the one count: tagging an animal into a
 * mob changes no head and no livestock movement, and a sale or death of a
 * tagged animal is recorded on its mob (mobs.ts), naming the tag.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AnimalWeight = { id: string; date: string; kg: string; source: string; mobEventId: string | null; gain: Gain | null };

export type Animal = {
  id: string;
  farmId: string;
  kind: LivestockKind;
  kindName: string;
  tag: string;
  eid: string | null;
  sex: AnimalSex | null;
  breed: string | null;
  birthOn: string | null;
  dam: { id: string; tag: string } | null;
  damText: string | null;
  sire: { id: string; tag: string } | null;
  sireText: string | null;
  status: AnimalStatus;
  statusOn: string | null;
  mob: { id: string; name: string; classCode: string; since: string } | null;
  lastWeight: AnimalWeight | null;
  lastBcs: { date: string; score: string; scale: string } | null;
  note: string | null;
  createdOn: string;
};

export function optionalOperationId(input: unknown): string | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input !== "string" || !UUID.test(input)) throw new ValidationError("operationId must be a UUID.");
  return input.toLowerCase();
}

export function requireBooks(tx: OrgTx, what: string) {
  const role = tx.actor.role;
  if (role && !roleAtLeast(role, "bookkeeper")) throw new ForbiddenError(`${what} needs the bookkeeper role or higher.`);
}

export async function requireFarmId(tx: OrgTx, input: unknown): Promise<string> {
  await requireFarming(tx);
  const farmId = requireId(input, "farmId");
  const farm = await tx.query("select 1 from farms where id = $1", [farmId]);
  if (!farm.rowCount) throw new NotFoundError("Farm not found.");
  await requireFarmAccess(tx, farmId);
  return farmId;
}

export function eventDate(input: unknown): string {
  return input === undefined || input === null || input === "" ? todayIsoDate() : parseIsoDate(input, "The date");
}

export function parseKg(input: unknown, label = "Weight"): string {
  const kg = parseDecimalInput(input, label, { maxScale: 1 });
  if (cmp(dec(kg), ZERO_DECIMAL) <= 0 || cmp(dec(kg), dec("2000")) > 0) throw new ValidationError(`${label} must be more than 0 and at most 2,000 kg.`);
  return kg;
}

type AnimalRow = {
  id: string;
  farm_id: string;
  kind: LivestockKind;
  tag: string;
  eid: string | null;
  sex: AnimalSex | null;
  breed: string | null;
  birth_on: string | null;
  dam_id: string | null;
  dam_tag: string | null;
  dam_text: string | null;
  sire_id: string | null;
  sire_tag: string | null;
  sire_text: string | null;
  status: AnimalStatus;
  status_on: string | null;
  mob_id: string | null;
  mob_name: string | null;
  mob_kind: string | null;
  mob_class: string | null;
  mob_since: string | null;
  note: string | null;
  created_on: string;
  w_id: string | null;
  w_date: string | null;
  w_kg: string | null;
  w_source: string | null;
  w_event: string | null;
  p_date: string | null;
  p_kg: string | null;
  b_date: string | null;
  b_score: string | null;
  b_scale: string | null;
};

export async function loadAnimals(tx: OrgTx, where: string, params: unknown[], limit = 20000): Promise<Animal[]> {
  const rows = await tx.query<AnimalRow>(
    `select a.id::text, a.farm_id::text, a.kind, a.tag, a.eid, a.sex, a.breed, a.birth_on::text, a.dam_id::text, d.tag as dam_tag, a.dam_text,
            a.sire_id::text, s.tag as sire_tag, a.sire_text, a.status, a.status_on::text, a.note, (a.created_at at time zone 'Pacific/Auckland')::date::text as created_on,
            am.mob_id::text, m.name as mob_name, m.kind as mob_kind, m.class_code as mob_class, am.from_on::text as mob_since,
            w.id::text as w_id, w.weighed_on::text as w_date, w.kg::text as w_kg, w.source as w_source, w.mob_event_id::text as w_event,
            pw.weighed_on::text as p_date, pw.kg::text as p_kg,
            b.scored_on::text as b_date, b.score::text as b_score, b.scale as b_scale
       from animals a
       left join animals d on d.id = a.dam_id
       left join animals s on s.id = a.sire_id
       left join animal_mobs am on am.animal_id = a.id and am.to_on is null
       left join mobs m on m.id = am.mob_id
       left join lateral (select x.* from animal_weights x where x.animal_id = a.id and x.status = 'active' order by x.weighed_on desc, x.id desc limit 1) w on true
       left join lateral (select x.* from animal_weights x where x.animal_id = a.id and x.status = 'active' and x.weighed_on < w.weighed_on order by x.weighed_on desc, x.id desc limit 1) pw on true
       left join lateral (select x.* from bcs_records x where x.animal_id = a.id and x.status = 'active' order by x.scored_on desc, x.id desc limit 1) b on true
      where ${where}
      order by a.status = 'on_farm' desc, a.tag, a.id
      limit ${Math.trunc(limit)}`,
    params,
  );
  return rows.rows.map((row) => ({
    id: row.id,
    farmId: row.farm_id,
    kind: row.kind,
    kindName: KIND_NAMES[row.kind] ?? row.kind,
    tag: row.tag,
    eid: row.eid,
    sex: row.sex,
    breed: row.breed,
    birthOn: row.birth_on,
    dam: row.dam_id ? { id: row.dam_id, tag: row.dam_tag ?? "" } : null,
    damText: row.dam_text,
    sire: row.sire_id ? { id: row.sire_id, tag: row.sire_tag ?? "" } : null,
    sireText: row.sire_text,
    status: row.status,
    statusOn: row.status_on,
    mob: row.mob_id ? { id: row.mob_id, name: row.mob_name ?? (row.mob_class ?? ""), classCode: row.mob_class ?? "", since: row.mob_since ?? "" } : null,
    lastWeight: row.w_id
      ? { id: row.w_id, date: row.w_date!, kg: row.w_kg!, source: row.w_source!, mobEventId: row.w_event, gain: row.p_date ? weightGain({ date: row.p_date, averageKg: row.p_kg! }, { date: row.w_date!, averageKg: row.w_kg! }) : null }
      : null,
    lastBcs: row.b_date ? { date: row.b_date, score: row.b_score!, scale: row.b_scale! } : null,
    note: row.note,
    createdOn: row.created_on,
  }));
}

/** The mob name as the screens show it, when it has none typed. */
async function fixMobNames(tx: OrgTx, animals: Animal[]): Promise<Animal[]> {
  const ids = [...new Set(animals.filter((animal) => animal.mob).map((animal) => animal.mob!.id))];
  if (!ids.length) return animals;
  const names = new Map<string, string>();
  for (const id of ids) names.set(id, (await mobRow(tx, id)).name);
  return animals.map((animal) => (animal.mob ? { ...animal, mob: { ...animal.mob, name: names.get(animal.mob.id) ?? animal.mob.name } } : animal));
}

/** The farm's animals: on the farm and missing first; sold and dead with `includeGone`. Filter by mob or a tag/EID search. */
export async function listAnimals(tx: OrgTx, input: { farmId: unknown; mobId?: unknown; includeGone?: unknown; q?: unknown }): Promise<Animal[]> {
  const farmId = await requireFarmId(tx, input.farmId);
  const params: unknown[] = [farmId];
  const where = ["a.farm_id = $1"];
  if (!(input.includeGone === true || input.includeGone === "true" || input.includeGone === "1")) where.push("a.status in ('on_farm', 'missing')");
  const mobId = optionalId(input.mobId, "mobId");
  if (mobId) {
    params.push(mobId);
    where.push(`am.mob_id = $${params.length}`);
  }
  const q = typeof input.q === "string" ? input.q.trim() : "";
  if (q) {
    params.push(`%${q.toLowerCase().replace(/\s+/g, "").replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    where.push(`(replace(lower(a.tag), ' ', '') like $${params.length} or lower(coalesce(a.eid, '')) like $${params.length})`);
  }
  return fixMobNames(tx, await loadAnimals(tx, where.join(" and "), params));
}

/** Every animal on the farms the person can see, on the farm now (for the AI). */
export async function allAnimals(tx: OrgTx, input: { farmId?: unknown } = {}): Promise<Animal[]> {
  if (input.farmId) return listAnimals(tx, { farmId: input.farmId });
  await requireFarming(tx);
  const visible = await visibleFarmIds(tx);
  return fixMobNames(tx, visible === null ? await loadAnimals(tx, "a.status in ('on_farm', 'missing')", []) : await loadAnimals(tx, "a.status in ('on_farm', 'missing') and a.farm_id = any($1::bigint[])", [visible]));
}

export async function animalRow(tx: OrgTx, idInput: unknown, lock = false): Promise<Animal> {
  await requireFarming(tx);
  const id = requireId(idInput, "animalId");
  if (lock) await tx.query("select 1 from animals where id = $1 for update", [id]);
  const animal = (await loadAnimals(tx, "a.id = $1", [id]))[0];
  if (!animal) throw new NotFoundError("Animal not found.");
  await requireFarmAccess(tx, animal.farmId, "Animal not found.");
  return (await fixMobNames(tx, [animal]))[0];
}

/** An animal's weights, newest first, each with its gain since the one before (AN8). */
export async function animalWeights(tx: OrgTx, animalId: string): Promise<AnimalWeight[]> {
  const rows = await tx.query<{ id: string; weighed_on: string; kg: string; source: string; mob_event_id: string | null }>(
    "select id::text, weighed_on::text, kg::text, source, mob_event_id::text from animal_weights where animal_id = $1 and status = 'active' order by animal_weights.weighed_on, animal_weights.id",
    [animalId],
  );
  return rows.rows
    .map((row, index) => ({
      id: row.id,
      date: row.weighed_on,
      kg: row.kg,
      source: row.source,
      mobEventId: row.mob_event_id,
      gain: index > 0 ? weightGain({ date: rows.rows[index - 1].weighed_on, averageKg: rows.rows[index - 1].kg }, { date: row.weighed_on, averageKg: row.kg }) : null,
    }))
    .reverse();
}

// Writing -------------------------------------------------------------------------------------------

type Parent = { id: string | null; text: string | null };

/** A dam or sire: another animal on the farm (by id, or a tag that matches one) or typed (a sire name or AI bull code). */
async function parent(tx: OrgTx, farmId: string, kind: string, idInput: unknown, textInput: unknown, label: string, selfId: string | null): Promise<Parent> {
  const id = optionalId(idInput, `${label}Id`);
  if (id) {
    const row = await tx.query<{ farm_id: string; kind: string }>("select farm_id::text, kind from animals where id = $1", [id]);
    if (!row.rows[0] || row.rows[0].farm_id !== farmId) throw new ValidationError(`That ${label} isn't on this farm.`);
    if (row.rows[0].kind !== kind) throw new ValidationError(`The ${label} must be the same kind of stock.`);
    if (id === selfId) throw new ValidationError(`An animal can't be its own ${label}.`);
    return { id, text: null };
  }
  const text = optionalString(textInput, label === "dam" ? "Dam" : "Sire", { maxLength: 60 });
  if (!text) return { id: null, text: null };
  // A typed tag that matches one animal on the farm becomes a link.
  const match = await tx.query<{ id: string }>("select id::text from animals where farm_id = $1 and kind = $2 and replace(lower(tag), ' ', '') = replace(lower($3), ' ', '') order by animals.status in ('on_farm', 'missing') desc, animals.id desc limit 2", [farmId, kind, text]);
  if (match.rows.length === 1 && match.rows[0].id !== selfId) return { id: match.rows[0].id, text: null };
  return { id: null, text };
}

function optionalSex(input: unknown): AnimalSex | null {
  return input === undefined || input === null || input === "" ? null : (requireOneOf(input, "Sex", ANIMAL_SEXES) as AnimalSex);
}

function optionalBirth(input: unknown): string | null {
  if (input === undefined || input === null || input === "") return null;
  const date = parseIsoDate(input, "Birth date");
  if (date > todayIsoDate()) throw new ValidationError("The birth date can't be in the future.");
  return date;
}

async function tagFree(tx: OrgTx, farmId: string, kind: string, tag: string, eid: string | null, selfId: string | null) {
  const taken = await tx.query<{ tag: string }>("select tag from animals where farm_id = $1 and kind = $2 and lower(tag) = lower($3) and status in ('on_farm', 'missing') and ($4::bigint is null or id <> $4)", [farmId, kind, tag, selfId]);
  if (taken.rowCount) throw new ConflictError(`There's already an animal tagged ${tag} on this farm.`);
  if (eid) {
    const eidTaken = await tx.query<{ tag: string }>("select tag from animals where farm_id = $1 and lower(eid) = lower($2) and status in ('on_farm', 'missing') and ($3::bigint is null or id <> $3)", [farmId, eid, selfId]);
    if (eidTaken.rowCount) throw new ConflictError(`EID ${eid} is already on ${eidTaken.rows[0].tag}.`);
  }
}

/** A mob with room for one more tagged animal of this kind (AN2): tagging never changes its head. */
export async function requireRoom(tx: OrgTx, mobId: string, farmId: string, kind: string, adding = 1) {
  const mob = await mobRow(tx, mobId, true);
  if (mob.farmId !== farmId) throw new ValidationError(`${mob.name} is on another farm.`);
  if (mob.status !== "active") throw new ValidationError(`${mob.name} is closed.`);
  if (mob.kind !== kind) throw new ValidationError(`${mob.name} is ${mob.kindName.toLowerCase()}.`);
  const tagged = await taggedCount(tx, mob.id);
  if (tagged + adding > mob.head) {
    throw new ValidationError(`${mob.name} has ${mob.head} head and ${tagged} tagged already. Tagging doesn't change a mob's head: if more came into the mob, record them on the mob first (bought, born or moved in).`);
  }
  return mob;
}

/**
 * Adds an animal (AN1): kind, tag and optionally EID, sex, breed, birth
 * date, dam and sire, and the mob it's in (AN2: tagged in, no head change).
 */
export async function createAnimal(tx: OrgTx, input: Record<string, unknown>): Promise<Animal> {
  const farmId = await requireFarmId(tx, input.farmId);
  const kind = requireOneOf(input.kind, "Kind of stock", LIVESTOCK_KINDS) as LivestockKind;
  const tag = requireString(input.tag, "Tag", { maxLength: 30 });
  const eid = optionalString(input.eid, "EID or NAIT number", { maxLength: 30 });
  const sex = optionalSex(input.sex);
  const breed = optionalString(input.breed, "Breed", { maxLength: 60 });
  const birthOn = optionalBirth(input.birthOn);
  const note = optionalString(input.note, "Note", { maxLength: 500 });
  const mobId = optionalId(input.mobId, "mobId");
  const onDate = eventDate(input.onDate);
  const operationId = optionalOperationId(input.operationId);
  const hash = requestHash("animal_create", { farmId, kind, tag, eid, sex, breed, birthOn, note, mobId, onDate, damId: input.damId ?? null, dam: input.damText ?? null, sireId: input.sireId ?? null, sire: input.sireText ?? null });
  if (operationId) {
    const again = await tx.query<{ id: string; request_hash: string | null; created_by_email: string }>("select id::text, request_hash, created_by_email from animals where operation_id = $1", [operationId]);
    if (again.rows[0]) {
      if (again.rows[0].request_hash !== hash || again.rows[0].created_by_email !== tx.actor.email) throw new ConflictError("This was already sent with different details. Nothing was changed: check it and record it again.");
      return animalRow(tx, again.rows[0].id);
    }
  }
  await tagFree(tx, farmId, kind, tag, eid, null);
  const dam = await parent(tx, farmId, kind, input.damId, input.damText, "dam", null);
  const sire = await parent(tx, farmId, kind, input.sireId, input.sireText, "sire", null);
  const mob = mobId ? await requireRoom(tx, mobId, farmId, kind) : null;
  if (mob && mob.createdOn && onDate < mob.createdOn) throw new ValidationError(`${mob.name} was added on ${mob.createdOn}. The date can't be before that.`);
  const row = await tx.query<{ id: string }>(
    `insert into animals (farm_id, kind, tag, eid, sex, breed, birth_on, dam_id, dam_text, sire_id, sire_text, note, operation_id, request_hash, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id::text`,
    [farmId, kind, tag, eid, sex, breed, birthOn, dam.id, dam.text, sire.id, sire.text, note, operationId, operationId ? hash : null, tx.actor.email],
  );
  const id = row.rows[0].id;
  if (mob) await animalsIn(tx, { animalIds: [id], mobId: mob.id, onDate, how: "tagged", eventId: null });
  await writeAuditEvent(tx, { eventType: "farming.animal_added", entityType: "animal", entityId: id, details: { farmId, kind, tag, eid, mobId } });
  return animalRow(tx, id);
}

/** Changes an animal's details (not its mob or status: those have their own steps). */
export async function updateAnimal(tx: OrgTx, idInput: unknown, input: Record<string, unknown>): Promise<Animal> {
  const animal = await animalRow(tx, idInput, true);
  const has = (key: string) => Object.prototype.hasOwnProperty.call(input, key);
  const tag = has("tag") ? requireString(input.tag, "Tag", { maxLength: 30 }) : animal.tag;
  const eid = has("eid") ? optionalString(input.eid, "EID or NAIT number", { maxLength: 30 }) : animal.eid;
  const sex = has("sex") ? optionalSex(input.sex) : animal.sex;
  const breed = has("breed") ? optionalString(input.breed, "Breed", { maxLength: 60 }) : animal.breed;
  const birthOn = has("birthOn") ? optionalBirth(input.birthOn) : animal.birthOn;
  const note = has("note") ? optionalString(input.note, "Note", { maxLength: 500 }) : animal.note;
  const dam = has("damId") || has("damText") ? await parent(tx, animal.farmId, animal.kind, input.damId, input.damText, "dam", animal.id) : { id: animal.dam?.id ?? null, text: animal.damText };
  const sire = has("sireId") || has("sireText") ? await parent(tx, animal.farmId, animal.kind, input.sireId, input.sireText, "sire", animal.id) : { id: animal.sire?.id ?? null, text: animal.sireText };
  if (animal.status === "on_farm" || animal.status === "missing") await tagFree(tx, animal.farmId, animal.kind, tag, eid, animal.id);
  await tx.query("update animals set tag = $2, eid = $3, sex = $4, breed = $5, birth_on = $6, dam_id = $7, dam_text = $8, sire_id = $9, sire_text = $10, note = $11 where id = $1", [
    animal.id,
    tag,
    eid,
    sex,
    breed,
    birthOn,
    dam.id,
    dam.text,
    sire.id,
    sire.text,
    note,
  ]);
  await writeAuditEvent(tx, { eventType: "farming.animal_updated", entityType: "animal", entityId: animal.id, details: { tag, eid, sex, breed, birthOn } });
  return animalRow(tx, animal.id);
}

function requireHere(animal: Animal) {
  if (animal.status === "sold" || animal.status === "dead") throw new ValidationError(`${animal.tag} is ${animal.status === "sold" ? "sold" : "dead"}.`);
}

/**
 * Puts an animal in a mob, or corrects which mob it's in (AN2): no head
 * changes. It needs room in the mob (more head than tagged). `mobId` null
 * takes it out of its mob (a correction).
 */
export async function placeAnimal(tx: OrgTx, idInput: unknown, input: { mobId?: unknown; onDate?: unknown }): Promise<Animal> {
  const animal = await animalRow(tx, idInput, true);
  requireHere(animal);
  const mobId = optionalId(input.mobId, "mobId");
  const onDate = eventDate(input.onDate);
  if (mobId && animal.mob?.id === mobId) throw new ValidationError(`${animal.tag} is in ${animal.mob.name} already.`);
  const mob = mobId ? await requireRoom(tx, mobId, animal.farmId, animal.kind) : null;
  if (animal.mob) await animalsOut(tx, { animalIds: [animal.id], mobId: animal.mob.id, onDate, how: "corrected", eventId: null });
  if (mob) await animalsIn(tx, { animalIds: [animal.id], mobId: mob.id, onDate, how: "tagged", eventId: null });
  await writeAuditEvent(tx, { eventType: "farming.animal_placed", entityType: "animal", entityId: animal.id, details: { from: animal.mob?.id ?? null, to: mob?.id ?? null, onDate } });
  return animalRow(tx, animal.id);
}

/**
 * Moves tagged animals to another mob of the same farm, kind and class
 * (AN5): the head goes with them, as mob events "animals out" and "animals
 * in". Same class, so the books' head count doesn't change and no
 * livestock movement is made. A mob left with no head is closed.
 */
export async function moveAnimals(tx: OrgTx, input: { animalIds?: unknown; toMobId?: unknown; onDate?: unknown; operationId?: unknown }): Promise<{ moved: number; message: string }> {
  await requireFarming(tx);
  if (!Array.isArray(input.animalIds) || !input.animalIds.length || input.animalIds.length > 5000) throw new ValidationError("Choose the animals to move.");
  const ids = [...new Set(input.animalIds.map((value) => requireId(value, "animalId")))];
  const onDate = eventDate(input.onDate);
  const operationId = optionalOperationId(input.operationId);
  const hash = requestHash("animals_move", { ids, toMobId: String(input.toMobId), onDate });
  if (operationId) {
    const again = await tx.query<{ request_hash: string | null; created_by_email: string }>("select request_hash, created_by_email from mob_events where operation_id = $1", [operationId]);
    if (again.rows[0]) {
      if (again.rows[0].request_hash !== hash || again.rows[0].created_by_email !== tx.actor.email) throw new ConflictError("This was already sent with different details. Nothing was changed: check it and record it again.");
      return { moved: ids.length, message: "Already recorded." };
    }
  }
  const to = await mobRow(tx, requireId(input.toMobId, "toMobId"), true);
  if (to.status !== "active") throw new ValidationError(`${to.name} is closed.`);
  const animals: Animal[] = [];
  for (const id of ids) animals.push(await animalRow(tx, id, true));
  const groups = new Map<string, Animal[]>();
  for (const animal of animals) {
    requireHere(animal);
    if (!animal.mob) throw new ValidationError(`${animal.tag} isn't in a mob. Put it in ${to.name} instead (no head changes).`);
    if (animal.mob.id === to.id) throw new ValidationError(`${animal.tag} is in ${to.name} already.`);
    groups.set(animal.mob.id, [...(groups.get(animal.mob.id) ?? []), animal]);
  }
  let first = true;
  let toHead = to.head;
  for (const [fromId, group] of groups) {
    const from = await mobRow(tx, fromId, true);
    if (from.farmId !== to.farmId) throw new ValidationError("Mobs on different farms: move the mob, or sell and buy.");
    if (from.kind !== to.kind || from.classCode !== to.classCode) throw new ValidationError(`${from.name} is ${from.className.toLowerCase()} and ${to.name} is ${to.className.toLowerCase()}. A mob is one class: change the class first.`);
    if (from.createdOn && onDate < from.createdOn) throw new ValidationError(`${from.name} was added on ${from.createdOn}. The date can't be before that.`);
    const n = group.length;
    const tags = group.map((animal) => animal.tag).join(", ").slice(0, 400);
    const outId = await addEvent(tx, { mobId: from.id, farmId: from.farmId, eventType: "animals_out", eventDate: onDate, headChange: -n, headAfter: from.head - n, otherMobId: to.id, note: tags, operationId: first ? operationId : null, requestHash: first && operationId ? hash : null });
    const inId = await addEvent(tx, { mobId: to.id, farmId: to.farmId, eventType: "animals_in", eventDate: onDate, headChange: n, headAfter: toHead + n, otherMobId: from.id, note: tags });
    first = false;
    const animalIds = group.map((animal) => animal.id);
    await animalsOut(tx, { animalIds, mobId: from.id, onDate, how: "moved", eventId: outId });
    await animalsIn(tx, { animalIds, mobId: to.id, onDate, how: "moved", eventId: inId });
    await setHead(tx, from, from.head - n, onDate);
    toHead += n;
  }
  await setHead(tx, { ...to, head: to.head }, toHead, onDate);
  await writeAuditEvent(tx, { eventType: "farming.animals_moved", entityType: "mob", entityId: to.id, details: { animalIds: ids, onDate } });
  return { moved: ids.length, message: `${ids.length} moved to ${to.name}, which now has ${toHead} head. The books' head count doesn't change: it's the same class.` };
}

/** Missing and found (AN6): the animal stays in its mob and the head stays the same until a death, sale or count is recorded. */
export async function setAnimalStatus(tx: OrgTx, idInput: unknown, input: { status: unknown; onDate?: unknown }): Promise<Animal> {
  const animal = await animalRow(tx, idInput, true);
  const status = requireOneOf(input.status, "Status", ["on_farm", "missing", "sold", "dead"] as const);
  if (status === "sold" || status === "dead") {
    throw new ValidationError(animal.mob ? `Record the ${status === "sold" ? "sale" : "death"} on ${animal.mob.name} and choose ${animal.tag}, so the head count stays right.` : `Put ${animal.tag} in its mob first, then record the ${status === "sold" ? "sale" : "death"} on the mob, so the head count stays right.`);
  }
  requireHere(animal);
  if (status === animal.status) return animal;
  if (status === "on_farm") await tagFree(tx, animal.farmId, animal.kind, animal.tag, animal.eid, animal.id);
  await tx.query("update animals set status = $2, status_on = $3 where id = $1", [animal.id, status, status === "missing" ? eventDate(input.onDate) : null]);
  await writeAuditEvent(tx, { eventType: "farming.animal_status", entityType: "animal", entityId: animal.id, details: { status } });
  return animalRow(tx, animal.id);
}

/** One animal's weight (AN8). `operationId` lets a phone send it again safely. */
export async function recordAnimalWeight(tx: OrgTx, animal: Animal, input: { kg: unknown; onDate: string; source: string; operationId: string | null; hash: string | null; note?: string | null }): Promise<string> {
  requireHere(animal);
  const kg = parseKg(input.kg);
  const row = await tx.query<{ id: string }>(
    "insert into animal_weights (farm_id, animal_id, weighed_on, kg, source, note, operation_id, request_hash, created_by_email) values ($1, $2, $3, $4::numeric, $5, $6, $7, $8, $9) returning id::text",
    [animal.farmId, animal.id, input.onDate, kg, input.source, input.note ?? null, input.operationId, input.hash, tx.actor.email],
  );
  return row.rows[0].id;
}

/** Removes a weight typed wrongly: kept, marked removed with the reason (bookkeepers and up). */
export async function removeAnimalWeight(tx: OrgTx, idInput: unknown, input: { reason: unknown }): Promise<void> {
  await requireFarming(tx);
  requireBooks(tx, "Removing a weight");
  const id = requireId(idInput, "weightId");
  const reason = requireString(input.reason, "Reason", { maxLength: 500 });
  const row = await tx.query<{ farm_id: string; mob_event_id: string | null; status: string }>("select farm_id::text, mob_event_id::text, status from animal_weights where id = $1 for update", [id]);
  if (!row.rows[0]) throw new NotFoundError("Weight not found.");
  await requireFarmAccess(tx, row.rows[0].farm_id, "Weight not found.");
  if (row.rows[0].status !== "active") throw new ValidationError("That weight is removed already.");
  if (row.rows[0].mob_event_id) throw new ValidationError("That weight is part of a mob's weigh session, whose average is kept. Record a new weight instead.");
  await tx.query("update animal_weights set status = 'removed', removed_reason = $2 where id = $1", [id, reason]);
  await writeAuditEvent(tx, { eventType: "farming.animal_weight_removed", entityType: "animal_weight", entityId: id, details: { reason } });
}

export { KIND_NAMES };
