import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { canSeeFarm, visibleFarmIds } from "@/lib/farming/access";
import { requireSecurity, requireSecurityFarm } from "@/lib/security-cameras/access";
import { type Detection, DEFAULT_RETENTION_DAYS, type EventKind, retentionCutoff, type SecurityAccess, type SecurityEvent } from "@/lib/security-cameras/shared";
import { optionalString, requireId } from "@/lib/validation";

/*
 * Camera events (#508, decisions 1218-1223): one per file a camera
 * uploaded. A snapshot is only a snapshot; a clip is a clip that arrived.
 * Nothing here says a clip exists because a snapshot does. Keeping an event
 * takes it out of the retention clean-up; deleting is for those with delete
 * access, can't be undone and is audited.
 */

type EventRow = {
  id: string;
  camera_id: string;
  camera_name: string;
  farm_id: string;
  farm_name: string;
  kind: EventKind;
  detection: Detection;
  file_name: string;
  camera_local_time: string | null;
  camera_time_zone: string;
  camera_at: Date | null;
  received_at: Date;
  occurred_at: Date;
  clock_note: SecurityEvent["clockNote"];
  size_bytes: string;
  has_thumbnail: boolean;
  kept: boolean;
  kept_note: string | null;
  kept_by_email: string | null;
  kept_at: Date | null;
  content_type: string;
  sha256: string;
  storage_path: string;
};

const EVENT_SELECT = `select e.id::text, e.camera_id::text, c.name as camera_name, e.farm_id::text, f.name as farm_name, e.kind, e.detection, e.file_name,
  e.camera_local_time, e.camera_time_zone, e.camera_at, e.received_at, e.occurred_at, e.clock_note, e.size_bytes::text, e.has_thumbnail,
  e.kept, e.kept_note, e.kept_by_email, e.kept_at, e.content_type, e.sha256, e.storage_path
  from security_events e join security_cameras c on c.id = e.camera_id join farms f on f.id = e.farm_id`;

const iso = (value: Date | null) => (value ? new Date(value).toISOString() : null);

function toEvent(row: EventRow): SecurityEvent {
  return {
    id: row.id,
    cameraId: row.camera_id,
    cameraName: row.camera_name,
    farmId: row.farm_id,
    farmName: row.farm_name,
    kind: row.kind,
    detection: row.detection,
    fileName: row.file_name,
    cameraLocalTime: row.camera_local_time,
    cameraTimeZone: row.camera_time_zone,
    cameraAt: iso(row.camera_at),
    receivedAt: iso(row.received_at)!,
    occurredAt: iso(row.occurred_at)!,
    clockNote: row.clock_note,
    sizeBytes: Number(row.size_bytes),
    hasThumbnail: row.has_thumbnail,
    kept: row.kept,
    keptNote: row.kept_note,
    keptByEmail: row.kept_by_email,
    keptAt: iso(row.kept_at),
  };
}

export type EventFilter = { farmId?: unknown; cameraId?: unknown; kind?: unknown; from?: unknown; to?: unknown; kept?: unknown; before?: unknown; limit?: unknown };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const EVENT_PAGE = 60;

/**
 * Events on the farms the person sees, newest first, 60 at a time (`before`
 * is the last one's id for the next page). Dates are the business time
 * zone's days, on when the event happened (decision 1218).
 */
export async function listEvents(tx: OrgTx, filter: EventFilter, timeZone: string): Promise<{ events: SecurityEvent[]; access: SecurityAccess; more: boolean }> {
  const access = await requireSecurity(tx, "view");
  const farmId = filter.farmId ? requireId(filter.farmId, "Farm") : null;
  if (farmId) await requireSecurityFarm(tx, farmId);
  const cameraId = filter.cameraId ? requireId(filter.cameraId, "Camera") : null;
  const kind = filter.kind === "snapshot" || filter.kind === "clip" ? filter.kind : null;
  if (filter.kind && !kind) throw new ValidationError("Choose snapshots or clips.");
  const from = typeof filter.from === "string" && filter.from ? filter.from : null;
  const to = typeof filter.to === "string" && filter.to ? filter.to : null;
  if ((from && !DATE.test(from)) || (to && !DATE.test(to))) throw new ValidationError("Dates are YYYY-MM-DD.");
  const before = filter.before ? requireId(filter.before, "Event") : null;
  const kept = filter.kept === true || filter.kept === "true" || filter.kept === "1";
  const limit = Math.min(EVENT_PAGE, Math.max(1, Number(filter.limit) || EVENT_PAGE));
  const visible = await visibleFarmIds(tx);
  const rows = await tx.query<EventRow>(
    `${EVENT_SELECT}
     where ($1::bigint is null or e.farm_id = $1) and ($2::bigint[] is null or e.farm_id = any($2::bigint[]))
       and ($3::bigint is null or e.camera_id = $3) and ($4::text is null or e.kind = $4)
       and ($5::date is null or e.occurred_at >= ($5::date)::timestamp at time zone $8)
       and ($6::date is null or e.occurred_at < ($6::date + 1)::timestamp at time zone $8)
       and (not $7 or e.kept)
       and ($9::bigint is null or (e.occurred_at, e.id) < (select b.occurred_at, b.id from security_events b where b.id = $9))
     order by e.occurred_at desc, e.id desc limit $10`,
    [farmId, visible, cameraId, kind, from, to, kept, timeZone, before, limit + 1],
  );
  return { events: rows.rows.slice(0, limit).map(toEvent), access, more: rows.rows.length > limit };
}

async function eventRow(tx: OrgTx, idInput: unknown, lock = false): Promise<EventRow> {
  const id = requireId(idInput, "Event");
  const row = await tx.query<EventRow>(`${EVENT_SELECT} where e.id = $1${lock ? " for update of e" : ""}`, [id]);
  if (!row.rows[0] || !(await canSeeFarm(tx, row.rows[0].farm_id))) throw new NotFoundError("That camera event wasn't found.");
  return row.rows[0];
}

export async function getEvent(tx: OrgTx, idInput: unknown): Promise<SecurityEvent> {
  await requireSecurity(tx, "view");
  return toEvent(await eventRow(tx, idInput));
}

/** Keeps an event out of the clean-up, with a note (decision 1222). Anyone who can see it may keep it. */
export async function keepEvent(tx: OrgTx, idInput: unknown, noteInput: unknown): Promise<SecurityEvent> {
  await requireSecurity(tx, "view");
  const row = await eventRow(tx, idInput, true);
  const note = optionalString(noteInput, "Note", { maxLength: 1000 });
  await tx.query("update security_events set kept = true, kept_note = $2, kept_by_email = $3, kept_at = now() where id = $1", [row.id, note, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: row.kept ? "security.kept_note_changed" : "security.event_kept", entityType: "security_event", entityId: row.id, details: { note } });
  return toEvent(await eventRow(tx, row.id));
}

/** Stops keeping an event, so the clean-up can remove it: for those who may delete. */
export async function unkeepEvent(tx: OrgTx, idInput: unknown): Promise<SecurityEvent> {
  await requireSecurity(tx, "delete");
  const row = await eventRow(tx, idInput, true);
  if (!row.kept) return toEvent(row);
  await tx.query("update security_events set kept = false, kept_note = null, kept_by_email = null, kept_at = null where id = $1", [row.id]);
  await writeAuditEvent(tx, { eventType: "security.event_unkept", entityType: "security_event", entityId: row.id, details: { note: row.kept_note } });
  return toEvent(await eventRow(tx, row.id));
}

export type DeletedMedia = { storagePath: string };

/**
 * Deletes an event and (once the transaction commits; the caller removes
 * them) its files. Can't be undone. Kept events must be un-kept first.
 * Audited with what was deleted, not the media.
 */
export async function deleteEvent(tx: OrgTx, idInput: unknown): Promise<DeletedMedia> {
  await requireSecurity(tx, "delete");
  const row = await eventRow(tx, idInput, true);
  if (row.kept) throw new ConflictError("This event is kept. Stop keeping it first, then delete it.");
  await tx.query("delete from security_events where id = $1", [row.id]);
  await writeAuditEvent(tx, {
    eventType: "security.event_deleted",
    entityType: "security_event",
    entityId: row.id,
    details: { cameraId: row.camera_id, cameraName: row.camera_name, farmId: row.farm_id, kind: row.kind, occurredAt: iso(row.occurred_at), receivedAt: iso(row.received_at), fileName: row.file_name, sha256: row.sha256 },
  });
  return { storagePath: row.storage_path };
}

export type MediaRef = { event: SecurityEvent; storagePath: string; contentType: string; sha256: string };

/**
 * A media file the person may have: the thumbnail and the full photo or
 * clip to look at need "view"; a download needs "download". Downloads are
 * audited, and so is the first request for a clip (where it starts
 * playing), so the history says who watched what (decision 1223).
 */
export async function mediaFor(tx: OrgTx, idInput: unknown, purpose: "thumbnail" | "view" | "download", options: { startsPlaying?: boolean } = {}): Promise<MediaRef> {
  await requireSecurity(tx, purpose === "download" ? "download" : "view");
  const row = await eventRow(tx, idInput);
  if (purpose === "download") {
    await writeAuditEvent(tx, { eventType: "security.media_downloaded", entityType: "security_event", entityId: row.id, details: { kind: row.kind, cameraName: row.camera_name, sha256: row.sha256 } });
  } else if (purpose === "view" && row.kind === "clip" && options.startsPlaying) {
    await writeAuditEvent(tx, { eventType: "security.clip_viewed", entityType: "security_event", entityId: row.id, details: { cameraName: row.camera_name } });
  }
  return { event: toEvent(row), storagePath: row.storage_path, contentType: row.content_type, sha256: row.sha256 };
}

// Retention clean-up -------------------------------------------------------------------------

/**
 * Removes the rows of events older than each farm's retention (by when
 * Tohyee got them) that aren't kept, at most `limit` at a time, and
 * returns their files for the caller to delete once this commits. One
 * audit event per farm with how many went (decision 1222).
 */
export async function expireEvents(tx: OrgTx, now: Date, limit = 500): Promise<DeletedMedia[]> {
  const farms = await tx.query<{ farm_id: string; retention_days: number | null }>(
    "select distinct e.farm_id::text, s.retention_days from security_events e left join security_farm_settings s on s.farm_id = e.farm_id where not e.kept",
  );
  const removed: DeletedMedia[] = [];
  for (const farm of farms.rows) {
    const days = farm.retention_days ?? DEFAULT_RETENTION_DAYS;
    const gone = await tx.query<{ storage_path: string }>(
      `delete from security_events where id in (
         select id from security_events where farm_id = $1 and not kept and received_at < $2 order by received_at limit $3
       ) returning storage_path`,
      [farm.farm_id, retentionCutoff(now, days), limit],
    );
    if (gone.rows.length) {
      await writeAuditEvent(tx, { eventType: "security.media_expired", entityType: "farm", entityId: farm.farm_id, details: { count: gone.rows.length, retentionDays: days } });
      removed.push(...gone.rows.map((row) => ({ storagePath: row.storage_path })));
    }
  }
  return removed;
}
