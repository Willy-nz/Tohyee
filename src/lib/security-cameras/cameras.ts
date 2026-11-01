import { randomInt } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { hashPassword } from "@/lib/auth/password";
import { businessTimeZone } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { visibleFarmIds } from "@/lib/farming/access";
import { requireSecurity, requireSecurityFarm } from "@/lib/security-cameras/access";
import { type Camera, DEFAULT_RETENTION_DAYS, isTimeZone, MAX_RETENTION_DAYS } from "@/lib/security-cameras/shared";
import { optionalString, requireId, requireString } from "@/lib/validation";

/*
 * Cameras on a farm (#508, decision 1216): a name, the model, where it is
 * on the farm map, notes, the time zone its clock is set to, and its own
 * upload login. Tohyee makes the login: a user name that says which
 * organisation it's for and a random password, shown once and kept only
 * as a scrypt hash, like people's passwords. No Reolink or cloud password
 * is ever stored. Only owners and admins set cameras up.
 */

type CameraRow = {
  id: string;
  farm_id: string;
  farm_name: string;
  name: string;
  model: string | null;
  notes: string | null;
  longitude: number | null;
  latitude: number | null;
  time_zone: string;
  quiet_alert_hours: number;
  is_active: boolean;
  upload_username: string | null;
  upload_login_made_at: Date | null;
  last_upload_at: Date | null;
  event_count: number;
};

const CAMERA_SELECT = `select c.id::text, c.farm_id::text, f.name as farm_name, c.name, c.model, c.notes, c.longitude, c.latitude, c.time_zone, c.quiet_alert_hours, c.is_active,
  c.upload_username, c.upload_login_made_at,
  (select max(e.received_at) from security_events e where e.camera_id = c.id) as last_upload_at,
  (select count(*)::int from security_events e where e.camera_id = c.id) as event_count
  from security_cameras c join farms f on f.id = c.farm_id`;

function toCamera(row: CameraRow): Camera {
  return {
    id: row.id,
    farmId: row.farm_id,
    farmName: row.farm_name,
    name: row.name,
    model: row.model,
    notes: row.notes,
    point: row.longitude === null || row.latitude === null ? null : [row.longitude, row.latitude],
    timeZone: row.time_zone,
    quietAlertHours: row.quiet_alert_hours,
    isActive: row.is_active,
    uploadUsername: row.upload_username,
    uploadLoginMadeAt: row.upload_login_made_at ? new Date(row.upload_login_made_at).toISOString() : null,
    lastUploadAt: row.last_upload_at ? new Date(row.last_upload_at).toISOString() : null,
    eventCount: row.event_count,
  };
}

/** Cameras on the farms the person sees (one farm, or all of them). The upload user name only for those who set cameras up. */
export async function listCameras(tx: OrgTx, input: { farmId?: unknown } = {}): Promise<Camera[]> {
  const access = await requireSecurity(tx, "view");
  const farmId = input.farmId === undefined || input.farmId === null || input.farmId === "" ? null : requireId(input.farmId, "Farm");
  if (farmId) await requireSecurityFarm(tx, farmId);
  const visible = await visibleFarmIds(tx);
  const rows = await tx.query<CameraRow>(
    `${CAMERA_SELECT} where ($1::bigint is null or c.farm_id = $1) and ($2::bigint[] is null or c.farm_id = any($2::bigint[])) order by f.name, c.is_active desc, lower(c.name)`,
    [farmId, visible],
  );
  return rows.rows.map(toCamera).map((camera) => (access.configure ? camera : { ...camera, uploadUsername: null }));
}

async function cameraRow(tx: OrgTx, idInput: unknown): Promise<CameraRow> {
  const id = requireId(idInput, "Camera");
  const row = await tx.query<CameraRow>(`${CAMERA_SELECT} where c.id = $1`, [id]);
  if (!row.rows[0]) throw new NotFoundError("Camera not found.");
  await requireSecurityFarm(tx, row.rows[0].farm_id).catch(() => {
    throw new NotFoundError("Camera not found.");
  });
  return row.rows[0];
}

function parsePoint(input: unknown): [number, number] | null {
  if (input === null || input === undefined || input === "") return null;
  if (!Array.isArray(input) || input.length !== 2 || !input.every((value) => typeof value === "number" && Number.isFinite(value))) throw new ValidationError("The place on the map isn't a longitude and latitude.");
  const [lon, lat] = input as [number, number];
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) throw new ValidationError("The place on the map is outside longitude -180 to 180 and latitude -90 to 90.");
  return [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
}

function parseDetails(input: Record<string, unknown>) {
  const timeZone = input.timeZone === undefined || input.timeZone === null || input.timeZone === "" ? businessTimeZone() : String(input.timeZone).trim();
  if (!isTimeZone(timeZone)) throw new ValidationError("Choose the time zone the camera's clock is set to, e.g. Pacific/Auckland.");
  const hours = input.quietAlertHours === undefined || input.quietAlertHours === null || input.quietAlertHours === "" ? 24 : Number(input.quietAlertHours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) throw new ValidationError("Warn after 1 to 720 hours with no uploads.");
  return {
    name: requireString(input.name, "Name", { maxLength: 60 }),
    model: optionalString(input.model, "Model", { maxLength: 60 }),
    notes: optionalString(input.notes, "Notes", { maxLength: 1000 }),
    point: parsePoint(input.point),
    timeZone,
    quietAlertHours: hours,
  };
}

function duplicateName(error: unknown): never {
  if ((error as { code?: string })?.code === "23505") throw new ConflictError("There's already a camera with that name on this farm.");
  throw error;
}

export async function addCamera(tx: OrgTx, input: Record<string, unknown>): Promise<Camera> {
  await requireSecurity(tx, "configure");
  const farmId = requireId(input.farmId, "Farm");
  await requireSecurityFarm(tx, farmId);
  const farm = await tx.query<{ is_active: boolean }>("select is_active from farms where id = $1", [farmId]);
  if (!farm.rows[0]?.is_active) throw new ValidationError("Cameras can only be added to a current farm.");
  const details = parseDetails(input);
  const row = await tx
    .query<{ id: string }>(
      `insert into security_cameras (farm_id, name, model, notes, longitude, latitude, time_zone, quiet_alert_hours, created_by_email)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id::text`,
      [farmId, details.name, details.model, details.notes, details.point?.[0] ?? null, details.point?.[1] ?? null, details.timeZone, details.quietAlertHours, tx.actor.email],
    )
    .catch(duplicateName);
  await writeAuditEvent(tx, { eventType: "security.camera_added", entityType: "security_camera", entityId: row.rows[0].id, details: { farmId, name: details.name, model: details.model } });
  return toCamera(await cameraRow(tx, row.rows[0].id));
}

export async function changeCamera(tx: OrgTx, idInput: unknown, input: Record<string, unknown>): Promise<Camera> {
  await requireSecurity(tx, "configure");
  const camera = await cameraRow(tx, idInput);
  const details = parseDetails(input);
  await tx
    .query(
      `update security_cameras set name = $2, model = $3, notes = $4, longitude = $5, latitude = $6, time_zone = $7, quiet_alert_hours = $8 where id = $1`,
      [camera.id, details.name, details.model, details.notes, details.point?.[0] ?? null, details.point?.[1] ?? null, details.timeZone, details.quietAlertHours],
    )
    .catch(duplicateName);
  await writeAuditEvent(tx, { eventType: "security.camera_changed", entityType: "security_camera", entityId: camera.id, details: { name: details.name, model: details.model, timeZone: details.timeZone, quietAlertHours: details.quietAlertHours, placed: details.point !== null } });
  return toCamera(await cameraRow(tx, camera.id));
}

/** Archiving stops uploads straight away (its login goes); its events stay until they expire or are deleted. Restoring needs a new login. */
export async function setCameraActive(tx: OrgTx, idInput: unknown, active: boolean): Promise<Camera> {
  await requireSecurity(tx, "configure");
  const camera = await cameraRow(tx, idInput);
  await tx.query(
    `update security_cameras set is_active = $2,
       upload_username = case when $2 then upload_username else null end,
       upload_password_hash = case when $2 then upload_password_hash else null end,
       upload_login_made_at = case when $2 then upload_login_made_at else null end,
       upload_login_made_by_email = case when $2 then upload_login_made_by_email else null end
     where id = $1`,
    [camera.id, active],
  );
  await writeAuditEvent(tx, { eventType: active ? "security.camera_restored" : "security.camera_archived", entityType: "security_camera", entityId: camera.id, details: { name: camera.name } });
  return toCamera(await cameraRow(tx, camera.id));
}

// Upload logins ------------------------------------------------------------------------------

const LOWER = "abcdefghijklmnopqrstuvwxyz0123456789";
// No look-alikes (0/O, 1/l/I), since it's typed into a phone app by hand.
const PASSWORD_CHARS = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const UPLOAD_PASSWORD_LENGTH = 20;

function randomText(chars: string, length: number): string {
  let text = "";
  for (let index = 0; index < length; index += 1) text += chars[randomInt(chars.length)];
  return text;
}

/** "<organisation>.<10 random>": the organisation part tells the receiver which database to look in. */
export function newUploadUsername(organisationId: string): string {
  return `${organisationId}.${randomText(LOWER, 10)}`;
}

/** The organisation a user name is for, or null if it isn't one of Tohyee's. */
export function organisationOfUsername(username: string): string | null {
  const match = /^([a-z0-9][a-z0-9-]{0,31})\.[a-z0-9]{10}$/.exec(username);
  return match ? match[1] : null;
}

export function newUploadPassword(): string {
  return randomText(PASSWORD_CHARS, UPLOAD_PASSWORD_LENGTH);
}

/**
 * Makes (or replaces) a camera's upload login. The password is returned
 * this once and kept only as a hash: lost, it's replaced, never shown again.
 * Replacing it stops the old one straight away.
 */
export async function makeUploadLogin(tx: OrgTx, idInput: unknown): Promise<{ camera: Camera; username: string; password: string }> {
  await requireSecurity(tx, "configure");
  const camera = await cameraRow(tx, idInput);
  if (!camera.is_active) throw new ConflictError("Restore the camera before making an upload login for it.");
  const username = newUploadUsername(tx.organisationId);
  const password = newUploadPassword();
  const hash = await hashPassword(password);
  await tx.query("update security_cameras set upload_username = $2, upload_password_hash = $3, upload_login_made_at = now(), upload_login_made_by_email = $4 where id = $1", [camera.id, username, hash, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: camera.upload_username ? "security.upload_login_replaced" : "security.upload_login_made", entityType: "security_camera", entityId: camera.id, details: { username } });
  return { camera: toCamera(await cameraRow(tx, camera.id)), username, password };
}

export async function removeUploadLogin(tx: OrgTx, idInput: unknown): Promise<Camera> {
  await requireSecurity(tx, "configure");
  const camera = await cameraRow(tx, idInput);
  await tx.query("update security_cameras set upload_username = null, upload_password_hash = null, upload_login_made_at = null, upload_login_made_by_email = null where id = $1", [camera.id]);
  await writeAuditEvent(tx, { eventType: "security.upload_login_removed", entityType: "security_camera", entityId: camera.id, details: {} });
  return toCamera(await cameraRow(tx, camera.id));
}

// Farm settings -----------------------------------------------------------------------------

export type SecurityFarmSettings = { farmId: string; retentionDays: number; isDefault: boolean };

export async function farmSettings(tx: OrgTx, farmIdInput: unknown): Promise<SecurityFarmSettings> {
  await requireSecurity(tx, "view");
  const farmId = requireId(farmIdInput, "Farm");
  await requireSecurityFarm(tx, farmId);
  const row = await tx.query<{ retention_days: number }>("select retention_days from security_farm_settings where farm_id = $1", [farmId]);
  return { farmId, retentionDays: row.rows[0]?.retention_days ?? DEFAULT_RETENTION_DAYS, isDefault: !row.rows[0] };
}

/** How many days media is kept on a farm before the clean-up removes it (kept events stay). Audited. */
export async function setFarmRetention(tx: OrgTx, farmIdInput: unknown, daysInput: unknown): Promise<SecurityFarmSettings> {
  await requireSecurity(tx, "configure");
  const farmId = requireId(farmIdInput, "Farm");
  await requireSecurityFarm(tx, farmId);
  const days = Number(daysInput);
  if (!Number.isInteger(days) || days < 1 || days > MAX_RETENTION_DAYS) throw new ValidationError(`Keep media for 1 to ${MAX_RETENTION_DAYS} days.`);
  const before = await farmSettings(tx, farmId);
  await tx.query(
    `insert into security_farm_settings (farm_id, retention_days, updated_by_email) values ($1, $2, $3)
     on conflict (farm_id) do update set retention_days = excluded.retention_days, updated_by_email = excluded.updated_by_email, updated_at = now()`,
    [farmId, days, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "security.retention_set", entityType: "farm", entityId: farmId, details: { from: before.retentionDays, to: days } });
  return farmSettings(tx, farmId);
}
