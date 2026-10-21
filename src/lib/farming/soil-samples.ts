import { writeAuditEvent } from "@/lib/audit";
import { requireFarmAccess, requireRecordAccess } from "./access";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { dec, parseDecimalInput, toFixedString } from "@/lib/money/decimal";
import { requireFarming } from "@/lib/farming/paddocks";
import { optionalString, requireId } from "@/lib/validation";

/*
 * Soil samples taken in the field, before the lab's results come back (#249
 * stage 5; example FA4, decision 561): recorded on the screens or by a farm
 * app, which is named on the record. Nothing is judged; removed ones are kept.
 */

export type SoilSample = {
  id: string;
  farmId: string;
  paddockId: string;
  paddockName: string;
  takenOn: string;
  sampleName: string | null;
  depth: string | null;
  latitude: string | null;
  longitude: string | null;
  note: string | null;
  recordedVia: string | null;
  createdByEmail: string;
  createdAt: string;
};

type Row = { id: string; farm_id: string; paddock_id: string; paddock_name: string; taken_on: string; sample_name: string | null; depth: string | null; latitude: string | null; longitude: string | null; note: string | null; recorded_via: string | null; created_by_email: string; created_at: string };

async function load(tx: OrgTx, where: string, params: unknown[]): Promise<SoilSample[]> {
  const rows = await tx.query<Row>(
    `select s.id::text, s.farm_id::text, s.paddock_id::text, p.name as paddock_name, s.taken_on::text, s.sample_name, s.depth, s.latitude::text, s.longitude::text, s.note, s.recorded_via, s.created_by_email, s.created_at::text
       from soil_samples s join paddocks p on p.id = s.paddock_id
      where s.status = 'active' and ${where}
      order by s.taken_on desc, s.id desc`,
    params,
  );
  return rows.rows.map((row) => ({
    id: row.id,
    farmId: row.farm_id,
    paddockId: row.paddock_id,
    paddockName: row.paddock_name,
    takenOn: row.taken_on,
    sampleName: row.sample_name,
    depth: row.depth,
    latitude: row.latitude === null ? null : toFixedString(dec(row.latitude), 6),
    longitude: row.longitude === null ? null : toFixedString(dec(row.longitude), 6),
    note: row.note,
    recordedVia: row.recorded_via,
    createdByEmail: row.created_by_email,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

export async function listSoilSamples(tx: OrgTx, input: { farmId: unknown; paddockId?: unknown }): Promise<SoilSample[]> {
  await requireFarming(tx);
  const farmId = requireId(input.farmId, "farmId");
  await requireFarmAccess(tx, farmId);
  if (input.paddockId) return load(tx, "s.farm_id = $1 and s.paddock_id = $2", [farmId, requireId(input.paddockId, "paddockId")]);
  return load(tx, "s.farm_id = $1", [farmId]);
}

function coordinate(input: unknown, label: string, limit: number): string | null {
  if (input === undefined || input === null || input === "") return null;
  const text = typeof input === "number" ? String(input) : input;
  const value = parseDecimalInput(text, label, { maxScale: 6, allowNegative: true, allowZero: true });
  if (Math.abs(Number(value)) > limit) throw new ValidationError(`${label} must be between -${limit} and ${limit}.`);
  return value;
}

/** Records a sample (FA4). Latitude and longitude come together or not at all. */
export async function addSoilSample(tx: OrgTx, input: { paddockId: unknown; takenOn: unknown; sampleName?: unknown; depth?: unknown; latitude?: unknown; longitude?: unknown; note?: unknown }): Promise<SoilSample> {
  await requireFarming(tx);
  const paddockId = requireId(input.paddockId, "paddockId");
  const paddock = (await tx.query<{ farm_id: string; name: string; status: string }>("select farm_id::text, name, status from paddocks where id = $1", [paddockId])).rows[0];
  if (!paddock) throw new NotFoundError("Paddock not found.");
  await requireFarmAccess(tx, paddock.farm_id, "Paddock not found.");
  if (paddock.status !== "active") throw new ValidationError(`${paddock.name} is retired.`);
  const latitude = coordinate(input.latitude, "Latitude", 90);
  const longitude = coordinate(input.longitude, "Longitude", 180);
  if ((latitude === null) !== (longitude === null)) throw new ValidationError("Give both latitude and longitude, or neither.");
  const row = await tx.query<{ id: string }>(
    `insert into soil_samples (farm_id, paddock_id, taken_on, sample_name, depth, latitude, longitude, note, recorded_via, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id::text`,
    [
      paddock.farm_id,
      paddockId,
      parseIsoDate(input.takenOn, "Taken on"),
      optionalString(input.sampleName, "Sample name", { maxLength: 100 }),
      optionalString(input.depth, "Depth", { maxLength: 40 }),
      latitude,
      longitude,
      optionalString(input.note, "Note", { maxLength: 500 }),
      tx.actor.via ?? null,
      tx.actor.email,
    ],
  );
  await writeAuditEvent(tx, { eventType: "farming.soil_sample_added", entityType: "soil_sample", entityId: row.rows[0].id, details: { paddockId } });
  return (await load(tx, "s.id = $1", [row.rows[0].id]))[0];
}

export async function removeSoilSample(tx: OrgTx, idInput: unknown): Promise<void> {
  await requireFarming(tx);
  const id = requireId(idInput, "sampleId");
  await requireRecordAccess(tx, "soil_samples", id, "Soil sample not found, or already removed.");
  const removed = await tx.query("update soil_samples set status = 'removed' where id = $1 and status = 'active' returning id", [id]);
  if (!removed.rowCount) throw new NotFoundError("Soil sample not found, or already removed.");
  await writeAuditEvent(tx, { eventType: "farming.soil_sample_removed", entityType: "soil_sample", entityId: id, details: {} });
}
