import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { requireFarmAccess } from "@/lib/farming/access";
import type { Position } from "@/lib/farming/geometry";
import { ASSET_KINDS, type AssetKind, isLineKind, lengthMetres } from "@/lib/farming/map-assets-rules";
import { requireFarming } from "@/lib/farming/paddocks";
import { optionalString, requireId, requireOneOf, requireString } from "@/lib/validation";

/*
 * Farm map assets (decisions 1462-1465; examples MA1-MA6, not yet
 * reviewed): troughs, gates, water points, sheds, bores, tanks and the
 * like as points, and fences, pipes, races and drains as lines, on a
 * farm's map with a name and a note. Farm staff and up add, change and
 * remove them (removed ones are kept, with who and when).
 */

const MAX_LINE_POINTS = 500;

export type MapAsset = {
  id: string;
  farmId: string;
  kind: AssetKind;
  name: string;
  note: string | null;
  /** A point's place, or a line's points, as [longitude, latitude]. */
  point: Position | null;
  line: Position[] | null;
  /** A line's length in metres (geodesic), to the metre. */
  lengthMetres: number | null;
  createdByEmail: string;
  createdAt: string;
  updatedByEmail: string | null;
  updatedAt: string | null;
};

type Row = { id: string; farm_id: string; kind: AssetKind; name: string; note: string | null; geometry: { type: string; coordinates: unknown }; created_by_email: string; created_at: string; updated_by_email: string | null; updated_at: string | null };

function toAsset(row: Row): MapAsset {
  const point = row.geometry.type === "Point" ? (row.geometry.coordinates as Position) : null;
  const line = row.geometry.type === "LineString" ? (row.geometry.coordinates as Position[]) : null;
  return {
    id: row.id,
    farmId: row.farm_id,
    kind: row.kind,
    name: row.name,
    note: row.note,
    point,
    line,
    lengthMetres: line ? Math.round(lengthMetres(line)) : null,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    updatedByEmail: row.updated_by_email,
    updatedAt: row.updated_at,
  };
}

async function loadAssets(tx: OrgTx, where: string, params: unknown[]): Promise<MapAsset[]> {
  const rows = await tx.query<Row>(
    `select a.id::text, a.farm_id::text, a.kind, a.name, a.note, a.geometry, a.created_by_email, a.created_at::text, a.updated_by_email, a.updated_at::text
       from farm_map_assets a where a.status = 'active' and ${where} order by a.kind, lower(a.name), a.id`,
    params,
  );
  return rows.rows.map(toAsset);
}

async function requireFarm(tx: OrgTx, input: unknown): Promise<string> {
  await requireFarming(tx);
  const farmId = requireId(input, "farmId");
  const farm = await tx.query("select 1 from farms where id = $1", [farmId]);
  if (!farm.rowCount) throw new NotFoundError("Farm not found.");
  await requireFarmAccess(tx, farmId);
  return farmId;
}

async function requireAsset(tx: OrgTx, input: unknown): Promise<MapAsset> {
  await requireFarming(tx);
  const asset = (await loadAssets(tx, "a.id = $1", [requireId(input, "assetId")]))[0];
  if (!asset) throw new NotFoundError("Map asset not found, or removed.");
  await requireFarmAccess(tx, asset.farmId, "Map asset not found, or removed.");
  return asset;
}

function position(value: unknown, label: string): Position {
  if (!Array.isArray(value) || value.length < 2) throw new ValidationError(`${label} must be a longitude and latitude.`);
  const [lon, lat] = value;
  if (typeof lon !== "number" || typeof lat !== "number" || !Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) throw new ValidationError(`${label} must be a longitude and latitude.`);
  return [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
}

/** A point kind's `point`, or a line kind's `line` (2 to 500 points, no two the same in a row), as GeoJSON. */
function geometryFor(kind: AssetKind, input: { point?: unknown; line?: unknown }): { type: "Point"; coordinates: Position } | { type: "LineString"; coordinates: Position[] } {
  if (!isLineKind(kind)) {
    if (input.point === undefined || input.point === null) throw new ValidationError("Tap the map where it is.");
    return { type: "Point", coordinates: position(input.point, "The place") };
  }
  if (!Array.isArray(input.line) || input.line.length < 2) throw new ValidationError("A line needs at least two points: tap the map along it.");
  if (input.line.length > MAX_LINE_POINTS) throw new ValidationError(`A line can have at most ${MAX_LINE_POINTS} points.`);
  const points = input.line.map((value, index) => position(value, `Point ${index + 1}`));
  const kept = points.filter((point, index) => index === 0 || point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1]);
  if (kept.length < 2) throw new ValidationError("A line needs at least two different points.");
  return { type: "LineString", coordinates: kept };
}

export async function listMapAssets(tx: OrgTx, farmIdInput: unknown): Promise<MapAsset[]> {
  const farmId = await requireFarm(tx, farmIdInput);
  return loadAssets(tx, "a.farm_id = $1", [farmId]);
}

/** Adds an asset (`kind`, `name`, `note`, and `point` or `line`) (MA1-MA2). */
export async function addMapAsset(tx: OrgTx, input: { farmId: unknown; kind: unknown; name: unknown; note?: unknown; point?: unknown; line?: unknown }): Promise<MapAsset> {
  const farmId = await requireFarm(tx, input.farmId);
  const kind = requireOneOf(input.kind, "Kind", ASSET_KINDS);
  const name = requireString(input.name, "Name", { maxLength: 100 }).trim();
  const note = optionalString(input.note, "Note", { maxLength: 500 });
  const geometry = geometryFor(kind, input);
  const row = await tx.query<{ id: string }>("insert into farm_map_assets (farm_id, kind, name, note, geometry, created_by_email) values ($1, $2, $3, $4, $5::jsonb, $6) returning id::text", [farmId, kind, name, note, JSON.stringify(geometry), tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "farming.map_asset_added", entityType: "farm_map_asset", entityId: row.rows[0].id, details: { farmId, kind, name } });
  return (await loadAssets(tx, "a.id = $1", [row.rows[0].id]))[0];
}

/** Changes an asset's name, note, kind (points stay points, lines stay lines) or place (MA3). */
export async function updateMapAsset(tx: OrgTx, idInput: unknown, input: { kind?: unknown; name?: unknown; note?: unknown; point?: unknown; line?: unknown }): Promise<MapAsset> {
  const asset = await requireAsset(tx, idInput);
  const kind = input.kind === undefined ? asset.kind : requireOneOf(input.kind, "Kind", ASSET_KINDS);
  if (isLineKind(kind) !== isLineKind(asset.kind)) throw new ValidationError(isLineKind(asset.kind) ? "A line can't become a point. Remove it and add the point." : "A point can't become a line. Remove it and add the line.");
  const name = input.name === undefined ? asset.name : requireString(input.name, "Name", { maxLength: 100 }).trim();
  const note = input.note === undefined ? asset.note : optionalString(input.note, "Note", { maxLength: 500 });
  const geometry = input.point === undefined && input.line === undefined ? (asset.line ? { type: "LineString", coordinates: asset.line } : { type: "Point", coordinates: asset.point }) : geometryFor(kind, input);
  await tx.query("update farm_map_assets set kind = $2, name = $3, note = $4, geometry = $5::jsonb, updated_by_email = $6, updated_at = now() where id = $1", [asset.id, kind, name, note, JSON.stringify(geometry), tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "farming.map_asset_changed", entityType: "farm_map_asset", entityId: asset.id, details: { before: { kind: asset.kind, name: asset.name, note: asset.note }, after: { kind, name, note }, moved: input.point !== undefined || input.line !== undefined } });
  return (await loadAssets(tx, "a.id = $1", [asset.id]))[0];
}

/** Takes an asset off the map (MA3); it's kept, marked removed with who and when. */
export async function removeMapAsset(tx: OrgTx, idInput: unknown): Promise<void> {
  const asset = await requireAsset(tx, idInput);
  await tx.query("update farm_map_assets set status = 'removed', removed_by_email = $2, removed_at = now() where id = $1 and status = 'active'", [asset.id, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "farming.map_asset_removed", entityType: "farm_map_asset", entityId: asset.id, details: { kind: asset.kind, name: asset.name } });
}
