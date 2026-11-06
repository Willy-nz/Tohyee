import { writeAuditEvent } from "@/lib/audit";
import { roleAtLeast } from "@/lib/auth/roles";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { requireFarmAccess, visibleFarmIds } from "@/lib/farming/access";
import { type Animal, animalRow, eventDate, optionalOperationId, parseKg, recordAnimalWeight, requireBooks, requireFarmId } from "@/lib/farming/animals";
import { averageOf, BCS_KINDS, BCS_SCALES, type BcsScale, type BcsTargets, defaultScale, parseAverage, parseScore, SCALE_LABELS, SCALE_WORDS, scoreSteps, type Tally, tallySummary, targetsFor } from "@/lib/farming/bcs-rules";
import { addEvent, type Mob, mobRow } from "@/lib/farming/mobs";
import { requireFarming } from "@/lib/farming/paddocks";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { KIND_NAMES } from "@/lib/livestock/classes";
import { fileRefs } from "@/lib/safety/files";
import { optionalString, requireId, requireIdempotencyKey, requireOneOf, requireString } from "@/lib/validation";

/*
 * Body condition scores, photos, the farm's reference photos and AI
 * suggestions (decisions 1487-1494; examples BCS1-BCS8, common NZ practice,
 * not yet reviewed).
 *
 * - A score is for one animal (half points) or for a mob: an average, or a
 *   tally of how many at each score, whose average is worked out.
 * - Photos are kept in the farm's photo store (the same one safety records
 *   and the phone's queue use), with a record or waiting to be scored.
 * - A photo of a score given by eye can be marked a reference for its kind
 *   and score, so the person's own AI compares against the farm's stock.
 * - The AI (the person's own connected app) only suggests: a suggestion is
 *   never a score until a person accepts or changes it, and only then
 *   counts in averages, trends and targets.
 */

export type BcsPhoto = { id: string; fileId: string; fileName: string; takenOn: string; recordId: string | null; reference: { kind: string; scale: BcsScale; score: string } | null };

export type BcsRecord = {
  id: string;
  farmId: string;
  animalId: string | null;
  animalTag: string | null;
  mobId: string | null;
  mobName: string | null;
  kind: string;
  scoredOn: string;
  scale: BcsScale;
  score: string;
  headScored: number | null;
  tally: Tally | null;
  scoredBy: string | null;
  source: "typed" | "quick" | "import" | "ai_suggestion";
  note: string | null;
  photos: BcsPhoto[];
  createdByEmail: string;
};

export type ScaleSetting = { kind: string; kindName: string; scale: BcsScale; isDefault: boolean; targets: BcsTargets | null; steps: string[]; words: Array<{ score: string; words: string }>; references: string[] };

// Scales ---------------------------------------------------------------------------------------------

export async function scaleFor(tx: OrgTx, farmId: string, kind: string): Promise<BcsScale> {
  const row = await tx.query<{ scale: BcsScale }>("select scale from bcs_scale_settings where farm_id = $1 and kind = $2", [farmId, kind]);
  return row.rows[0]?.scale ?? defaultScale(kind);
}

/** Each kind's scale on a farm, its targets and descriptions, and which scores have reference photos (decision 1493). */
export async function listScales(tx: OrgTx, input: { farmId: unknown }): Promise<ScaleSetting[]> {
  const farmId = await requireFarmId(tx, input.farmId);
  const set = await tx.query<{ kind: string; scale: BcsScale }>("select kind, scale from bcs_scale_settings where farm_id = $1", [farmId]);
  const refs = await tx.query<{ kind: string; scale: BcsScale; score: string }>(
    "select distinct reference_kind as kind, reference_scale as scale, reference_score::text as score from bcs_photos where farm_id = $1 and reference_score is not null and status = 'active' order by 3",
    [farmId],
  );
  return BCS_KINDS.map((kind) => {
    const chosen = set.rows.find((row) => row.kind === kind)?.scale;
    const scale = chosen ?? defaultScale(kind);
    return {
      kind,
      kindName: KIND_NAMES[kind],
      scale,
      isDefault: !chosen || chosen === defaultScale(kind),
      targets: targetsFor(kind, scale),
      steps: scoreSteps(scale),
      words: SCALE_WORDS[scale],
      references: refs.rows.filter((row) => row.kind === kind && row.scale === scale).map((row) => row.score),
    };
  });
}

/** An admin changes a kind's scale for a farm (decision 1487). Old scores keep the scale they were given on. */
export async function setScale(tx: OrgTx, input: { farmId: unknown; kind: unknown; scale: unknown }): Promise<ScaleSetting[]> {
  const farmId = await requireFarmId(tx, input.farmId);
  const role = tx.actor.role;
  if (role && !roleAtLeast(role, "admin")) throw new ForbiddenError("Changing a farm's BCS scale needs the admin role.");
  const kind = requireOneOf(input.kind, "Kind of stock", BCS_KINDS);
  const scale = requireOneOf(input.scale, "Scale", BCS_SCALES);
  await tx.query(
    "insert into bcs_scale_settings (farm_id, kind, scale, updated_by_email) values ($1, $2, $3, $4) on conflict (farm_id, kind) do update set scale = excluded.scale, updated_by_email = excluded.updated_by_email, updated_at = now()",
    [farmId, kind, scale, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "farming.bcs_scale_set", entityType: "farm", entityId: farmId, details: { kind, scale } });
  return listScales(tx, { farmId });
}

// Loading --------------------------------------------------------------------------------------------

type RecordRow = {
  id: string;
  farm_id: string;
  animal_id: string | null;
  animal_tag: string | null;
  mob_id: string | null;
  mob_name: string | null;
  kind: string;
  class_code: string | null;
  scored_on: string;
  scale: BcsScale;
  score: string;
  head_scored: number | null;
  tally: Tally | null;
  scored_by: string | null;
  source: BcsRecord["source"];
  note: string | null;
  created_by_email: string;
};

type PhotoRow = { id: string; file_id: string; file_name: string; taken_on: string; bcs_record_id: string | null; reference_kind: string | null; reference_scale: BcsScale | null; reference_score: string | null };

function toPhoto(row: PhotoRow): BcsPhoto {
  return { id: row.id, fileId: row.file_id, fileName: row.file_name, takenOn: row.taken_on, recordId: row.bcs_record_id, reference: row.reference_score ? { kind: row.reference_kind!, scale: row.reference_scale!, score: row.reference_score } : null };
}

const PHOTO_COLUMNS = "p.id::text, p.file_id::text, f.file_name, p.taken_on::text, p.bcs_record_id::text, p.reference_kind, p.reference_scale, p.reference_score::text";

async function loadRecords(tx: OrgTx, where: string, params: unknown[]): Promise<BcsRecord[]> {
  const rows = await tx.query<RecordRow>(
    `select r.id::text, r.farm_id::text, r.animal_id::text, a.tag as animal_tag, r.mob_id::text, m.name as mob_name, coalesce(a.kind, m.kind) as kind, m.class_code,
            r.scored_on::text, r.scale, r.score::text, r.head_scored, r.tally, r.scored_by, r.source, r.note, r.created_by_email
       from bcs_records r left join animals a on a.id = r.animal_id left join mobs m on m.id = r.mob_id
      where r.status = 'active' and ${where}
      order by r.scored_on desc, r.id desc limit 2000`,
    params,
  );
  const ids = rows.rows.map((row) => row.id);
  const photos = ids.length
    ? await tx.query<PhotoRow>(`select ${PHOTO_COLUMNS} from bcs_photos p join safety_files f on f.id = p.file_id where p.status = 'active' and p.bcs_record_id = any($1::bigint[]) order by p.id`, [ids])
    : { rows: [] as PhotoRow[] };
  return rows.rows.map((row) => ({
    id: row.id,
    farmId: row.farm_id,
    animalId: row.animal_id,
    animalTag: row.animal_tag,
    mobId: row.mob_id,
    mobName: row.mob_id ? (row.mob_name ?? row.class_code) : null,
    kind: row.kind,
    scoredOn: row.scored_on,
    scale: row.scale,
    score: row.score,
    headScored: row.head_scored,
    tally: row.tally,
    scoredBy: row.scored_by,
    source: row.source,
    note: row.note,
    photos: photos.rows.filter((photo) => photo.bcs_record_id === row.id).map(toPhoto),
    createdByEmail: row.created_by_email,
  }));
}

export async function animalBcs(tx: OrgTx, animalId: string): Promise<BcsRecord[]> {
  return loadRecords(tx, "r.animal_id = $1", [animalId]);
}

export type MobBcsPoint = { date: string; score: string; head: number | null; from: "mob" | "tags"; scale: BcsScale };
export type MobBcs = { records: BcsRecord[]; trend: MobBcsPoint[]; scale: BcsScale; targets: BcsTargets | null };

/**
 * A mob's BCS (BCS4): its own records (averages and tallies), and for days
 * its tagged animals were scored while in it, their average. A day with
 * both shows the mob's own record. Only scores on the farm's scale now go in
 * the trend; the rest stay listed.
 */
export async function mobBcs(tx: OrgTx, mobIdInput: unknown): Promise<MobBcs> {
  const mob = await mobRow(tx, mobIdInput);
  const scale = await scaleFor(tx, mob.farmId, mob.kind);
  const records = await loadRecords(tx, "r.mob_id = $1", [mob.id]);
  const tags = await tx.query<{ scored_on: string; scores: string[] }>(
    `select r.scored_on::text, array_agg(r.score::text order by r.id) as scores
       from bcs_records r join animal_mobs am on am.animal_id = r.animal_id and am.mob_id = $1
        and r.scored_on >= am.from_on and (am.to_on is null or r.scored_on < am.to_on)
      where r.status = 'active' and r.scale = $2
      group by r.scored_on order by r.scored_on`,
    [mob.id, scale],
  );
  const byDay = new Map<string, MobBcsPoint>();
  for (const row of tags.rows) byDay.set(row.scored_on, { date: row.scored_on, score: averageOf(row.scores)!, head: row.scores.length, from: "tags", scale });
  for (const record of [...records].reverse()) if (record.scale === scale) byDay.set(record.scoredOn, { date: record.scoredOn, score: record.score, head: record.headScored, from: "mob", scale });
  return { records, trend: [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1)), scale, targets: targetsFor(mob.kind, scale) };
}

// Recording ------------------------------------------------------------------------------------------

async function attachPhotos(tx: OrgTx, input: { files: unknown; farmId: string; animalId: string | null; mobId: string | null; takenOn: string; recordId: string | null }): Promise<number> {
  const refs = await fileRefs(tx, input.files, input.farmId, false);
  for (const ref of refs) {
    const file = await tx.query<{ content_type: string }>("select content_type from safety_files where id = $1", [ref.id]);
    if (!file.rows[0]?.content_type.startsWith("image/")) throw new ValidationError("BCS photos must be photos, not documents.");
    const existing = await tx.query<{ id: string; bcs_record_id: string | null }>("select id::text, bcs_record_id::text from bcs_photos where file_id = $1", [ref.id]);
    if (existing.rows[0]) {
      // A photo kept to score later, now scored by a person.
      if (input.recordId && !existing.rows[0].bcs_record_id) await tx.query("update bcs_photos set bcs_record_id = $2 where id = $1", [existing.rows[0].id, input.recordId]);
      continue;
    }
    await tx.query("insert into bcs_photos (farm_id, file_id, animal_id, mob_id, taken_on, bcs_record_id, created_by_email) values ($1, $2, $3, $4, $5, $6, $7)", [
      input.farmId,
      ref.id,
      input.animalId,
      input.mobId,
      input.takenOn,
      input.recordId,
      tx.actor.email,
    ]);
  }
  return refs.length;
}

type Subject = { farmId: string; kind: string; animal: Animal | null; mob: Mob | null; name: string };

async function subject(tx: OrgTx, input: { animalId?: unknown; mobId?: unknown }, lock = false): Promise<Subject> {
  const hasAnimal = input.animalId !== undefined && input.animalId !== null && input.animalId !== "";
  const hasMob = input.mobId !== undefined && input.mobId !== null && input.mobId !== "";
  if (hasAnimal === hasMob) throw new ValidationError("Choose an animal or a mob.");
  if (hasAnimal) {
    const animal = await animalRow(tx, input.animalId, lock);
    return { farmId: animal.farmId, kind: animal.kind, animal, mob: null, name: animal.tag };
  }
  const mob = await mobRow(tx, input.mobId, lock);
  return { farmId: mob.farmId, kind: mob.kind, animal: null, mob, name: mob.name };
}

async function replay(tx: OrgTx, table: "bcs_records" | "animal_weights", operationId: string | null, hash: string): Promise<string | null> {
  if (!operationId) return null;
  const row = await tx.query<{ id: string; request_hash: string | null; created_by_email: string }>(`select id::text, request_hash, created_by_email from ${table} where operation_id = $1`, [operationId]);
  if (!row.rows[0]) return null;
  if (row.rows[0].request_hash !== hash || row.rows[0].created_by_email !== tx.actor.email) throw new ConflictError("This was already sent with different details. Nothing was changed: check it and record it again.");
  return row.rows[0].id;
}

/**
 * Records a BCS (BCS1-BCS3): for an animal, `score` in half points; for a
 * mob, a `tally` ({"4.5": 12, ...}) or an `average` and optionally
 * `headScored`. Photos (`files`, from the farm photo store) go with it.
 * `operationId` lets a phone send it again safely.
 */
export async function recordBcs(tx: OrgTx, input: Record<string, unknown>): Promise<{ record: BcsRecord; message: string }> {
  const target = await subject(tx, input);
  if (target.animal && (target.animal.status === "sold" || target.animal.status === "dead")) throw new ValidationError(`${target.animal.tag} is ${target.animal.status}.`);
  if (target.mob && target.mob.status !== "active") throw new ValidationError(`${target.mob.name} is closed.`);
  const scale = await scaleFor(tx, target.farmId, target.kind);
  const scoredOn = eventDate(input.onDate);
  const operationId = optionalOperationId(input.operationId);
  const source = input.source === "quick" ? "quick" : "typed";
  const note = optionalString(input.note, "Note", { maxLength: 200 });
  const scoredBy = optionalString(input.scoredBy, "Scored by", { maxLength: 100 });
  let score: string;
  let headScored: number | null = null;
  let tally: Tally | null = null;
  if (target.animal) {
    score = parseScore(input.score, scale);
  } else if (input.tally !== undefined && input.tally !== null && input.tally !== "") {
    const summary = tallySummary(input.tally, scale);
    if (summary.head > target.mob!.head) throw new ValidationError(`The tally has ${summary.head} head but ${target.mob!.name} has ${target.mob!.head}.`);
    score = summary.average;
    headScored = summary.head;
    tally = summary.tally;
  } else {
    score = parseAverage(input.average ?? input.score, scale);
    if (input.headScored !== undefined && input.headScored !== null && input.headScored !== "") {
      const head = Number(input.headScored);
      if (!Number.isInteger(head) || head < 1 || head > target.mob!.head) throw new ValidationError(`Head scored must be a whole number from 1 to ${target.mob!.head}.`);
      headScored = head;
    }
  }
  const files = Array.isArray(input.files) ? input.files.map((file) => (file && typeof file === "object" ? String((file as { id?: unknown }).id) : String(file))) : [];
  const hash = requestHash("bcs_record", { animalId: target.animal?.id ?? null, mobId: target.mob?.id ?? null, scoredOn, scale, score, headScored, tally, note, scoredBy, files });
  const again = await replay(tx, "bcs_records", operationId, hash);
  if (again) return { record: (await loadRecords(tx, "r.id = $1", [again]))[0], message: "Already recorded." };
  const row = await tx.query<{ id: string }>(
    `insert into bcs_records (farm_id, animal_id, mob_id, scored_on, scale, score, head_scored, tally, scored_by, source, note, operation_id, request_hash, created_by_email)
     values ($1, $2, $3, $4, $5, $6::numeric, $7, $8::jsonb, $9, $10, $11, $12, $13, $14) returning id::text`,
    [target.farmId, target.animal?.id ?? null, target.mob?.id ?? null, scoredOn, scale, score, headScored, tally ? JSON.stringify(tally) : null, scoredBy, source, note, operationId, operationId ? hash : null, tx.actor.email],
  );
  const id = row.rows[0].id;
  await attachPhotos(tx, { files: input.files, farmId: target.farmId, animalId: target.animal?.id ?? null, mobId: target.mob?.id ?? null, takenOn: scoredOn, recordId: id });
  await writeAuditEvent(tx, { eventType: "farming.bcs_recorded", entityType: "bcs_record", entityId: id, details: { animalId: target.animal?.id ?? null, mobId: target.mob?.id ?? null, scoredOn, scale, score, headScored } });
  return { record: (await loadRecords(tx, "r.id = $1", [id]))[0], message: `BCS ${score} recorded for ${target.name}.` };
}

/**
 * Quick entry for one animal (BCS5): a score and/or a weight on a day, from
 * the field screen. Each is its own record; one operation id covers both,
 * so the phone can send it again safely.
 */
export async function recordReadings(tx: OrgTx, animalIdInput: unknown, input: Record<string, unknown>): Promise<{ animal: Animal; message: string }> {
  const animal = await animalRow(tx, animalIdInput, true);
  if (input.farmId !== undefined && input.farmId !== null && input.farmId !== "" && requireId(input.farmId, "farmId") !== animal.farmId) throw new ConflictError(`${animal.tag} isn't on the farm this was recorded for. Nothing was saved.`);
  const hasScore = input.score !== undefined && input.score !== null && input.score !== "";
  const hasKg = input.kg !== undefined && input.kg !== null && input.kg !== "";
  if (!hasScore && !hasKg) throw new ValidationError("Enter a score or a weight.");
  const onDate = eventDate(input.onDate);
  const operationId = optionalOperationId(input.operationId);
  const parts: string[] = [];
  if (hasScore) {
    const result = await recordBcs(tx, { animalId: animal.id, score: input.score, onDate, operationId, source: "quick", files: input.files });
    parts.push(result.message === "Already recorded." ? "BCS already recorded" : `BCS ${result.record.score}`);
  }
  if (hasKg) {
    const kg = parseKg(input.kg);
    const hash = requestHash("animal_weight", { animalId: animal.id, onDate, kg });
    const again = await replay(tx, "animal_weights", operationId, hash);
    if (!again) {
      await recordAnimalWeight(tx, animal, { kg, onDate, source: input.source === "typed" ? "typed" : "quick", operationId, hash: operationId ? hash : null });
      await writeAuditEvent(tx, { eventType: "farming.animal_weighed", entityType: "animal", entityId: animal.id, details: { onDate, kg } });
    }
    parts.push(again ? "weight already recorded" : `${kg} kg`);
  }
  return { animal: await animalRow(tx, animal.id), message: `${animal.tag}: ${parts.join(", ")}.` };
}

export async function removeBcs(tx: OrgTx, idInput: unknown, input: { reason: unknown }): Promise<void> {
  await requireFarming(tx);
  requireBooks(tx, "Removing a BCS");
  const id = requireId(idInput, "bcsId");
  const reason = requireString(input.reason, "Reason", { maxLength: 500 });
  const row = await tx.query<{ farm_id: string; status: string }>("select farm_id::text, status from bcs_records where id = $1 for update", [id]);
  if (!row.rows[0]) throw new NotFoundError("Score not found.");
  await requireFarmAccess(tx, row.rows[0].farm_id, "Score not found.");
  if (row.rows[0].status !== "active") throw new ValidationError("That score is removed already.");
  await tx.query("update bcs_records set status = 'removed', removed_reason = $2 where id = $1", [id, reason]);
  await writeAuditEvent(tx, { eventType: "farming.bcs_removed", entityType: "bcs_record", entityId: id, details: { reason } });
}

// Photos and references -------------------------------------------------------------------------------

/** Photos kept to score later (by eye, or by the person's AI): no score yet (decision 1491). */
export async function addPhotosToScore(tx: OrgTx, input: { animalId?: unknown; mobId?: unknown; files?: unknown; onDate?: unknown }): Promise<{ added: number }> {
  const target = await subject(tx, input);
  const added = await attachPhotos(tx, { files: input.files, farmId: target.farmId, animalId: target.animal?.id ?? null, mobId: target.mob?.id ?? null, takenOn: eventDate(input.onDate), recordId: null });
  if (!added) throw new ValidationError("Add a photo.");
  await writeAuditEvent(tx, { eventType: "farming.bcs_photos_added", entityType: target.animal ? "animal" : "mob", entityId: target.animal?.id ?? target.mob!.id, details: { added } });
  return { added };
}

export async function photosFor(tx: OrgTx, input: { animalId?: unknown; mobId?: unknown }): Promise<BcsPhoto[]> {
  const target = await subject(tx, input);
  const rows = await tx.query<PhotoRow>(
    `select ${PHOTO_COLUMNS} from bcs_photos p join safety_files f on f.id = p.file_id where p.status = 'active' and ${target.animal ? "p.animal_id" : "p.mob_id"} = $1 order by p.taken_on desc, p.id desc limit 100`,
    [target.animal?.id ?? target.mob!.id],
  );
  return rows.rows.map(toPhoto);
}

/**
 * Marks a photo as a reference for its kind and a score given by eye
 * (decision 1493). An animal's photo with its record takes that score; a
 * mob's photo needs the score typed (the photo shows some of the mob). A
 * score that came from an AI suggestion can't be a reference.
 */
export async function setReference(tx: OrgTx, photoIdInput: unknown, input: { score?: unknown; clear?: unknown }): Promise<BcsPhoto> {
  await requireFarming(tx);
  const id = requireId(photoIdInput, "photoId");
  const row = await tx.query<{ farm_id: string; animal_id: string | null; mob_id: string | null; bcs_record_id: string | null }>("select farm_id::text, animal_id::text, mob_id::text, bcs_record_id::text from bcs_photos where id = $1 and status = 'active' for update", [id]);
  const photo = row.rows[0];
  if (!photo) throw new NotFoundError("Photo not found.");
  await requireFarmAccess(tx, photo.farm_id, "Photo not found.");
  if (input.clear === true) {
    await tx.query("update bcs_photos set reference_kind = null, reference_scale = null, reference_score = null, reference_marked_by_email = null, reference_marked_at = null where id = $1", [id]);
  } else {
    const target = await subject(tx, { animalId: photo.animal_id, mobId: photo.mob_id });
    const record = photo.bcs_record_id ? (await loadRecords(tx, "r.id = $1", [photo.bcs_record_id]))[0] : null;
    if (record?.source === "ai_suggestion") throw new ValidationError("This score came from an AI suggestion. A reference is a score given by eye: score the animal by eye and record that.");
    const scale = record?.scale ?? (await scaleFor(tx, target.farmId, target.kind));
    const typed = input.score !== undefined && input.score !== null && input.score !== "";
    if (!typed && !(record && target.animal)) throw new ValidationError("Enter the score you gave by eye for what this photo shows.");
    const score = typed ? parseScore(input.score, scale) : record!.score;
    await tx.query("update bcs_photos set reference_kind = $2, reference_scale = $3, reference_score = $4::numeric, reference_marked_by_email = $5, reference_marked_at = now() where id = $1", [id, target.kind, scale, score, tx.actor.email]);
  }
  await writeAuditEvent(tx, { eventType: "farming.bcs_reference_set", entityType: "bcs_photo", entityId: id, details: { score: input.score ?? null, clear: input.clear === true } });
  const back = await tx.query<PhotoRow>(`select ${PHOTO_COLUMNS} from bcs_photos p join safety_files f on f.id = p.file_id where p.id = $1`, [id]);
  return toPhoto(back.rows[0]);
}

export type ReferencePhoto = { photoId: string; fileId: string; farmId: string; kind: string; scale: BcsScale; score: string; takenOn: string; sizeBytes: number; contentType: string };

/** The organisation's reference photos for a kind on a scale, newest first, `perScore` of each score, on farms the person can see. */
export async function referencePhotos(tx: OrgTx, input: { kind: string; scale: BcsScale; perScore?: number; farmId?: string }): Promise<ReferencePhoto[]> {
  const visible = await visibleFarmIds(tx);
  const rows = await tx.query<{ id: string; file_id: string; farm_id: string; kind: string; scale: BcsScale; score: string; taken_on: string; size_bytes: number; content_type: string; n: string }>(
    `select * from (
       select p.id::text, p.file_id::text, p.farm_id::text, p.reference_kind as kind, p.reference_scale as scale, p.reference_score::text as score, p.taken_on::text, f.size_bytes, f.content_type,
              row_number() over (partition by p.reference_score order by (p.farm_id = $4::bigint) desc nulls last, p.taken_on desc, p.id desc) as n
         from bcs_photos p join safety_files f on f.id = p.file_id
        where p.status = 'active' and p.reference_kind = $1 and p.reference_scale = $2 and ($3::bigint[] is null or p.farm_id = any($3::bigint[]))) x
      where x.n <= $5 order by x.score::numeric, x.n`,
    [input.kind, input.scale, visible, input.farmId ?? null, input.perScore ?? 2],
  );
  return rows.rows.map((row) => ({ photoId: row.id, fileId: row.file_id, farmId: row.farm_id, kind: row.kind, scale: row.scale, score: row.score, takenOn: row.taken_on, sizeBytes: row.size_bytes, contentType: row.content_type }));
}

// AI suggestions (decisions 1491-1494) ----------------------------------------------------------------

export type BcsSuggestion = {
  id: string;
  farmId: string;
  animalId: string | null;
  animalTag: string | null;
  mobId: string | null;
  mobName: string | null;
  photo: { id: string; fileId: string; takenOn: string };
  scale: BcsScale;
  score: string;
  estimatedKg: string | null;
  reasoning: string;
  referencePhotoIds: string[];
  aiKeyName: string | null;
  proposedByEmail: string;
  createdAt: string;
  status: "waiting" | "accepted" | "declined";
  decidedScore: string | null;
  decidedKg: string | null;
  bcsRecordId: string | null;
  decidedByEmail: string | null;
  decidedAt: string | null;
  declineReason: string | null;
};

type SuggestionRow = {
  id: string;
  farm_id: string;
  animal_id: string | null;
  animal_tag: string | null;
  mob_id: string | null;
  mob_name: string | null;
  mob_class: string | null;
  photo_id: string;
  file_id: string;
  taken_on: string;
  scale: BcsScale;
  score: string;
  estimated_kg: string | null;
  reasoning: string;
  reference_photo_ids: string[];
  ai_key_name: string | null;
  proposed_by_email: string;
  created_at: string;
  status: BcsSuggestion["status"];
  decided_score: string | null;
  decided_kg: string | null;
  bcs_record_id: string | null;
  decided_by_email: string | null;
  decided_at: string | null;
  decline_reason: string | null;
};

async function loadSuggestions(tx: OrgTx, where: string, params: unknown[], limit = 200): Promise<BcsSuggestion[]> {
  const rows = await tx.query<SuggestionRow>(
    `select s.id::text, s.farm_id::text, s.animal_id::text, a.tag as animal_tag, s.mob_id::text, m.name as mob_name, m.class_code as mob_class, s.photo_id::text, p.file_id::text, p.taken_on::text,
            s.scale, s.score::text, s.estimated_kg::text, s.reasoning, s.reference_photo_ids::text[] as reference_photo_ids, s.ai_key_name, s.proposed_by_email, s.created_at::text, s.status,
            s.decided_score::text, s.decided_kg::text, s.bcs_record_id::text, s.decided_by_email, s.decided_at::text, s.decline_reason
       from bcs_suggestions s join bcs_photos p on p.id = s.photo_id left join animals a on a.id = s.animal_id left join mobs m on m.id = s.mob_id
      where ${where} order by s.status = 'waiting' desc, s.created_at desc, s.id desc limit ${Math.trunc(limit)}`,
    params,
  );
  return rows.rows.map((row) => ({
    id: row.id,
    farmId: row.farm_id,
    animalId: row.animal_id,
    animalTag: row.animal_tag,
    mobId: row.mob_id,
    mobName: row.mob_id ? (row.mob_name ?? row.mob_class) : null,
    photo: { id: row.photo_id, fileId: row.file_id, takenOn: row.taken_on },
    scale: row.scale,
    score: row.score,
    estimatedKg: row.estimated_kg,
    reasoning: row.reasoning,
    referencePhotoIds: row.reference_photo_ids ?? [],
    aiKeyName: row.ai_key_name,
    proposedByEmail: row.proposed_by_email,
    createdAt: row.created_at,
    status: row.status,
    decidedScore: row.decided_score,
    decidedKg: row.decided_kg,
    bcsRecordId: row.bcs_record_id,
    decidedByEmail: row.decided_by_email,
    decidedAt: row.decided_at,
    declineReason: row.decline_reason,
  }));
}

/** Suggestions for an animal or a mob: waiting first, then the latest decided. */
export async function listSuggestions(tx: OrgTx, input: { animalId?: unknown; mobId?: unknown }): Promise<BcsSuggestion[]> {
  const target = await subject(tx, input);
  return target.animal ? loadSuggestions(tx, "s.animal_id = $1", [target.animal.id], 50) : loadSuggestions(tx, "s.mob_id = $1", [target.mob!.id], 50);
}

export type PhotoToScore = { photoId: string; farmId: string; animalId: string | null; animalTag: string | null; mobId: string | null; mobName: string | null; kind: string; takenOn: string; sizeBytes: number; contentType: string };

/** Photos with no score and no suggestion waiting or accepted, newest first, on farms the person can see. */
export async function photosToScore(tx: OrgTx, input: { farmId?: unknown; animalId?: unknown; mobId?: unknown; limit?: number; offset?: number }): Promise<PhotoToScore[]> {
  await requireFarming(tx);
  const visible = await visibleFarmIds(tx);
  const params: unknown[] = [visible];
  const where = ["p.status = 'active'", "p.bcs_record_id is null", "($1::bigint[] is null or p.farm_id = any($1::bigint[]))", "not exists (select 1 from bcs_suggestions s where s.photo_id = p.id and s.status in ('waiting', 'accepted'))", "p.reference_score is null"];
  for (const [key, column] of [["farmId", "p.farm_id"], ["animalId", "p.animal_id"], ["mobId", "p.mob_id"]] as const) {
    const value = input[key];
    if (value !== undefined && value !== null && value !== "") {
      params.push(requireId(value, key));
      where.push(`${column} = $${params.length}`);
    }
  }
  const rows = await tx.query<{ id: string; farm_id: string; animal_id: string | null; tag: string | null; mob_id: string | null; mob_name: string | null; mob_class: string | null; kind: string; taken_on: string; size_bytes: number; content_type: string }>(
    `select p.id::text, p.farm_id::text, p.animal_id::text, a.tag, p.mob_id::text, m.name as mob_name, m.class_code as mob_class, coalesce(a.kind, m.kind) as kind, p.taken_on::text, f.size_bytes, f.content_type
       from bcs_photos p join safety_files f on f.id = p.file_id left join animals a on a.id = p.animal_id left join mobs m on m.id = p.mob_id
      where ${where.join(" and ")} order by p.taken_on desc, p.id desc limit ${Math.trunc(input.limit ?? 20)} offset ${Math.trunc(input.offset ?? 0)}`,
    params,
  );
  return rows.rows.map((row) => ({ photoId: row.id, farmId: row.farm_id, animalId: row.animal_id, animalTag: row.tag, mobId: row.mob_id, mobName: row.mob_id ? (row.mob_name ?? row.mob_class) : null, kind: row.kind, takenOn: row.taken_on, sizeBytes: row.size_bytes, contentType: row.content_type }));
}

/** A photo's bytes for the AI, if the person may see it. */
export async function bcsPhotoContent(tx: OrgTx, photoId: string): Promise<{ content: Buffer; contentType: string; fileName: string; sizeBytes: number; farmId: string }> {
  const row = await tx.query<{ farm_id: string; content: Buffer; content_type: string; file_name: string; size_bytes: number }>(
    "select p.farm_id::text, f.content, f.content_type, f.file_name, f.size_bytes from bcs_photos p join safety_files f on f.id = p.file_id where p.id = $1 and p.status = 'active'",
    [photoId],
  );
  if (!row.rows[0]) throw new NotFoundError("That photo wasn't found.");
  await requireFarmAccess(tx, row.rows[0].farm_id, "That photo wasn't found.");
  return { content: row.rows[0].content, contentType: row.rows[0].content_type, fileName: row.rows[0].file_name, sizeBytes: row.rows[0].size_bytes, farmId: row.rows[0].farm_id };
}

/**
 * The AI's suggestion from a photo (decision 1491): a score on the farm's
 * scale, optionally an estimated liveweight, the reason, and which
 * reference photos it compared against. Kept as a suggestion only.
 */
export async function suggestBcs(tx: OrgTx, input: Record<string, unknown>): Promise<{ created: boolean; suggestion: BcsSuggestion }> {
  await requireFarming(tx);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const photoId = requireId(input.photoId, "photoId");
  const photo = await tx.query<{ farm_id: string; animal_id: string | null; mob_id: string | null; bcs_record_id: string | null; reference_score: string | null }>("select farm_id::text, animal_id::text, mob_id::text, bcs_record_id::text, reference_score::text from bcs_photos where id = $1 and status = 'active'", [photoId]);
  if (!photo.rows[0]) throw new NotFoundError("That photo wasn't found. list_bcs_photos_to_score lists them.");
  await requireFarmAccess(tx, photo.rows[0].farm_id, "That photo wasn't found.");
  const target = await subject(tx, { animalId: photo.rows[0].animal_id, mobId: photo.rows[0].mob_id });
  const named = input.animalId ?? input.mobId;
  if (named !== undefined && named !== null && named !== "" && String(named) !== (target.animal?.id ?? target.mob!.id)) throw new ValidationError(`That photo is of ${target.name}, not the ${input.animalId ? "animal" : "mob"} named.`);
  const scale = await scaleFor(tx, target.farmId, target.kind);
  const score = parseScore(input.score, scale, "score");
  const estimatedKg = input.estimatedKg === undefined || input.estimatedKg === null || input.estimatedKg === "" ? null : parseKg(typeof input.estimatedKg === "number" ? String(input.estimatedKg) : input.estimatedKg, "estimatedKg");
  const reasoning = requireString(input.reasoning, "reasoning", { maxLength: 500 });
  const references = Array.isArray(input.referencePhotoIds) ? [...new Set(input.referencePhotoIds.map((value) => requireId(value, "referencePhotoIds")))] : [];
  if (references.length > 50) throw new ValidationError("Name at most 50 reference photos.");
  if (references.length) {
    const visible = await visibleFarmIds(tx);
    const found = await tx.query<{ n: number }>("select count(*)::int as n from bcs_photos where id = any($1::bigint[]) and reference_score is not null and status = 'active' and ($2::bigint[] is null or farm_id = any($2::bigint[]))", [references, visible]);
    if (found.rows[0].n !== references.length) throw new ValidationError("One of the reference photos wasn't found. Use the ids get_bcs_photos_to_score gave.");
  }
  const hash = requestHash("bcs_suggestion", { photoId, score, estimatedKg, reasoning, references });
  const again = await tx.query<{ id: string; request_hash: string }>("select id::text, request_hash from bcs_suggestions where idempotency_key = $1", [idempotencyKey]);
  if (again.rows[0]) {
    assertSameRequest(again.rows[0].request_hash, hash, "BCS suggestion");
    return { created: false, suggestion: (await loadSuggestions(tx, "s.id = $1", [again.rows[0].id]))[0] };
  }
  if (photo.rows[0].bcs_record_id || photo.rows[0].reference_score) throw new ConflictError("A person has scored that photo already.");
  const waiting = await tx.query("select 1 from bcs_suggestions where photo_id = $1 and status in ('waiting', 'accepted')", [photoId]);
  if (waiting.rowCount) throw new ConflictError("That photo has a suggestion already. list_bcs_photos_to_score lists photos without one.");
  const row = await tx.query<{ id: string }>(
    `insert into bcs_suggestions (farm_id, animal_id, mob_id, photo_id, scale, score, estimated_kg, reasoning, reference_photo_ids, ai_key_name, proposed_by_user_id, proposed_by_email, idempotency_key, request_hash)
     values ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8, $9::bigint[], $10, $11, $12, $13, $14) returning id::text`,
    [target.farmId, target.animal?.id ?? null, target.mob?.id ?? null, photoId, scale, score, estimatedKg, reasoning, references, tx.actor.via ?? null, tx.actor.userId, tx.actor.email, idempotencyKey, hash],
  );
  await writeAuditEvent(tx, { eventType: "farming.bcs_suggested", entityType: "bcs_suggestion", entityId: row.rows[0].id, details: { photoId, score, estimatedKg, references } });
  return { created: true, suggestion: (await loadSuggestions(tx, "s.id = $1", [row.rows[0].id]))[0] };
}

async function lockWaiting(tx: OrgTx, idInput: unknown): Promise<BcsSuggestion> {
  await requireFarming(tx);
  const id = requireId(idInput, "suggestionId");
  await tx.query("select 1 from bcs_suggestions where id = $1 for update", [id]);
  const suggestion = (await loadSuggestions(tx, "s.id = $1", [id]))[0];
  if (!suggestion) throw new NotFoundError("That suggestion wasn't found.");
  await requireFarmAccess(tx, suggestion.farmId, "That suggestion wasn't found.");
  if (suggestion.status !== "waiting") throw new ConflictError(`This suggestion was already ${suggestion.status}.`);
  return suggestion;
}

/**
 * A person accepts a suggestion (BCS7), as suggested or with their own
 * score, and optionally its liveweight (as suggested or changed). That makes
 * a normal BCS record, and a weight, marked as from an AI suggestion and who
 * accepted it. Only now does it count.
 */
export async function acceptSuggestion(tx: OrgTx, idInput: unknown, input: { score?: unknown; acceptWeight?: unknown; kg?: unknown } = {}): Promise<BcsSuggestion> {
  const suggestion = await lockWaiting(tx, idInput);
  const target = await subject(tx, { animalId: suggestion.animalId, mobId: suggestion.mobId });
  if (target.animal && (target.animal.status === "sold" || target.animal.status === "dead")) throw new ValidationError(`${target.animal.tag} is ${target.animal.status}.`);
  if (target.mob && target.mob.status !== "active") throw new ValidationError(`${target.mob.name} is closed.`);
  const changed = input.score !== undefined && input.score !== null && input.score !== "";
  const score = changed ? (target.mob ? parseAverage(input.score, suggestion.scale) : parseScore(input.score, suggestion.scale)) : suggestion.score;
  const note = `From an AI suggestion (${suggestion.score}${suggestion.aiKeyName ? ` via ${suggestion.aiKeyName}` : ""})${score !== suggestion.score ? ", changed" : ""}; accepted by ${tx.actor.email}`.slice(0, 200);
  const record = await tx.query<{ id: string }>(
    `insert into bcs_records (farm_id, animal_id, mob_id, scored_on, scale, score, source, note, suggestion_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6::numeric, 'ai_suggestion', $7, $8, $9) returning id::text`,
    [suggestion.farmId, suggestion.animalId, suggestion.mobId, suggestion.photo.takenOn, suggestion.scale, score, note, suggestion.id, tx.actor.email],
  );
  await tx.query("update bcs_photos set bcs_record_id = $2 where id = $1 and bcs_record_id is null", [suggestion.photo.id, record.rows[0].id]);
  let kg: string | null = null;
  let weightId: string | null = null;
  let eventId: string | null = null;
  if (input.acceptWeight === true) {
    const typed = input.kg !== undefined && input.kg !== null && input.kg !== "";
    if (!typed && !suggestion.estimatedKg) throw new ValidationError("This suggestion has no liveweight.");
    kg = typed ? parseKg(input.kg) : suggestion.estimatedKg!;
    if (target.animal) weightId = await recordAnimalWeight(tx, target.animal, { kg, onDate: suggestion.photo.takenOn, source: "ai_suggestion", operationId: null, hash: null, note: note.replace("accepted", "weight accepted").slice(0, 200) });
    else eventId = await addEvent(tx, { mobId: target.mob!.id, farmId: target.farmId, eventType: "weighed", eventDate: suggestion.photo.takenOn, headAfter: target.mob!.head, averageKg: kg, note: `Estimated from a photo by AI, not weighed; accepted by ${tx.actor.email}` });
  }
  await tx.query("update bcs_suggestions set status = 'accepted', decided_score = $2::numeric, decided_kg = $3::numeric, bcs_record_id = $4, animal_weight_id = $5, mob_event_id = $6, decided_by_email = $7, decided_at = now() where id = $1", [
    suggestion.id,
    score,
    kg,
    record.rows[0].id,
    weightId,
    eventId,
    tx.actor.email,
  ]);
  await writeAuditEvent(tx, { eventType: "farming.bcs_suggestion_accepted", entityType: "bcs_suggestion", entityId: suggestion.id, details: { suggested: suggestion.score, saved: score, kg, recordId: record.rows[0].id } });
  return (await loadSuggestions(tx, "s.id = $1", [suggestion.id]))[0];
}

/** Declines a suggestion: kept, and nothing is recorded. */
export async function declineSuggestion(tx: OrgTx, idInput: unknown, input: { reason?: unknown } = {}): Promise<BcsSuggestion> {
  const suggestion = await lockWaiting(tx, idInput);
  const reason = optionalString(input.reason, "Reason", { maxLength: 500 });
  await tx.query("update bcs_suggestions set status = 'declined', decided_by_email = $2, decided_at = now(), decline_reason = $3 where id = $1", [suggestion.id, tx.actor.email, reason]);
  await writeAuditEvent(tx, { eventType: "farming.bcs_suggestion_declined", entityType: "bcs_suggestion", entityId: suggestion.id, details: { reason } });
  return (await loadSuggestions(tx, "s.id = $1", [suggestion.id]))[0];
}

/** For the AI: one kind's scale on a farm, with its descriptions and targets. */
export async function scaleInfo(tx: OrgTx, farmId: string, kind: string) {
  const scale = await scaleFor(tx, farmId, kind);
  return { kind, kindName: KIND_NAMES[kind as keyof typeof KIND_NAMES] ?? kind, scale, scaleName: SCALE_LABELS[scale], steps: "half points", descriptions: SCALE_WORDS[scale], targets: targetsFor(kind, scale) };
}

