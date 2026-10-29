import { writeAuditEvent } from "@/lib/audit";
import { businessTimeZone, parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { requireAllFarms, requireFarmAccess, visibleFarmIds } from "./access";
import { ensureFertiliserAccounts } from "@/lib/farming/fertiliser";
import { readShapeFile, type ShapeFile } from "@/lib/farming/formats";
import { areaHectares, GeometryError, hectaresText, type PaddockGeometry, parseGeometry } from "@/lib/farming/geometry";
import { parseDecimalInput } from "@/lib/money/decimal";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { optionalString, requireArray, requireId, requireString } from "@/lib/validation";

/*
 * Farms and paddocks (#249 stage 1, decision 514). A paddock's identity
 * doesn't depend on its name: names can change, and a retired "14" can sit
 * beside a new one. Boundaries are versioned (the newest is current). A
 * split or merge retires the old paddocks and links the new ones to them,
 * so history keeps its own areas (FB7). Plans use the effective area the
 * farmer enters, not the mapped area (FB1). Nothing here posts.
 */

export type FarmingSettings = {
  enabled: boolean;
  /** The organisation's LINZ Basemaps API key for aerial imagery, or null. Browsers load the tiles with it, so it isn't secret. */
  imageryKey: string | null;
  /** The day (YYYY-MM-DD, the business's time zone) the key was saved, for the 80-day reminder (decision 1061); null with no key. */
  imageryKeySavedOn: string | null;
};

export type Farm = { id: string; name: string; notes: string | null; isActive: boolean; activePaddocks: number; effectiveHa: string; mappedHa: string };

export type Paddock = {
  id: string;
  farmId: string;
  name: string;
  effectiveHa: string | null;
  /** The current boundary's area, worked out from the shape. */
  mappedHa: string | null;
  geometry: PaddockGeometry | null;
  boundarySource: string | null;
  status: "active" | "retired";
  createdOn: string;
  retiredOn: string | null;
  /** The paddocks this one came from (a split or merge), and the ones that came from it. */
  cameFrom: Array<{ id: string; name: string; kind: "split" | "merge"; onDate: string }>;
  became: Array<{ id: string; name: string; kind: "split" | "merge"; onDate: string }>;
};

export type BoundaryVersion = { id: string; mappedHa: string; source: string; createdByEmail: string; createdAt: string; geometry: PaddockGeometry };

export type ImportPreviewRow = {
  index: number;
  name: string | null;
  mappedHa: string | null;
  effectiveHa: string | null;
  action: "new" | "new_boundary" | "unchanged" | "error";
  paddockId: string | null;
  error: string | null;
};

export type ImportPreview = {
  fileName: string;
  format: ShapeFile["format"];
  /** Anything done to the file on the way in, such as converting from NZTM2000. */
  note: string | null;
  sha256: string;
  alreadyImportedOn: string | null;
  nameProperty: string | null;
  effectiveProperty: string | null;
  properties: string[];
  rows: ImportPreviewRow[];
  counts: { new: number; newBoundary: number; unchanged: number; errors: number };
};


function geometryError(error: unknown): never {
  if (error instanceof GeometryError) throw new ValidationError(error.message);
  throw error;
}

function parseHectares(input: unknown, label: string): string | null {
  if (input === undefined || input === null || input === "") return null;
  return parseDecimalInput(input, label, { maxScale: 2 });
}

function parseName(input: unknown): string {
  return requireString(input, "Paddock name", { maxLength: 60 });
}

// Settings ------------------------------------------------------------------------------

export async function getFarmingSettings(tx: OrgTx): Promise<FarmingSettings> {
  const row = await tx.query<{ enabled: boolean; linz_basemaps_key: string | null; key_saved_on: string | null }>(
    "select enabled, linz_basemaps_key, (linz_basemaps_key_saved_at at time zone $1)::date::text as key_saved_on from farming_settings where id = true",
    [businessTimeZone()],
  );
  return { enabled: row.rows[0]?.enabled === true, imageryKey: row.rows[0]?.linz_basemaps_key ?? null, imageryKeySavedOn: row.rows[0]?.key_saved_on ?? null };
}

/**
 * Sets or clears (null or "") the LINZ Basemaps API key used for aerial
 * imagery on the paddock map. Each organisation brings its own key from
 * basemaps.linz.govt.nz and agrees to LINZ's terms; Tohyee doesn't ship one.
 */
export async function setImageryKey(tx: OrgTx, input: { imageryKey: unknown }): Promise<FarmingSettings> {
  await requireFarming(tx);
  let key: string | null = null;
  if (input.imageryKey !== null && input.imageryKey !== undefined && input.imageryKey !== "") {
    if (typeof input.imageryKey !== "string") throw new ValidationError("The LINZ Basemaps key must be text.");
    key = input.imageryKey.trim();
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new ValidationError("That doesn't look like a LINZ Basemaps API key: it should be letters, numbers, - and _ only.");
  }
  // Saving the same key again (e.g. after checking it) keeps its date; a new key starts its 90 days today.
  await tx.query(
    `update farming_settings set linz_basemaps_key = $1::text,
       linz_basemaps_key_saved_at = case when $1::text is null then null when linz_basemaps_key is not distinct from $1::text then linz_basemaps_key_saved_at else now() end,
       updated_by_email = $2, updated_at = now() where id = true`,
    [key, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: key ? "farming.imagery_key_set" : "farming.imagery_key_removed", entityType: "organisation", entityId: tx.organisationId, details: {} });
  return getFarmingSettings(tx);
}

export async function setFarmingEnabled(tx: OrgTx, input: { enabled: unknown }): Promise<FarmingSettings> {
  if (typeof input.enabled !== "boolean") throw new ValidationError("enabled must be true or false.");
  if (input.enabled && !(await getOrganisationSettings(tx)).accountingEnabled) throw new ValidationError("Farming is part of Accounting. Turn Accounting on first.");
  await tx.query("update farming_settings set enabled = $1, updated_by_email = $2, updated_at = now() where id = true", [input.enabled, tx.actor.email]);
  if (input.enabled) await ensureFertiliserAccounts(tx);
  await writeAuditEvent(tx, { eventType: input.enabled ? "farming.turned_on" : "farming.turned_off", entityType: "organisation", entityId: tx.organisationId, details: {} });
  return getFarmingSettings(tx);
}

export async function requireFarming(tx: OrgTx): Promise<void> {
  if (!(await getFarmingSettings(tx)).enabled) throw new ValidationError("Farming is off. An admin can turn it on under Settings, Modules.");
}

// Farms -----------------------------------------------------------------------------------

export async function listFarms(tx: OrgTx): Promise<Farm[]> {
  await requireFarming(tx);
  // Only the farms this person works on (decision 744).
  const visible = await visibleFarmIds(tx);
  const rows = await tx.query<{ id: string; name: string; notes: string | null; is_active: boolean; active_paddocks: number; effective_ha: string | null; mapped_ha: string | null }>(
    `select f.id::text, f.name, f.notes, f.is_active,
            (select count(*)::int from paddocks p where p.farm_id = f.id and p.status = 'active') as active_paddocks,
            (select sum(p.effective_ha)::text from paddocks p where p.farm_id = f.id and p.status = 'active') as effective_ha,
            (select sum(b.mapped_ha)::text from paddocks p
               join lateral (select mapped_ha from paddock_boundaries b where b.paddock_id = p.id order by b.id desc limit 1) b on true
              where p.farm_id = f.id and p.status = 'active') as mapped_ha
       from farms f where ($1::bigint[] is null or f.id = any($1::bigint[])) order by not f.is_active, lower(f.name), f.id`,
    [visible],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    name: row.name,
    notes: row.notes,
    isActive: row.is_active,
    activePaddocks: row.active_paddocks,
    effectiveHa: hectaresText(Number(row.effective_ha ?? 0)),
    mappedHa: hectaresText(Number(row.mapped_ha ?? 0)),
  }));
}

/** Adds a farm, or changes one (`id`). */
export async function saveFarm(tx: OrgTx, input: { id?: unknown; name: unknown; notes?: unknown; isActive?: unknown }): Promise<Farm[]> {
  await requireFarming(tx);
  const name = requireString(input.name, "Farm name", { maxLength: 100 });
  const notes = optionalString(input.notes, "Notes", { maxLength: 1000 });
  const id = input.id ? requireId(input.id, "farmId") : null;
  if (id) await requireFarmAccess(tx, id);
  else await requireAllFarms(tx, "Adding a farm");
  const clash = await tx.query("select 1 from farms where lower(name) = lower($1) and ($2::bigint is null or id <> $2)", [name, id]);
  if (clash.rowCount) throw new ValidationError(`There's already a farm called ${name}.`);
  if (id) {
    const updated = await tx.query("update farms set name = $2, notes = $3, is_active = $4 where id = $1", [id, name, notes, input.isActive === undefined ? true : input.isActive === true]);
    if (!updated.rowCount) throw new NotFoundError("Farm not found.");
    await writeAuditEvent(tx, { eventType: "farming.farm_changed", entityType: "farm", entityId: id, details: { name } });
  } else {
    const row = await tx.query<{ id: string }>("insert into farms (name, notes, created_by_email) values ($1, $2, $3) returning id::text", [name, notes, tx.actor.email]);
    await writeAuditEvent(tx, { eventType: "farming.farm_added", entityType: "farm", entityId: row.rows[0].id, details: { name } });
  }
  return listFarms(tx);
}

async function requireFarm(tx: OrgTx, farmIdInput: unknown): Promise<{ id: string; name: string }> {
  await requireFarming(tx);
  const id = requireId(farmIdInput, "farmId");
  const row = await tx.query<{ id: string; name: string }>("select id::text, name from farms where id = $1", [id]);
  if (!row.rows[0]) throw new NotFoundError("Farm not found.");
  await requireFarmAccess(tx, id);
  return row.rows[0];
}

/** Imports only go into a farm in use: an archived farm's map stays as it was archived. */
async function requireActiveFarm(tx: OrgTx, farmIdInput: unknown): Promise<{ id: string; name: string }> {
  const farm = await requireFarm(tx, farmIdInput);
  const active = await tx.query<{ is_active: boolean }>("select is_active from farms where id = $1", [farm.id]);
  if (!active.rows[0].is_active) throw new ValidationError(`${farm.name} is archived. Choose a farm in use to import into.`);
  return farm;
}

// Paddocks ----------------------------------------------------------------------------------

type PaddockRow = {
  id: string;
  farm_id: string;
  name: string;
  effective_ha: string | null;
  status: "active" | "retired";
  created_on: string;
  retired_on: string | null;
  mapped_ha: string | null;
  geometry: PaddockGeometry | null;
  source: string | null;
};

const PADDOCK_SELECT = `select p.id::text, p.farm_id::text, p.name, p.effective_ha::text, p.status, p.created_on::text, p.retired_on::text,
    b.mapped_ha::text, b.geometry, b.source
  from paddocks p
  left join lateral (select mapped_ha, geometry, source from paddock_boundaries b where b.paddock_id = p.id order by b.id desc limit 1) b on true`;

async function toPaddocks(tx: OrgTx, rows: PaddockRow[]): Promise<Paddock[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const lineage = await tx.query<{ paddock_id: string; from_paddock_id: string; kind: "split" | "merge"; on_date: string; paddock_name: string; from_name: string }>(
    `select l.paddock_id::text, l.from_paddock_id::text, l.kind, l.on_date::text, p.name as paddock_name, f.name as from_name
       from paddock_lineage l join paddocks p on p.id = l.paddock_id join paddocks f on f.id = l.from_paddock_id
      where l.paddock_id = any($1::bigint[]) or l.from_paddock_id = any($1::bigint[])
      order by l.on_date, lower(p.name), lower(f.name)`,
    [ids],
  );
  return rows.map((row) => ({
    id: row.id,
    farmId: row.farm_id,
    name: row.name,
    effectiveHa: row.effective_ha === null ? null : hectaresText(Number(row.effective_ha)),
    mappedHa: row.mapped_ha === null ? null : hectaresText(Number(row.mapped_ha)),
    geometry: row.geometry,
    boundarySource: row.source,
    status: row.status,
    createdOn: row.created_on,
    retiredOn: row.retired_on,
    cameFrom: lineage.rows.filter((entry) => entry.paddock_id === row.id).map((entry) => ({ id: entry.from_paddock_id, name: entry.from_name, kind: entry.kind, onDate: entry.on_date })),
    became: lineage.rows.filter((entry) => entry.from_paddock_id === row.id).map((entry) => ({ id: entry.paddock_id, name: entry.paddock_name, kind: entry.kind, onDate: entry.on_date })),
  }));
}

export async function listPaddocks(tx: OrgTx, input: { farmId: unknown; includeRetired?: unknown }): Promise<Paddock[]> {
  const farm = await requireFarm(tx, input.farmId);
  const rows = await tx.query<PaddockRow>(
    `${PADDOCK_SELECT} where p.farm_id = $1 and ($2 or p.status = 'active') order by p.status, p.id`,
    [farm.id, input.includeRetired === true || input.includeRetired === "true"],
  );
  // Current paddocks first, then by name as a farmer reads them: 1, 2, 10, 10A.
  const sorted = [...rows.rows].sort((a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name, "en-NZ", { numeric: true, sensitivity: "base" }) || Number(a.id) - Number(b.id));
  return toPaddocks(tx, sorted);
}

export async function getPaddock(tx: OrgTx, idInput: unknown): Promise<Paddock & { boundaries: BoundaryVersion[] }> {
  await requireFarming(tx);
  const id = requireId(idInput, "paddockId");
  const rows = await tx.query<PaddockRow>(`${PADDOCK_SELECT} where p.id = $1`, [id]);
  if (!rows.rows[0]) throw new NotFoundError("Paddock not found.");
  await requireFarmAccess(tx, rows.rows[0].farm_id, "Paddock not found.");
  const [paddock] = await toPaddocks(tx, rows.rows);
  const boundaries = await tx.query<{ id: string; mapped_ha: string; source: string; created_by_email: string; created_at: string; geometry: PaddockGeometry }>(
    `select id::text, mapped_ha::text, source, created_by_email, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at, geometry from paddock_boundaries where paddock_id = $1 order by paddock_boundaries.id desc`,
    [id],
  );
  return {
    ...paddock,
    boundaries: boundaries.rows.map((row) => ({ id: row.id, mappedHa: hectaresText(Number(row.mapped_ha)), source: row.source, createdByEmail: row.created_by_email, createdAt: row.created_at, geometry: row.geometry })),
  };
}

async function assertNameFree(tx: OrgTx, farmId: string, name: string, exceptId: string | null): Promise<void> {
  const clash = await tx.query("select 1 from paddocks where farm_id = $1 and status = 'active' and lower(name) = lower($2) and ($3::bigint is null or id <> $3)", [farmId, name, exceptId]);
  if (clash.rowCount) throw new ValidationError(`The farm already has a paddock called ${name}.`);
}

async function insertBoundary(tx: OrgTx, paddockId: string, geometry: PaddockGeometry, source: string): Promise<void> {
  await tx.query("insert into paddock_boundaries (paddock_id, geometry, mapped_ha, source, created_by_email) values ($1, $2::jsonb, $3, $4, $5)", [
    paddockId,
    JSON.stringify(geometry),
    areaHectares(geometry).toFixed(4),
    source,
    tx.actor.email,
  ]);
}

async function insertPaddock(tx: OrgTx, farmId: string, input: { name: string; effectiveHa: string | null; onDate: string; geometry: PaddockGeometry | null; source: string }): Promise<string> {
  await assertNameFree(tx, farmId, input.name, null);
  const row = await tx.query<{ id: string }>(
    "insert into paddocks (farm_id, name, effective_ha, created_on, created_by_email) values ($1, $2, $3, $4, $5) returning id::text",
    [farmId, input.name, input.effectiveHa, input.onDate, tx.actor.email],
  );
  if (input.geometry) await insertBoundary(tx, row.rows[0].id, input.geometry, input.source);
  return row.rows[0].id;
}

function optionalGeometry(input: unknown): PaddockGeometry | null {
  if (input === undefined || input === null || input === "") return null;
  try {
    return parseGeometry(input);
  } catch (error) {
    geometryError(error);
  }
}

/** Adds a paddock to a farm, with its effective area and, optionally, its boundary. */
export async function addPaddock(tx: OrgTx, input: { farmId: unknown; name: unknown; effectiveHa?: unknown; geometry?: unknown; onDate?: unknown }): Promise<Paddock> {
  const farm = await requireFarm(tx, input.farmId);
  const id = await insertPaddock(tx, farm.id, {
    name: parseName(input.name),
    effectiveHa: parseHectares(input.effectiveHa, "Effective area (ha)"),
    onDate: input.onDate ? parseIsoDate(input.onDate, "From") : todayIsoDate(),
    geometry: optionalGeometry(input.geometry),
    source: "Drawn or entered in Tohyee",
  });
  await writeAuditEvent(tx, { eventType: "farming.paddock_added", entityType: "paddock", entityId: id, details: { farmId: farm.id } });
  return getPaddock(tx, id);
}

async function requireActivePaddock(tx: OrgTx, idInput: unknown): Promise<PaddockRow> {
  await requireFarming(tx);
  const id = requireId(idInput, "paddockId");
  const row = await tx.query<PaddockRow>(`${PADDOCK_SELECT} where p.id = $1 for update of p`, [id]);
  if (!row.rows[0]) throw new NotFoundError("Paddock not found.");
  await requireFarmAccess(tx, row.rows[0].farm_id, "Paddock not found.");
  if (row.rows[0].status !== "active") throw new ConflictError(`${row.rows[0].name} was retired on ${row.rows[0].retired_on}.`);
  return row.rows[0];
}

/** Renames a paddock or changes its effective area. Its history keeps its identity. */
export async function updatePaddock(tx: OrgTx, idInput: unknown, input: { name?: unknown; effectiveHa?: unknown }): Promise<Paddock> {
  const paddock = await requireActivePaddock(tx, idInput);
  const name = input.name === undefined ? paddock.name : parseName(input.name);
  if (name.toLowerCase() !== paddock.name.toLowerCase()) await assertNameFree(tx, paddock.farm_id, name, paddock.id);
  const effectiveHa = input.effectiveHa === undefined ? paddock.effective_ha : parseHectares(input.effectiveHa, "Effective area (ha)");
  await tx.query("update paddocks set name = $2, effective_ha = $3 where id = $1", [paddock.id, name, effectiveHa]);
  await writeAuditEvent(tx, { eventType: "farming.paddock_changed", entityType: "paddock", entityId: paddock.id, details: { name, effectiveHa } });
  return getPaddock(tx, paddock.id);
}

/** A new boundary version; earlier ones are kept. */
export async function setBoundary(tx: OrgTx, idInput: unknown, input: { geometry: unknown; source?: unknown }): Promise<Paddock> {
  const paddock = await requireActivePaddock(tx, idInput);
  let geometry: PaddockGeometry;
  try {
    geometry = parseGeometry(input.geometry);
  } catch (error) {
    geometryError(error);
  }
  await insertBoundary(tx, paddock.id, geometry, optionalString(input.source, "Source", { maxLength: 200 }) ?? "Drawn or entered in Tohyee");
  await writeAuditEvent(tx, { eventType: "farming.boundary_changed", entityType: "paddock", entityId: paddock.id, details: {} });
  return getPaddock(tx, paddock.id);
}

type PartInput = { name: unknown; effectiveHa?: unknown; geometry?: unknown };

function parseParts(input: unknown, minimum: number): Array<{ name: string; effectiveHa: string | null; geometry: PaddockGeometry | null }> {
  const parts = requireArray(input, "parts", 50).map((raw, index) => {
    const part = (raw ?? {}) as PartInput;
    return {
      name: requireString(part.name, `Part ${index + 1} name`, { maxLength: 60 }),
      effectiveHa: parseHectares(part.effectiveHa, `Part ${index + 1} effective area (ha)`),
      geometry: optionalGeometry(part.geometry),
    };
  });
  if (parts.length < minimum) throw new ValidationError(`A split makes at least ${minimum} paddocks.`);
  const names = parts.map((part) => part.name.toLowerCase());
  if (new Set(names).size !== names.length) throw new ValidationError("Each new paddock needs its own name.");
  return parts;
}

/**
 * Splits a paddock (FB7): it's retired on the date with its history, and
 * the new paddocks start that day, linked to it. Totals don't change.
 */
export async function splitPaddock(tx: OrgTx, idInput: unknown, input: { onDate: unknown; parts: unknown }): Promise<Paddock[]> {
  const paddock = await requireActivePaddock(tx, idInput);
  const onDate = parseIsoDate(input.onDate, "Split on");
  if (onDate < paddock.created_on) throw new ValidationError(`${paddock.name} started on ${paddock.created_on}.`);
  const parts = parseParts(input.parts, 2);
  await tx.query("update paddocks set status = 'retired', retired_on = $2 where id = $1", [paddock.id, onDate]);
  const created: string[] = [];
  for (const part of parts) {
    const id = await insertPaddock(tx, paddock.farm_id, { ...part, onDate, source: `Split from ${paddock.name}` });
    await tx.query("insert into paddock_lineage (paddock_id, from_paddock_id, kind, on_date) values ($1, $2, 'split', $3)", [id, paddock.id, onDate]);
    created.push(id);
  }
  await writeAuditEvent(tx, { eventType: "farming.paddock_split", entityType: "paddock", entityId: paddock.id, details: { onDate, into: created } });
  return listPaddocks(tx, { farmId: paddock.farm_id, includeRetired: true });
}

/** Merges paddocks into one: they're retired on the date and the new one is linked to each. */
export async function mergePaddocks(tx: OrgTx, input: { paddockIds: unknown; onDate: unknown; name: unknown; effectiveHa?: unknown; geometry?: unknown }): Promise<Paddock[]> {
  const ids = [...new Set(requireArray(input.paddockIds, "paddockIds", 50).map((id) => requireId(id, "paddockId")))];
  if (ids.length < 2) throw new ValidationError("Choose at least two paddocks to merge.");
  const onDate = parseIsoDate(input.onDate, "Merge on");
  const paddocks = [];
  for (const id of ids) paddocks.push(await requireActivePaddock(tx, id));
  if (new Set(paddocks.map((paddock) => paddock.farm_id)).size > 1) throw new ValidationError("Merged paddocks must be on the same farm.");
  for (const paddock of paddocks) {
    if (onDate < paddock.created_on) throw new ValidationError(`${paddock.name} started on ${paddock.created_on}.`);
    await tx.query("update paddocks set status = 'retired', retired_on = $2 where id = $1", [paddock.id, onDate]);
  }
  const id = await insertPaddock(tx, paddocks[0].farm_id, {
    name: parseName(input.name),
    effectiveHa: parseHectares(input.effectiveHa, "Effective area (ha)"),
    onDate,
    geometry: optionalGeometry(input.geometry),
    source: `Merged from ${paddocks.map((paddock) => paddock.name).join(", ")}`,
  });
  for (const paddock of paddocks) {
    await tx.query("insert into paddock_lineage (paddock_id, from_paddock_id, kind, on_date) values ($1, $2, 'merge', $3)", [id, paddock.id, onDate]);
  }
  await writeAuditEvent(tx, { eventType: "farming.paddocks_merged", entityType: "paddock", entityId: id, details: { onDate, from: ids } });
  return listPaddocks(tx, { farmId: paddocks[0].farm_id, includeRetired: true });
}

// Importing boundaries ---------------------------------------------------------------------

/** A GeoJSON or KML file as text (`content`), or a KMZ or zipped shapefile as base64 (`contentBase64`). */
type BoundaryImportInput = { fileName: unknown; content?: unknown; contentBase64?: unknown; nameProperty?: unknown; effectiveProperty?: unknown };

type ParsedFeature = { index: number; properties: Record<string, unknown>; geometry: PaddockGeometry | null; error: string | null };

async function readFeatures(fileName: string, input: { content?: unknown; contentBase64?: unknown }): Promise<{ features: ParsedFeature[]; file: ShapeFile }> {
  const file = await readShapeFile(fileName, input);
  if (file.features.length === 0) throw new ValidationError("The file has no paddock shapes in it.");
  const features = file.features.map((feature, index) => {
    try {
      return { index, properties: feature.properties, geometry: parseGeometry(feature.geometry), error: null };
    } catch (error) {
      if (error instanceof GeometryError) return { index, properties: feature.properties, geometry: null, error: error.message };
      throw error;
    }
  });
  return { features, file };
}

const NAME_GUESSES = ["name", "paddock", "paddock_name", "paddockname", "label", "id", "number"];
const AREA_GUESSES = ["effective_ha", "effective", "eff_ha", "area_ha", "ha", "hectares"];

function guessProperty(properties: string[], guesses: string[]): string | null {
  for (const guess of guesses) {
    const found = properties.find((property) => property.toLowerCase() === guess);
    if (found) return found;
  }
  return null;
}

function textOf(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 60);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function sameGeometry(a: PaddockGeometry | null, b: PaddockGeometry): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

async function buildPreview(
  tx: OrgTx,
  farmId: string,
  input: BoundaryImportInput,
): Promise<{ preview: ImportPreview; features: ParsedFeature[] }> {
  const fileName = requireString(input.fileName, "File name", { maxLength: 200 });
  const { features, file } = await readFeatures(fileName, input);
  const sha256 = file.sha256;
  const earlier = await tx.query<{ created_at: string }>("select created_at::text from farm_imports where farm_id = $1 and kind = 'paddock_boundaries' and sha256 = $2", [farmId, sha256]);
  const properties = [...new Set(features.flatMap((feature) => Object.keys(feature.properties)))].sort();
  const nameProperty = typeof input.nameProperty === "string" && input.nameProperty ? input.nameProperty : guessProperty(properties, NAME_GUESSES);
  const effectiveProperty = typeof input.effectiveProperty === "string" && input.effectiveProperty ? input.effectiveProperty : guessProperty(properties, AREA_GUESSES);
  if (nameProperty && !properties.includes(nameProperty)) throw new ValidationError(`No shape has a "${nameProperty}" property.`);
  const existing = await tx.query<PaddockRow>(`${PADDOCK_SELECT} where p.farm_id = $1 and p.status = 'active'`, [farmId]);
  const byName = new Map(existing.rows.map((row) => [row.name.toLowerCase(), row]));
  const seen = new Set<string>();
  const rows: ImportPreviewRow[] = features.map((feature) => {
    const name = nameProperty ? textOf(feature.properties[nameProperty]) : null;
    let effectiveHa: string | null = null;
    let error = feature.error;
    if (!error && effectiveProperty && feature.properties[effectiveProperty] !== undefined && feature.properties[effectiveProperty] !== null) {
      try {
        effectiveHa = parseHectares(feature.properties[effectiveProperty], "Effective area");
      } catch {
        error = `Its ${effectiveProperty} isn't a number of hectares.`;
      }
    }
    if (!error && !name) error = nameProperty ? `It has no ${nameProperty}.` : "Choose which property holds the paddock name.";
    if (!error && seen.has(name!.toLowerCase())) error = `${name} is in the file more than once.`;
    if (name) seen.add(name.toLowerCase());
    const mappedHa = feature.geometry ? hectaresText(areaHectares(feature.geometry)) : null;
    if (error) return { index: feature.index, name, mappedHa, effectiveHa, action: "error", paddockId: null, error };
    // Matched by the paddock's current name on this farm (names are unique among active paddocks).
    const match = byName.get(name!.toLowerCase());
    if (!match) return { index: feature.index, name, mappedHa, effectiveHa, action: "new", paddockId: null, error: null };
    const unchanged = sameGeometry(match.geometry, feature.geometry!) && (effectiveHa === null || Number(effectiveHa) === Number(match.effective_ha));
    return { index: feature.index, name, mappedHa, effectiveHa, action: unchanged ? "unchanged" : "new_boundary", paddockId: match.id, error: null };
  });
  return {
    features,
    preview: {
      fileName,
      format: file.format,
      note: file.note,
      sha256,
      alreadyImportedOn: earlier.rows[0]?.created_at ?? null,
      nameProperty,
      effectiveProperty,
      properties,
      rows,
      counts: {
        new: rows.filter((row) => row.action === "new").length,
        newBoundary: rows.filter((row) => row.action === "new_boundary").length,
        unchanged: rows.filter((row) => row.action === "unchanged").length,
        errors: rows.filter((row) => row.action === "error").length,
      },
    },
  };
}

/** What importing a GeoJSON file of paddock shapes would do, before anything is saved. */
export async function previewBoundaryImport(
  tx: OrgTx,
  farmIdInput: unknown,
  input: BoundaryImportInput,
): Promise<ImportPreview> {
  const farm = await requireActiveFarm(tx, farmIdInput);
  return (await buildPreview(tx, farm.id, input)).preview;
}

/**
 * Imports the shapes the preview showed: new paddocks, and new boundary
 * versions (and effective areas) for ones matched by name. Shapes with
 * errors are skipped. The same file can't be imported twice.
 */
export async function importBoundaries(
  tx: OrgTx,
  farmIdInput: unknown,
  input: BoundaryImportInput & { onDate?: unknown },
): Promise<{ preview: ImportPreview; paddocks: Paddock[] }> {
  const farm = await requireActiveFarm(tx, farmIdInput);
  await tx.query("select 1 from farms where id = $1 for update", [farm.id]);
  const { preview, features } = await buildPreview(tx, farm.id, input);
  if (preview.alreadyImportedOn) throw new ConflictError(`This file was already imported on ${preview.alreadyImportedOn.slice(0, 10)}.`);
  if (preview.counts.new + preview.counts.newBoundary === 0) throw new ValidationError("There's nothing new to import.");
  const onDate = input.onDate ? parseIsoDate(input.onDate, "From") : todayIsoDate();
  const source = `Imported from ${preview.fileName}`;
  for (const row of preview.rows) {
    const geometry = features[row.index].geometry!;
    if (row.action === "new") {
      await insertPaddock(tx, farm.id, { name: row.name!, effectiveHa: row.effectiveHa, onDate, geometry, source });
    } else if (row.action === "new_boundary") {
      const current = (await tx.query<PaddockRow>(`${PADDOCK_SELECT} where p.id = $1`, [row.paddockId])).rows[0];
      if (!sameGeometry(current.geometry, geometry)) await insertBoundary(tx, row.paddockId!, geometry, source);
      if (row.effectiveHa !== null) await tx.query("update paddocks set effective_ha = $2 where id = $1", [row.paddockId, row.effectiveHa]);
    }
  }
  await tx.query("insert into farm_imports (farm_id, kind, file_name, sha256, summary, created_by_email) values ($1, 'paddock_boundaries', $2, $3, $4::jsonb, $5)", [
    farm.id,
    preview.fileName,
    preview.sha256,
    JSON.stringify(preview.counts),
    tx.actor.email,
  ]);
  await writeAuditEvent(tx, { eventType: "farming.boundaries_imported", entityType: "farm", entityId: farm.id, details: { fileName: preview.fileName, ...preview.counts } });
  return { preview, paddocks: await listPaddocks(tx, { farmId: farm.id }) };
}
