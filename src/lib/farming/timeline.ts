import { writeAuditEvent } from "@/lib/audit";
import { roleAtLeast } from "@/lib/auth/roles";
import { parseBankDate } from "@/lib/bank/formats/common";
import { isoDateAt, parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { requireFarmAccess } from "@/lib/farming/access";
import { isTermKey } from "@/lib/farming/farm-terms";
import { MOB_EVENT_LABELS, type MobEventType, mobName, paddockLabel } from "@/lib/farming/mob-rules";
import { requireFarming } from "@/lib/farming/paddocks";
import { BREEDING_LABELS, type BreedingType, inCalfPercent, scanningPercent } from "@/lib/farming/planning-rules";
import { fileRows, importSource } from "@/lib/farming/soil";
import { meatSafeOn, milkBasisText, milkSafeFrom, safeText } from "@/lib/farming/treatment-rules";
import { className } from "@/lib/livestock/classes";
import { asRecord, optionalId, requireArray, requireString } from "@/lib/validation";

/*
 * The farm's timeline, grazing history imports and farm words (decisions
 * 1445-1450; examples TL1-TL5, common NZ practice, not yet reviewed).
 */

async function requireFarmId(tx: OrgTx, input: unknown): Promise<string> {
  await requireFarming(tx);
  const farmId = optionalId(input, "farmId");
  if (!farmId) throw new ValidationError("Choose a farm.");
  const farm = await tx.query("select 1 from farms where id = $1", [farmId]);
  if (!farm.rowCount) throw new NotFoundError("Farm not found.");
  await requireFarmAccess(tx, farmId);
  return farmId;
}

export const TIMELINE_KINDS = ["mob", "grazing", "treatment", "breeding", "spray"] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export type TimelineItem = {
  key: string;
  date: string;
  kind: TimelineKind;
  /** Mob events: which; others are their kind. */
  what: MobEventType | BreedingType | "treatment" | "spray" | "grazing_in" | "grazing_out";
  title: string;
  detail: string | null;
  mobId: string | null;
  mobName: string | null;
  paddockIds: string[];
  paddockNames: string[];
  /** A sale, purchase, death, birth or class change counted in the books' livestock head count. */
  inHeadCount: boolean;
};

/**
 * Everything that happened on the farm, newest first (TL1-TL2): mob events
 * (added, moved, split, merged, sold, died, born, bought, class changes,
 * weights, counts), grazings typed without a mob record, treatments,
 * breeding records and spray jobs (with their withholding). Filter by mob
 * or paddock and dates; at most `limit` (500 by default, 2,000 at most).
 */
export async function farmTimeline(tx: OrgTx, input: { farmId: unknown; mobId?: unknown; paddockId?: unknown; from?: unknown; to?: unknown; kinds?: unknown; limit?: unknown }): Promise<{ items: TimelineItem[]; more: boolean }> {
  const farmId = await requireFarmId(tx, input.farmId);
  const mobId = optionalId(input.mobId, "mobId");
  const paddockId = optionalId(input.paddockId, "paddockId");
  const from = input.from ? parseIsoDate(input.from, "From") : "1900-01-01";
  const to = input.to ? parseIsoDate(input.to, "To") : "2999-12-31";
  const limit = Math.min(2000, Math.max(1, Number(input.limit) || 500));
  const kinds = typeof input.kinds === "string" && input.kinds ? input.kinds.split(",") : Array.isArray(input.kinds) ? input.kinds.map(String) : [...TIMELINE_KINDS];
  for (const kind of kinds) if (!(TIMELINE_KINDS as readonly string[]).includes(kind)) throw new ValidationError(`"${kind}" isn't something the timeline shows.`);
  if (mobId) {
    const mob = await tx.query("select 1 from mobs where id = $1 and farm_id = $2", [mobId, farmId]);
    if (!mob.rowCount) throw new NotFoundError("Mob not found on this farm.");
  }
  const names = new Map((await tx.query<{ id: string; name: string }>("select id::text, name from paddocks where farm_id = $1", [farmId])).rows.map((row) => [row.id, row.name]));
  const items: TimelineItem[] = [];
  const window = [farmId, from, to, limit + 1];

  if (kinds.includes("mob")) {
    const rows = await tx.query<{
      id: string;
      mob_id: string;
      name: string | null;
      kind: string;
      class_code: string;
      event_type: MobEventType;
      event_date: string;
      head_change: number;
      head_after: number;
      from_paddock_id: string | null;
      to_paddock_id: string | null;
      to_class_code: string | null;
      from_class_code: string | null;
      other_name: string | null;
      other_kind: string | null;
      other_class: string | null;
      average_kg: string | null;
      amount: string | null;
      movement: boolean;
      note: string | null;
    }>(
      `select e.id::text, e.mob_id::text, m.name, m.kind, m.class_code, e.event_type, e.event_date::text, e.head_change, e.head_after,
              e.from_paddock_id::text, e.to_paddock_id::text, e.to_class_code, e.from_class_code, o.name as other_name, o.kind as other_kind, o.class_code as other_class,
              e.average_kg::text, e.amount::text, e.livestock_movement_id is not null as movement, e.note
         from mob_events e join mobs m on m.id = e.mob_id left join mobs o on o.id = e.other_mob_id
        where e.farm_id = $1 and e.event_date between $2 and $3
          and ($5::bigint is null or e.mob_id = $5)
          and ($6::bigint is null or e.from_paddock_id = $6 or e.to_paddock_id = $6)
        order by e.event_date desc, e.id desc limit $4`,
      [...window, mobId, paddockId],
    );
    for (const row of rows.rows) {
      const name = mobName({ name: row.name, kind: row.kind, classCode: row.class_code });
      const paddocks = [row.from_paddock_id, row.to_paddock_id].filter((id): id is string => Boolean(id));
      const other = row.other_kind ? mobName({ name: row.other_name, kind: row.other_kind, classCode: row.other_class ?? "" }) : null;
      const label = MOB_EVENT_LABELS[row.event_type];
      let title = `${name}: ${label.toLowerCase()}`;
      if (row.event_type === "moved") title = row.to_paddock_id ? `${name} moved to ${paddockLabel(names.get(row.to_paddock_id) ?? "")}` : `${name} out of ${paddockLabel(names.get(row.from_paddock_id ?? "") ?? "")}`;
      else if (row.event_type === "weighed") title = `${name} weighed: ${row.average_kg} kg average`;
      else if (row.event_type === "reclass") title = `${name}: ${className(row.kind, row.from_class_code ?? "")} to ${className(row.kind, row.to_class_code ?? "")}`;
      else if (row.event_type === "created") title = `${name} added: ${row.head_after} head${row.to_paddock_id ? ` in ${paddockLabel(names.get(row.to_paddock_id) ?? "")}` : ""}`;
      else if (["sold", "died", "born", "bought"].includes(row.event_type)) title = `${name}: ${Math.abs(row.head_change)} ${label.toLowerCase()}`;
      else if (other) title = `${name}: ${label.toLowerCase()} ${other} (${Math.abs(row.head_change)} head)`;
      items.push({
        key: `e${row.id}`,
        date: row.event_date,
        kind: "mob",
        what: row.event_type,
        title,
        detail: [row.amount ? `$${row.amount} excl. GST` : null, `${row.head_after} head after`, row.note].filter(Boolean).join(" · ") || null,
        mobId: row.mob_id,
        mobName: name,
        paddockIds: paddocks,
        paddockNames: paddocks.map((id) => names.get(id) ?? ""),
        inHeadCount: row.movement,
      });
    }
  }

  if (kinds.includes("grazing") && !mobId) {
    // Grazings typed with only a mob name; a mob record's grazings are its moves above.
    const rows = await tx.query<{ id: string; paddock_id: string; mob: string; head: number | null; in_on: string; out_on: string | null }>(
      `select g.id::text, g.paddock_id::text, g.mob, g.head, g.in_on::text, g.out_on::text from grazings g
        where g.farm_id = $1 and g.status = 'active' and g.mob_id is null and (g.in_on between $2 and $3 or g.out_on between $2 and $3)
          and ($5::bigint is null or g.paddock_id = $5)
        order by g.in_on desc, g.id desc limit $4`,
      [...window, paddockId],
    );
    for (const row of rows.rows) {
      const paddock = names.get(row.paddock_id) ?? "";
      const base = { kind: "grazing" as const, mobId: null, mobName: row.mob, paddockIds: [row.paddock_id], paddockNames: [paddock], inHeadCount: false, detail: row.head ? `${row.head} head` : null };
      if (row.in_on >= from && row.in_on <= to) items.push({ ...base, key: `gi${row.id}`, date: row.in_on, what: "grazing_in", title: `${row.mob} into ${paddockLabel(paddock)}` });
      if (row.out_on && row.out_on >= from && row.out_on <= to) items.push({ ...base, key: `go${row.id}`, date: row.out_on, what: "grazing_out", title: `${row.mob} out of ${paddockLabel(paddock)}` });
    }
  }

  if (kinds.includes("treatment")) {
    const rows = await tx.query<{ id: string; mob_id: string | null; name: string | null; kind: string | null; class_code: string | null; animals: string | null; head: number; treated_on: string; given_time: string | null; product: string; dose: string; meat: number | null; milk: number | null; paddock_id: string | null }>(
      `select t.id::text, t.mob_id::text, m.name, m.kind, m.class_code, t.animals, t.head, t.treated_on::text, to_char(t.given_time, 'HH24:MI') as given_time, t.product, t.dose,
              t.meat_withholding_days as meat, t.milk_withholding_hours as milk,
              (select g.paddock_id::text from grazings g where g.mob_id = t.mob_id and g.status = 'active' and g.in_on <= t.treated_on and (g.out_on is null or g.out_on >= t.treated_on) order by g.in_on desc limit 1) as paddock_id
         from animal_treatments t left join mobs m on m.id = t.mob_id
        where t.farm_id = $1 and t.status = 'active' and t.treated_on between $2 and $3 and ($5::bigint is null or t.mob_id = $5)
        order by t.treated_on desc, t.id desc limit $4`,
      [...window, mobId],
    );
    for (const row of rows.rows) {
      if (paddockId && row.paddock_id !== paddockId) continue;
      const name = row.mob_id ? mobName({ name: row.name, kind: row.kind ?? "", classCode: row.class_code ?? "" }) : null;
      const meat = meatSafeOn(row.treated_on, row.meat);
      const milk = milkSafeFrom(row.treated_on, row.milk, row.given_time);
      items.push({
        key: `t${row.id}`,
        date: row.treated_on,
        kind: "treatment",
        what: "treatment",
        title: `${name ?? row.animals}: treated with ${row.product}`,
        detail: [`${row.head} head, ${row.dose}`, meat ? `safe for slaughter from ${meat}` : null, milk ? `milk safe from ${safeText(milk)} (${milkBasisText(row.given_time)})` : null].filter(Boolean).join(" · "),
        mobId: row.mob_id,
        mobName: name,
        paddockIds: row.paddock_id ? [row.paddock_id] : [],
        paddockNames: row.paddock_id ? [names.get(row.paddock_id) ?? ""] : [],
        inHeadCount: false,
      });
    }
  }

  if (kinds.includes("breeding") && !paddockId) {
    const rows = await tx.query<{ id: string; mob_id: string; name: string | null; kind: string; class_code: string; record_type: BreedingType; on_date: string; head: number; sire: string | null; singles: number | null; twins: number | null; triplets: number | null; in_calf: number | null }>(
      `select b.id::text, b.mob_id::text, m.name, m.kind, m.class_code, b.record_type, b.on_date::text, b.head, b.sire, b.singles, b.twins, b.triplets, b.in_calf
         from mob_breeding b join mobs m on m.id = b.mob_id
        where b.farm_id = $1 and b.status = 'active' and b.on_date between $2 and $3 and ($5::bigint is null or b.mob_id = $5)
        order by b.on_date desc, b.id desc limit $4`,
      [...window, mobId],
    );
    for (const row of rows.rows) {
      const name = mobName({ name: row.name, kind: row.kind, classCode: row.class_code });
      const result =
        row.record_type === "scanning"
          ? `${scanningPercent({ head: row.head, singles: row.singles ?? 0, twins: row.twins ?? 0, triplets: row.triplets ?? 0 })}% scanned`
          : row.record_type === "pregnancy_test"
            ? `${inCalfPercent(row.head, row.in_calf ?? 0)}% in calf`
            : `${row.head} head${row.sire ? `, ${row.sire}` : ""}`;
      items.push({ key: `b${row.id}`, date: row.on_date, kind: "breeding", what: row.record_type, title: `${name}: ${BREEDING_LABELS[row.record_type].toLowerCase()}`, detail: result, mobId: row.mob_id, mobName: name, paddockIds: [], paddockNames: [], inHeadCount: false });
    }
  }

  if (kinds.includes("spray") && !mobId) {
    const rows = await tx.query<{ id: string; finished_at: Date; paddock_ids: string[]; product: string | null; days: number | null }>(
      `select j.id::text, j.finished_at, j.paddock_ids::text[] as paddock_ids, j.product,
              (select w.days from paddock_withholdings w where w.tractor_job_id = j.id and w.status = 'active') as days
         from tractor_jobs j
        where j.farm_id = $1 and j.status = 'active' and j.operation = 'spraying' and ($3::bigint is null or $3 = any(j.paddock_ids))
        order by j.finished_at desc limit $2`,
      [farmId, limit + 1, paddockId],
    );
    for (const row of rows.rows) {
      const date = isoDateAt(new Date(row.finished_at));
      if (date < from || date > to) continue;
      const paddockNames = row.paddock_ids.map((id) => names.get(id) ?? "");
      items.push({
        key: `s${row.id}`,
        date,
        kind: "spray",
        what: "spray",
        title: `Sprayed ${paddockNames.map(paddockLabel).join(", ") || "paddocks"}${row.product ? ` with ${row.product}` : ""}`,
        detail: row.days === null ? null : `not safe to graze for ${row.days} days`,
        mobId: null,
        mobName: null,
        paddockIds: row.paddock_ids,
        paddockNames,
        inHeadCount: false,
      });
    }
  }

  items.sort((a, b) => (a.date !== b.date ? b.date.localeCompare(a.date) : a.key.localeCompare(b.key)));
  return { items: items.slice(0, limit), more: items.length > limit };
}

// Grazing history import ---------------------------------------------------------------------------

export type GrazingImportRow = {
  line: number;
  mob: string;
  mobId: string | null;
  paddockId: string | null;
  paddockName: string;
  head: number | null;
  inOn: string | null;
  outOn: string | null;
  error: string | null;
};

type ImportInput = { fileName: unknown; content?: unknown; contentBase64?: unknown };
const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Reads a grazing (paddock move) history file (TL3): a row per grazing,
 * with mob, paddock, day in and day out, and optionally head. A mob named
 * like a mob record becomes that mob's; others stay typed. Every row needs
 * a day out: it's history. A row that overlaps the mob's own grazings, or
 * another in the same file, is refused.
 */
async function readGrazingImport(tx: OrgTx, farmId: string, input: ImportInput) {
  const fileName = requireString(input.fileName, "File name", { maxLength: 200 });
  const { rows: table, sha256 } = await fileRows(fileName, input);
  const start = table.findIndex((cells) => cells.filter((cell) => cell.trim()).length >= 2);
  if (start < 0 || table.length < start + 2) throw new ValidationError("The file needs a heading row and at least one grazing.");
  if (table.length - start - 1 > 5000) throw new ValidationError("The file has more than 5,000 grazings.");
  const headings = table[start].map((cell) => norm(cell));
  const find = (...tests: Array<(heading: string) => boolean>) => {
    for (const test of tests) {
      const index = headings.findIndex(test);
      if (index >= 0) return index;
    }
    return null;
  };
  const columns = {
    mob: find((h) => h === "mob" || h === "mob name" || h === "group"),
    paddock: find((h) => h === "paddock" || h.startsWith("paddock")),
    inOn: find((h) => h === "in" || h === "day in" || h === "date in" || h === "in date" || h.startsWith("in ") || h === "from"),
    outOn: find((h) => h === "out" || h === "day out" || h === "date out" || h === "out date" || h.startsWith("out ") || h === "to"),
    head: find((h) => h === "head" || h === "number" || h.includes("head")),
  };
  if (columns.mob === null || columns.paddock === null || columns.inOn === null || columns.outOn === null) throw new ValidationError("The file needs mob, paddock, day in and day out columns.");
  const paddocks = await tx.query<{ id: string; name: string }>("select id::text, name from paddocks where farm_id = $1", [farmId]);
  const mobs = await tx.query<{ id: string; name: string }>("select id::text, name from mobs where farm_id = $1 and name is not null", [farmId]);
  const existing = await tx.query<{ mob_id: string | null; paddock_id: string; in_on: string; out_on: string | null }>(
    "select mob_id::text, paddock_id::text, in_on::text, out_on::text from grazings where farm_id = $1 and status = 'active'",
    [farmId],
  );
  const earlier = await tx.query<{ created_at: string }>("select created_at::text from farm_imports where farm_id = $1 and kind = 'grazings' and sha256 = $2", [farmId, sha256]);
  const accepted: Array<{ mobId: string | null; paddockId: string; inOn: string; outOn: string }> = [];
  const overlaps = (a: { inOn: string; outOn: string | null }, b: { inOn: string; outOn: string | null }) => a.inOn < (b.outOn ?? "9999-12-31") && b.inOn < (a.outOn ?? "9999-12-31");
  const rows: GrazingImportRow[] = table
    .slice(start + 1)
    .map((cells, offset) => ({ cells, line: start + offset + 2 }))
    .filter(({ cells }) => cells.some((cell) => cell.trim()))
    .map(({ cells, line }) => {
      const cell = (index: number | null) => (index === null ? "" : (cells[index] ?? "").trim());
      const mob = cell(columns.mob).slice(0, 100);
      const record = mobs.rows.find((row) => row.name.toLowerCase() === mob.toLowerCase()) ?? null;
      const paddockName = cell(columns.paddock);
      const paddock = paddocks.rows.find((row) => row.name.toLowerCase() === paddockName.toLowerCase()) ?? null;
      const inText = cell(columns.inOn);
      const outText = cell(columns.outOn);
      const inOn = inText ? parseBankDate(inText) : null;
      const outOn = outText ? parseBankDate(outText) : null;
      const headText = cell(columns.head).replace(/,/g, "");
      const head = /^\d{1,6}$/.test(headText) && Number(headText) >= 1 && Number(headText) <= 100000 ? Number(headText) : null;
      let error: string | null = null;
      if (!mob) error = "No mob.";
      else if (!paddock) error = paddockName ? `No paddock called "${paddockName}" on this farm.` : "No paddock.";
      else if (!inOn) error = inText ? `"${inText}" isn't a date.` : "No day in.";
      else if (!outOn) error = outText ? `"${outText}" isn't a date.` : "No day out: an import is history, so each grazing needs its day out.";
      else if (outOn < inOn) error = "The day out is before the day in.";
      else if (headText && head === null) error = `"${headText}" isn't a whole number of head.`;
      else if (record) {
        // A mob is in one paddock at a time (decision 1422).
        const clash = [...existing.rows.filter((row) => row.mob_id === record.id).map((row) => ({ inOn: row.in_on, outOn: row.out_on })), ...accepted.filter((row) => row.mobId === record.id)].some((row) => overlaps(row, { inOn, outOn }));
        if (clash) error = `${record.name} is somewhere else between those days.`;
      } else {
        // Typed grazings keep the paddock to themselves (decision 1422).
        const clash = [...existing.rows.filter((row) => row.paddock_id === paddock.id).map((row) => ({ inOn: row.in_on, outOn: row.out_on })), ...accepted.filter((row) => row.paddockId === paddock.id)].some((row) => overlaps(row, { inOn, outOn }));
        if (clash) error = `${paddock.name} already has a grazing between those days.`;
      }
      if (!error) accepted.push({ mobId: record?.id ?? null, paddockId: paddock!.id, inOn: inOn!, outOn: outOn! });
      return { line, mob, mobId: record?.id ?? null, paddockId: paddock?.id ?? null, paddockName, head, inOn, outOn, error };
    });
  return { fileName, sha256, rows, alreadyImportedOn: earlier.rows[0]?.created_at ?? null };
}

export type GrazingImportPreview = { fileName: string; rows: GrazingImportRow[]; counts: { grazings: number; mobRecords: number; errors: number }; alreadyImportedOn: string | null };

export async function previewGrazingImport(tx: OrgTx, farmIdInput: unknown, input: ImportInput): Promise<GrazingImportPreview> {
  const farmId = await requireFarmId(tx, farmIdInput);
  const read = await readGrazingImport(tx, farmId, input);
  const good = read.rows.filter((row) => !row.error);
  return { fileName: read.fileName, rows: read.rows, counts: { grazings: good.length, mobRecords: good.filter((row) => row.mobId).length, errors: read.rows.length - good.length }, alreadyImportedOn: read.alreadyImportedOn };
}

/**
 * Imports grazing history (TL3): each row a grazing. A mob record's rows
 * become its moves on the timeline (a "moved" event on the day in);
 * nothing changes a head count (TL4).
 */
export async function importGrazings(tx: OrgTx, farmIdInput: unknown, input: ImportInput): Promise<{ imported: number; skipped: number }> {
  const farmId = await requireFarmId(tx, farmIdInput);
  await tx.query("select 1 from farms where id = $1 for update", [farmId]);
  const read = await readGrazingImport(tx, farmId, input);
  if (read.alreadyImportedOn) throw new ConflictError(`This file was already imported on ${read.alreadyImportedOn.slice(0, 10)}.`);
  const good = read.rows.filter((row) => !row.error);
  if (!good.length) throw new ValidationError("There are no grazings without errors to import.");
  const note = importSource(read.fileName).slice(0, 200);
  for (const row of good) {
    const made = await tx.query<{ id: string }>("insert into grazings (farm_id, paddock_id, mob, head, in_on, out_on, mob_id, note, created_by_email) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id::text", [
      farmId,
      row.paddockId,
      row.mob,
      row.head,
      row.inOn,
      row.outOn,
      row.mobId,
      note,
      tx.actor.email,
    ]);
    if (row.mobId) {
      const mob = await tx.query<{ head: number }>("select head from mobs where id = $1", [row.mobId]);
      await tx.query(
        "insert into mob_events (mob_id, farm_id, event_type, event_date, head_after, to_paddock_id, grazing_id, note, created_by_email) values ($1, $2, 'moved', $3, $4, $5, $6, $7, $8)",
        [row.mobId, farmId, row.inOn, row.head ?? mob.rows[0].head, row.paddockId, made.rows[0].id, note.slice(0, 500), tx.actor.email],
      );
    }
  }
  const summary = { imported: good.length, skipped: read.rows.length - good.length };
  await tx.query("insert into farm_imports (farm_id, kind, file_name, sha256, summary, created_by_email) values ($1, 'grazings', $2, $3, $4::jsonb, $5)", [farmId, read.fileName, read.sha256, JSON.stringify(summary), tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "farming.grazings_imported", entityType: "farm", entityId: farmId, details: { fileName: read.fileName, ...summary } });
  return summary;
}

// Farm words ---------------------------------------------------------------------------------------

export async function getFarmTerms(tx: OrgTx): Promise<Record<string, string>> {
  await requireFarming(tx);
  const rows = await tx.query<{ term_key: string; label: string }>("select term_key, label from farm_terms order by term_key");
  return Object.fromEntries(rows.rows.map((row) => [row.term_key, row.label]));
}

/** Sets farm words (TL5; admins): a blank label goes back to Tohyee's word. Display only. */
export async function setFarmTerms(tx: OrgTx, input: { terms: unknown }): Promise<Record<string, string>> {
  await requireFarming(tx);
  const role = tx.actor.role;
  if (role && !roleAtLeast(role, "admin")) throw new ForbiddenError("Changing farm words needs the admin role.");
  for (const raw of requireArray(input.terms, "terms", 300)) {
    const entry = asRecord(raw, "A word");
    const key = typeof entry.key === "string" ? entry.key : "";
    if (!isTermKey(key)) throw new ValidationError(`"${key}" isn't a word that can be renamed.`);
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    if (!label) {
      await tx.query("delete from farm_terms where term_key = $1", [key]);
      continue;
    }
    if (label.length > 60) throw new ValidationError("A word is at most 60 characters.");
    await tx.query(
      "insert into farm_terms (term_key, label, updated_by_email) values ($1, $2, $3) on conflict (term_key) do update set label = excluded.label, updated_by_email = excluded.updated_by_email, updated_at = now()",
      [key, label, tx.actor.email],
    );
  }
  await writeAuditEvent(tx, { eventType: "farming.farm_terms_set", entityType: "farm_terms", entityId: "1", details: { terms: input.terms } });
  return getFarmTerms(tx);
}
