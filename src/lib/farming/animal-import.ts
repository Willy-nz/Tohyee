import { writeAuditEvent } from "@/lib/audit";
import { parseBankDate } from "@/lib/bank/formats/common";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ValidationError } from "@/lib/errors";
import { animalsIn, taggedCount } from "@/lib/farming/animal-mobs";
import { type AnimalSex, sexFrom, tagKey } from "@/lib/farming/animal-rules";
import { requireFarmId } from "@/lib/farming/animals";
import { scaleFor } from "@/lib/farming/bcs";
import { BCS_KINDS, type BcsScale, parseScore } from "@/lib/farming/bcs-rules";
import { kindFrom, mobName } from "@/lib/farming/mob-rules";
import { fileRows, importSource } from "@/lib/farming/soil";
import { KIND_NAMES, type LivestockKind } from "@/lib/livestock/classes";
import { cmp, dec, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/*
 * Importing animals and their scores and weights (decisions 1485, 1490;
 * examples AN9, BCS6). A CSV or .xlsx, previewed first; a file is imported
 * once. Nothing is made silently: a tag in a scores file that isn't on the
 * register is listed and skipped, never added. Animals come in tagged into
 * their mob (no head changes), only while the mob has room.
 */

const MAX_ROWS = 20000;
const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
type ImportInput = { fileName?: unknown; content?: unknown; contentBase64?: unknown };

async function readTable(input: ImportInput, what: string) {
  const fileName = typeof input.fileName === "string" && input.fileName.trim() ? input.fileName.trim().slice(0, 200) : "";
  if (!fileName) throw new ValidationError("Choose a file.");
  const { rows: table, sha256 } = await fileRows(fileName, { ...input, fileName });
  const start = table.findIndex((cells) => cells.filter((cell) => cell.trim()).length >= 2);
  if (start < 0 || table.length < start + 2) throw new ValidationError(`The file needs a heading row and at least one ${what}.`);
  if (table.length - start - 1 > MAX_ROWS) throw new ValidationError(`The file has more than ${MAX_ROWS.toLocaleString("en-NZ")} rows.`);
  const headings = table[start].map((cell) => cell.trim());
  const find = (...tests: Array<(heading: string) => boolean>) => {
    for (const test of tests) {
      const index = headings.findIndex((heading) => test(norm(heading)));
      if (index >= 0) return index;
    }
    return null;
  };
  const body = table
    .slice(start + 1)
    .map((cells, offset) => ({ cells, line: start + offset + 2 }))
    .filter(({ cells }) => cells.some((cell) => cell.trim()));
  return { fileName, sha256, headings, find, body };
}

async function earlier(tx: OrgTx, farmId: string, kind: string, sha256: string): Promise<string | null> {
  const row = await tx.query<{ created_at: string }>("select created_at::text from farm_imports where farm_id = $1 and kind = $2 and sha256 = $3", [farmId, kind, sha256]);
  return row.rows[0]?.created_at ?? null;
}

const isEid = (heading: string) => heading === "eid" || heading.includes("eid") || heading.includes("nait") || heading.includes("electronic") || heading === "rfid";
const isTag = (heading: string) => heading === "tag" || heading === "visual tag" || heading === "vid" || heading === "animal" || heading === "id" || heading === "tag number" || heading === "visual id";

// Animals --------------------------------------------------------------------------------------------

export type AnimalImportRow = {
  line: number;
  tag: string | null;
  eid: string | null;
  kind: LivestockKind | null;
  sex: AnimalSex | null;
  breed: string | null;
  birthOn: string | null;
  dam: string | null;
  damFound: boolean;
  mobId: string | null;
  mobName: string | null;
  error: string | null;
};
export type AnimalImportPreview = { fileName: string; rows: AnimalImportRow[]; counts: { animals: number; errors: number; damsTyped: number }; alreadyImportedOn: string | null };

async function readAnimals(tx: OrgTx, farmId: string, input: ImportInput, defaultKindInput: unknown) {
  const file = await readTable(input, "animal");
  const c = {
    tag: file.find(isTag, (h) => h.includes("tag") && !isEid(h)),
    eid: file.find(isEid),
    kind: file.find((h) => h === "kind" || h === "species" || h === "stock"),
    sex: file.find((h) => h === "sex" || h === "gender"),
    breed: file.find((h) => h === "breed" || h.includes("breed")),
    birth: file.find((h) => h.includes("birth") || h === "dob" || h === "born"),
    dam: file.find((h) => h === "dam" || h.startsWith("dam") || h === "mother"),
    sire: file.find((h) => h === "sire" || h.startsWith("sire") || h === "father" || h.includes("bull")),
    mob: file.find((h) => h === "mob" || h.startsWith("mob") || h === "group"),
  };
  if (c.tag === null) throw new ValidationError("The file needs a tag column.");
  const defaultKind = defaultKindInput ? kindFrom(String(defaultKindInput)) : null;
  const mobs = await tx.query<{ id: string; name: string | null; kind: LivestockKind; classCode: string; head: number }>("select id::text, name, kind, class_code as \"classCode\", head from mobs where farm_id = $1 and status = 'active'", [farmId]);
  const room = new Map<string, number>();
  for (const mob of mobs.rows) room.set(mob.id, mob.head - (await taggedCount(tx, mob.id)));
  const existing = await tx.query<{ kind: string; tag: string; eid: string | null }>("select kind, tag, eid from animals where farm_id = $1 and status in ('on_farm', 'missing')", [farmId]);
  const tags = new Set(existing.rows.map((row) => `${row.kind}:${tagKey(row.tag)}`));
  const allTags = new Set(existing.rows.map((row) => tagKey(row.tag)));
  const eids = new Set(existing.rows.filter((row) => row.eid).map((row) => tagKey(row.eid!)));
  const fileTags = new Set(file.body.map(({ cells }) => tagKey((cells[c.tag!] ?? "").trim())).filter(Boolean));
  const rows: Array<AnimalImportRow & { sire: string | null }> = file.body.map(({ cells, line }) => {
    const cell = (index: number | null) => (index === null ? "" : (cells[index] ?? "").trim());
    const tag = cell(c.tag).slice(0, 30) || null;
    const eid = cell(c.eid).slice(0, 30) || null;
    const mobText = cell(c.mob);
    const mob = mobText ? (mobs.rows.find((entry) => mobName(entry).toLowerCase() === mobText.toLowerCase()) ?? null) : null;
    const kindText = cell(c.kind);
    const kind = kindText ? kindFrom(kindText) : (mob?.kind ?? defaultKind);
    const sexText = cell(c.sex);
    const sex = sexText ? sexFrom(sexText) : null;
    const birthText = cell(c.birth);
    const birthOn = birthText ? parseBankDate(birthText) : null;
    const dam = cell(c.dam).slice(0, 60) || null;
    let error: string | null = null;
    if (!tag) error = "No tag.";
    else if (!kind) error = kindText ? `"${kindText}" isn't a kind of stock Tohyee knows.` : "No kind of stock: add a kind column, choose a mob, or choose the kind above.";
    else if (!(BCS_KINDS as readonly string[]).includes(kind)) error = "Unknown kind.";
    else if (sexText && !sex) error = `"${sexText}" isn't a sex Tohyee knows (F, M or castrated).`;
    else if (birthText && !birthOn) error = `"${birthText}" isn't a date.`;
    else if (birthOn && birthOn > todayIsoDate()) error = "The birth date is in the future.";
    else if (mobText && !mob) error = `No mob called "${mobText}" on this farm.`;
    else if (mob && mob.kind !== kind) error = `${mobName(mob)} is ${KIND_NAMES[mob.kind].toLowerCase()}.`;
    else if (tags.has(`${kind}:${tagKey(tag)}`)) error = `Tag ${tag} is already on the register (or twice in the file).`;
    else if (eid && eids.has(tagKey(eid))) error = `EID ${eid} is already on the register (or twice in the file).`;
    else if (mob && (room.get(mob.id) ?? 0) < 1) error = `${mobName(mob)} has no untagged head left. Tagging doesn't change its head: record more head on the mob first.`;
    if (!error) {
      tags.add(`${kind}:${tagKey(tag!)}`);
      if (eid) eids.add(tagKey(eid));
      if (mob) room.set(mob.id, (room.get(mob.id) ?? 0) - 1);
    }
    const damFound = dam ? allTags.has(tagKey(dam)) || fileTags.has(tagKey(dam)) : false;
    return { line, tag, eid, kind, sex, breed: cell(c.breed).slice(0, 60) || null, birthOn, dam, damFound, mobId: mob?.id ?? null, mobName: mob ? mobName(mob) : mobText || null, error, sire: cell(c.sire).slice(0, 60) || null };
  });
  return { ...file, rows, alreadyImportedOn: await earlier(tx, farmId, "animals", file.sha256) };
}

export async function previewAnimalImport(tx: OrgTx, farmIdInput: unknown, input: ImportInput & { kind?: unknown }): Promise<AnimalImportPreview> {
  const farmId = await requireFarmId(tx, farmIdInput);
  const read = await readAnimals(tx, farmId, input, input.kind);
  const errors = read.rows.filter((row) => row.error).length;
  return {
    fileName: read.fileName,
    rows: read.rows.map((row) => ({ line: row.line, tag: row.tag, eid: row.eid, kind: row.kind, sex: row.sex, breed: row.breed, birthOn: row.birthOn, dam: row.dam, damFound: row.damFound, mobId: row.mobId, mobName: row.mobName, error: row.error })),
    counts: { animals: read.rows.length - errors, errors, damsTyped: read.rows.filter((row) => !row.error && row.dam && !row.damFound).length },
    alreadyImportedOn: read.alreadyImportedOn,
  };
}

/** Imports animals (AN9): each tagged into its mob from the import day (no head changes); dams by tag where they match. */
export async function importAnimals(tx: OrgTx, farmIdInput: unknown, input: ImportInput & { kind?: unknown; onDate?: unknown }): Promise<{ imported: number; skipped: number }> {
  const farmId = await requireFarmId(tx, farmIdInput);
  await tx.query("select 1 from farms where id = $1 for update", [farmId]);
  const read = await readAnimals(tx, farmId, input, input.kind);
  if (read.alreadyImportedOn) throw new ConflictError(`This file was already imported on ${read.alreadyImportedOn.slice(0, 10)}.`);
  const good = read.rows.filter((row) => !row.error);
  if (!good.length) throw new ValidationError("There are no animals without errors to import.");
  const onDate = todayIsoDate();
  const source = importSource(read.fileName).slice(0, 500);
  const made = new Map<string, string>();
  for (const row of good) {
    const inserted = await tx.query<{ id: string }>(
      "insert into animals (farm_id, kind, tag, eid, sex, breed, birth_on, sire_text, note, created_by_email) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id::text",
      [farmId, row.kind, row.tag, row.eid, row.sex, row.breed, row.birthOn, row.sire, source.slice(0, 500), tx.actor.email],
    );
    made.set(`${row.kind}:${tagKey(row.tag!)}`, inserted.rows[0].id);
    if (row.mobId) await animalsIn(tx, { animalIds: [inserted.rows[0].id], mobId: row.mobId, onDate, how: "tagged", eventId: null });
  }
  // Dams: a tag on the register or in the file links; otherwise it's kept as typed.
  for (const row of good) {
    if (!row.dam) continue;
    const id = made.get(`${row.kind}:${tagKey(row.tag!)}`)!;
    const dam = made.get(`${row.kind}:${tagKey(row.dam)}`) ?? (await tx.query<{ id: string }>("select id::text from animals where farm_id = $1 and kind = $2 and replace(lower(tag), ' ', '') = $3 and id <> $4 order by animals.status in ('on_farm', 'missing') desc, animals.id desc limit 1", [farmId, row.kind, tagKey(row.dam), id])).rows[0]?.id;
    await tx.query("update animals set dam_id = $2, dam_text = $3 where id = $1", [id, dam ?? null, dam ? null : row.dam]);
  }
  const summary = { imported: good.length, skipped: read.rows.length - good.length };
  await tx.query("insert into farm_imports (farm_id, kind, file_name, sha256, summary, created_by_email) values ($1, 'animals', $2, $3, $4::jsonb, $5)", [farmId, read.fileName, read.sha256, JSON.stringify(summary), tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "farming.animals_imported", entityType: "farm", entityId: farmId, details: { fileName: read.fileName, ...summary } });
  return summary;
}

// Scores and weights ---------------------------------------------------------------------------------

export type RecordImportRow = { line: number; tag: string | null; animalId: string | null; date: string | null; score: string | null; kg: string | null; error: string | null };
export type RecordImportPreview = { fileName: string; rows: RecordImportRow[]; counts: { scores: number; weights: number; errors: number }; unmatched: string[]; alreadyImportedOn: string | null };

async function readRecords(tx: OrgTx, farmId: string, input: ImportInput) {
  const file = await readTable(input, "score or weight");
  const c = {
    tag: file.find(isTag, (h) => h.includes("tag") && !isEid(h)),
    eid: file.find(isEid),
    date: file.find((h) => h === "date" || h.includes("date") || h === "scored" || h === "weighed"),
    score: file.find((h) => h === "bcs" || h === "score" || h.includes("condition") || h.includes("bcs")),
    kg: file.find((h) => h === "kg" || h === "weight" || h.includes("weight") || h.includes("liveweight") || h.endsWith(" kg")),
  };
  if (c.tag === null && c.eid === null) throw new ValidationError("The file needs a tag or EID column.");
  if (c.score === null && c.kg === null) throw new ValidationError("The file needs a BCS (score) or weight column.");
  const animals = await tx.query<{ id: string; kind: string; tag: string; eid: string | null }>("select id::text, kind, tag, eid from animals where farm_id = $1 and status in ('on_farm', 'missing')", [farmId]);
  const byTag = new Map<string, Array<{ id: string; kind: string }>>();
  const byEid = new Map<string, { id: string; kind: string }>();
  for (const animal of animals.rows) {
    byTag.set(tagKey(animal.tag), [...(byTag.get(tagKey(animal.tag)) ?? []), { id: animal.id, kind: animal.kind }]);
    if (animal.eid) byEid.set(tagKey(animal.eid), { id: animal.id, kind: animal.kind });
  }
  const scales = new Map<string, BcsScale>();
  for (const kind of new Set(animals.rows.map((row) => row.kind))) scales.set(kind, await scaleFor(tx, farmId, kind));
  const unmatched = new Set<string>();
  const rows: RecordImportRow[] = file.body.map(({ cells, line }) => {
    const cell = (index: number | null) => (index === null ? "" : (cells[index] ?? "").trim());
    const tag = cell(c.tag) || null;
    const eid = cell(c.eid) || null;
    const matches = eid && byEid.has(tagKey(eid)) ? [byEid.get(tagKey(eid))!] : tag ? (byTag.get(tagKey(tag)) ?? []) : [];
    const dateText = cell(c.date);
    const date = dateText ? parseBankDate(dateText) : null;
    const scoreText = cell(c.score);
    const kgText = cell(c.kg).replace(/\s*kg$/i, "").replace(/,/g, "");
    let score: string | null = null;
    let kg: string | null = null;
    let error: string | null = null;
    if (!tag && !eid) error = "No tag or EID.";
    else if (!matches.length) {
      error = `${tag ?? eid} isn't on the register. Add the animal first; nothing was added.`;
      unmatched.add(tag ?? eid!);
    } else if (matches.length > 1) error = `Tag ${tag} is on more than one kind of stock. Use the EID.`;
    else if (!dateText) error = "No date.";
    else if (!date) error = `"${dateText}" isn't a date.`;
    else if (date > todayIsoDate()) error = "The date is in the future.";
    else if (!scoreText && !kgText) error = "No score or weight.";
    if (!error && scoreText) {
      try {
        score = parseScore(scoreText, scales.get(matches[0].kind)!);
      } catch (caught) {
        error = (caught as Error).message;
      }
    }
    if (!error && kgText) {
      if (!/^\d{1,4}(\.\d{1,2})?$/.test(kgText) || cmp(dec(kgText), ZERO_DECIMAL) <= 0 || cmp(dec(kgText), dec("2000")) > 0) error = `"${cell(c.kg)}" isn't a weight in kg.`;
      else kg = toFixedString(dec(kgText), 1);
    }
    return { line, tag: tag ?? eid, animalId: matches.length === 1 ? matches[0].id : null, date, score, kg, error };
  });
  return { ...file, rows, unmatched: [...unmatched], alreadyImportedOn: await earlier(tx, farmId, "animal_records", file.sha256) };
}

export async function previewRecordImport(tx: OrgTx, farmIdInput: unknown, input: ImportInput): Promise<RecordImportPreview> {
  const farmId = await requireFarmId(tx, farmIdInput);
  const read = await readRecords(tx, farmId, input);
  const good = read.rows.filter((row) => !row.error);
  return {
    fileName: read.fileName,
    rows: read.rows,
    counts: { scores: good.filter((row) => row.score).length, weights: good.filter((row) => row.kg).length, errors: read.rows.length - good.length },
    unmatched: read.unmatched,
    alreadyImportedOn: read.alreadyImportedOn,
  };
}

/** Imports scores and weights by tag and date (BCS6): matched tags only; unmatched ones are listed and skipped. */
export async function importRecords(tx: OrgTx, farmIdInput: unknown, input: ImportInput): Promise<{ scores: number; weights: number; skipped: number }> {
  const farmId = await requireFarmId(tx, farmIdInput);
  await tx.query("select 1 from farms where id = $1 for update", [farmId]);
  const read = await readRecords(tx, farmId, input);
  if (read.alreadyImportedOn) throw new ConflictError(`This file was already imported on ${read.alreadyImportedOn.slice(0, 10)}.`);
  const good = read.rows.filter((row) => !row.error);
  if (!good.length) throw new ValidationError("There are no rows without errors to import.");
  const note = importSource(read.fileName).slice(0, 200);
  let scores = 0;
  let weights = 0;
  for (const row of good) {
    if (row.score) {
      const kind = (await tx.query<{ kind: string }>("select kind from animals where id = $1", [row.animalId])).rows[0].kind;
      await tx.query("insert into bcs_records (farm_id, animal_id, scored_on, scale, score, source, note, created_by_email) values ($1, $2, $3, $4, $5::numeric, 'import', $6, $7)", [farmId, row.animalId, row.date, await scaleFor(tx, farmId, kind), row.score, note, tx.actor.email]);
      scores += 1;
    }
    if (row.kg) {
      await tx.query("insert into animal_weights (farm_id, animal_id, weighed_on, kg, source, note, created_by_email) values ($1, $2, $3, $4::numeric, 'import', $5, $6)", [farmId, row.animalId, row.date, row.kg, note, tx.actor.email]);
      weights += 1;
    }
  }
  const summary = { scores, weights, skipped: read.rows.length - good.length };
  await tx.query("insert into farm_imports (farm_id, kind, file_name, sha256, summary, created_by_email) values ($1, 'animal_records', $2, $3, $4::jsonb, $5)", [farmId, read.fileName, read.sha256, JSON.stringify(summary), tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "farming.animal_records_imported", entityType: "farm", entityId: farmId, details: { fileName: read.fileName, ...summary } });
  return summary;
}
