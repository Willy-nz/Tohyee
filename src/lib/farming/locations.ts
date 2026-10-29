import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ForbiddenError, NotFoundError, TooManyRequestsError, ValidationError } from "@/lib/errors";
import { canSeeFarm, requireFarmAccess } from "@/lib/farming/access";
import {
  HARD_CAP_HOURS,
  MIN_SECONDS_BETWEEN_UPDATES,
  type MySharing,
  REFUSE_METRES,
  shareHours,
  type SharingPerson,
} from "@/lib/farming/locations-shared";

/*
 * Farm members on the map (#498 item 7, decisions 1125-1134; not yet
 * reviewed by Jess). A person chooses to share where they are with one farm
 * for up to 12 hours; while Tohyee is open on their phone it sends its
 * latest position, and the farm map shows it to the organisation's members
 * who work on that farm (decision 744). Only the latest position is kept
 * (no trail), and the row goes when they stop, when their time runs out,
 * and in any case 24 hours after it started. Starting and stopping are in
 * the audit trail; positions never are.
 *
 * Who it is always comes from the signed-in person (tx.actor), never the
 * request, so no one can share for someone else or turn it on for them.
 */

const FARM_ID = /^[1-9]\d{0,17}$/;

/** A fix taken longer ago than this isn't accepted as "where I am now". */
const OLDEST_FIX_SECONDS = 120;

type ShareRow = {
  id: string;
  user_id: string;
  user_email: string;
  farm_id: string;
  started_at: string;
  ends_at: string;
  latitude: number | null;
  longitude: number | null;
  accuracy_metres: number | null;
  position_at: string | null;
};

const SHARE_COLUMNS = "id::text, user_id::text, user_email, farm_id::text, started_at, ends_at, latitude, longitude, accuracy_metres, position_at";

function signedIn(tx: OrgTx): { userId: string; email: string } {
  if (!tx.actor.userId) throw new ForbiddenError("Only a signed-in person can share their location.");
  return { userId: tx.actor.userId, email: tx.actor.email.toLowerCase() };
}

async function requireFarm(tx: OrgTx, farmIdInput: unknown): Promise<{ id: string; name: string; isActive: boolean }> {
  const farmId = typeof farmIdInput === "string" && FARM_ID.test(farmIdInput) ? farmIdInput : null;
  if (!farmId) throw new NotFoundError("Farm not found.");
  await requireFarmAccess(tx, farmId);
  const farm = await tx.query<{ id: string; name: string; is_active: boolean }>("select id::text, name, is_active from farms where id = $1", [farmId]);
  if (!farm.rows[0]) throw new NotFoundError("Farm not found.");
  return { id: farm.rows[0].id, name: farm.rows[0].name, isActive: farm.rows[0].is_active };
}

/**
 * Deletes every session whose time is up, or that started more than 24
 * hours ago whatever it says (decision 1127). Run before every read and
 * change here, and every 10 minutes by the server (`locations-sweep.ts`),
 * so nothing waits for someone to open the map.
 */
export async function deleteExpiredShares(tx: OrgTx): Promise<number> {
  const deleted = await tx.query(`delete from farm_location_shares where ends_at <= now() or started_at <= now() - make_interval(hours => $1)`, [HARD_CAP_HOURS]);
  return deleted.rowCount ?? 0;
}

function personFrom(tx: OrgTx, row: ShareRow, me: string | null): SharingPerson {
  return {
    shareId: row.id,
    userId: row.user_id,
    name: tx.people.get(row.user_email) ?? row.user_email,
    isMe: row.user_id === me,
    farmId: row.farm_id,
    startedAt: row.started_at,
    endsAt: row.ends_at,
    position:
      row.latitude !== null && row.longitude !== null && row.accuracy_metres !== null && row.position_at !== null
        ? { latitude: row.latitude, longitude: row.longitude, accuracyMetres: row.accuracy_metres, at: row.position_at }
        : null,
  };
}

/**
 * Who is sharing with this farm and their latest positions, for a member
 * who works on it. Another farm, or a farm in another organisation, is "not
 * found". Anyone no longer a member of the organisation is taken off.
 */
export async function farmLocations(tx: OrgTx, farmIdInput: unknown): Promise<{ now: string; people: SharingPerson[] }> {
  const farm = await requireFarm(tx, farmIdInput);
  await deleteExpiredShares(tx);
  const rows = await tx.query<ShareRow>(`select ${SHARE_COLUMNS} from farm_location_shares where farm_id = $1 order by started_at, farm_location_shares.id`, [farm.id]);
  // The organisation's members come with the request (withFarmWork loads them); without that list nothing is judged gone.
  const membersKnown = tx.people.has(tx.actor.email.toLowerCase());
  const gone = membersKnown ? rows.rows.filter((row) => !tx.people.has(row.user_email)).map((row) => row.id) : [];
  if (gone.length) await tx.query("delete from farm_location_shares where id = any($1::uuid[])", [gone]);
  const now = await tx.query<{ now: string }>("select now() as now");
  return { now: now.rows[0].now, people: rows.rows.filter((row) => !gone.includes(row.id)).map((row) => personFrom(tx, row, tx.actor.userId)) };
}

/** The signed-in person's own sharing, on whichever farm, or null. A farm they no longer work on ends it. */
export async function mySharing(tx: OrgTx): Promise<MySharing | null> {
  const { userId } = signedIn(tx);
  await deleteExpiredShares(tx);
  const row = await tx.query<ShareRow & { farm_name: string }>(
    `select ${SHARE_COLUMNS.split(", ").map((column) => `s.${column}`).join(", ")}, f.name as farm_name
       from farm_location_shares s join farms f on f.id = s.farm_id where s.user_id = $1`,
    [userId],
  );
  const share = row.rows[0];
  if (!share) return null;
  if (!(await canSeeFarm(tx, share.farm_id))) {
    await endShare(tx, share, "no_farm_access");
    return null;
  }
  return { shareId: share.id, farmId: share.farm_id, farmName: share.farm_name, startedAt: share.started_at, endsAt: share.ends_at, hasPosition: share.position_at !== null };
}

/**
 * Starts sharing with a farm for `hours` (1-12, 4 if not given). Someone
 * already sharing with another farm moves to this one: there's one session
 * per person.
 */
export async function startSharing(tx: OrgTx, input: { farmId: unknown; hours?: unknown }): Promise<MySharing> {
  const { userId, email } = signedIn(tx);
  const farm = await requireFarm(tx, input.farmId);
  if (!farm.isActive) throw new ValidationError("This farm is archived, so locations aren't shared with it.");
  const hours = shareHours(input.hours);
  if (hours === null) throw new ValidationError("Choose from 1 to 12 hours.");
  await deleteExpiredShares(tx);
  const existing = await tx.query<ShareRow>(`select ${SHARE_COLUMNS} from farm_location_shares where user_id = $1 for update`, [userId]);
  if (existing.rows[0]) await endShare(tx, existing.rows[0], "replaced");
  const inserted = await tx.query<{ id: string; started_at: string; ends_at: string }>(
    `insert into farm_location_shares (user_id, user_email, farm_id, ends_at) values ($1, $2, $3, now() + make_interval(hours => $4))
     returning id::text, started_at, ends_at`,
    [userId, email, farm.id, hours],
  );
  const share = inserted.rows[0];
  await writeAuditEvent(tx, { eventType: "farming.location_sharing_started", entityType: "farm", entityId: farm.id, details: { hours, endsAt: share.ends_at } });
  return { shareId: share.id, farmId: farm.id, farmName: farm.name, startedAt: share.started_at, endsAt: share.ends_at, hasPosition: false };
}

async function endShare(tx: OrgTx, share: Pick<ShareRow, "id" | "farm_id">, reason: "stopped" | "replaced" | "no_farm_access"): Promise<void> {
  await tx.query("delete from farm_location_shares where id = $1", [share.id]);
  await writeAuditEvent(tx, { eventType: "farming.location_sharing_stopped", entityType: "farm", entityId: share.farm_id, details: { reason } });
}

/** Stops the signed-in person's sharing and deletes their position. Nothing to stop is fine. */
export async function stopSharing(tx: OrgTx): Promise<{ stopped: boolean }> {
  const { userId } = signedIn(tx);
  await deleteExpiredShares(tx);
  const existing = await tx.query<ShareRow>(`select ${SHARE_COLUMNS} from farm_location_shares where user_id = $1 for update`, [userId]);
  if (!existing.rows[0]) return { stopped: false };
  await endShare(tx, existing.rows[0], "stopped");
  return { stopped: true };
}

function coordinate(value: unknown, limit: number, what: string): number {
  const number = typeof value === "number" ? value : NaN;
  if (!Number.isFinite(number) || Math.abs(number) > limit) throw new ValidationError(`That ${what} isn't a position.`);
  return number;
}

/**
 * The phone's latest position for the signed-in person's session, replacing
 * the last one (nothing older is kept). Refused: no session (or it has
 * ended), a fix rougher than
 * 2 km or older than 2 minutes, and more than one every 10 seconds. A
 * farm they no longer work on ends the session (`ended: true`).
 */
export async function updatePosition(tx: OrgTx, input: { shareId?: unknown; latitude: unknown; longitude: unknown; accuracyMetres: unknown; takenAt?: unknown }): Promise<{ ended: boolean; position: SharingPerson["position"]; endsAt: string }> {
  const { userId } = signedIn(tx);
  await deleteExpiredShares(tx);
  const latitude = coordinate(input.latitude, 90, "latitude");
  const longitude = coordinate(input.longitude, 180, "longitude");
  const accuracy = typeof input.accuracyMetres === "number" && Number.isFinite(input.accuracyMetres) && input.accuracyMetres > 0 ? input.accuracyMetres : null;
  if (accuracy === null) throw new ValidationError("A position needs its accuracy in metres.");
  if (accuracy > REFUSE_METRES) throw new ValidationError("This position is too rough to share (more than 2 km out). Try again outside or with GPS on.");
  const taken = typeof input.takenAt === "string" ? new Date(input.takenAt) : null;
  if (input.takenAt !== undefined && (!taken || Number.isNaN(taken.getTime()))) throw new ValidationError("That position's time isn't a time.");
  const share = await tx.query<ShareRow & { received_at: string | null; too_soon: boolean }>(
    `select ${SHARE_COLUMNS}, received_at, coalesce(received_at > now() - make_interval(secs => $2), false) as too_soon
       from farm_location_shares where user_id = $1 for update`,
    [userId, MIN_SECONDS_BETWEEN_UPDATES],
  );
  const row = share.rows[0];
  // A session id from the phone that isn't the current one (stopped elsewhere, or replaced) isn't carried on.
  if (!row || (typeof input.shareId === "string" && input.shareId !== row.id)) throw new NotFoundError("You're not sharing your location now.");
  if (!(await canSeeFarm(tx, row.farm_id))) {
    // Ended, not refused: a thrown error would undo the deletion.
    await endShare(tx, row, "no_farm_access");
    return { ended: true, position: null, endsAt: row.ends_at };
  }
  if (row.too_soon) throw new TooManyRequestsError(`Positions are kept at most every ${MIN_SECONDS_BETWEEN_UPDATES} seconds.`);
  const updated = await tx.query<{ position_at: string; ends_at: string }>(
    `update farm_location_shares
        set latitude = $2, longitude = $3, accuracy_metres = $4, received_at = now(),
            -- The phone's time for the fix, but never later than now, and refused when older than two minutes (below).
            position_at = least(now(), coalesce($5::timestamptz, now()))
      where id = $1 and coalesce($5::timestamptz, now()) >= now() - make_interval(secs => $6)
      returning position_at, ends_at`,
    [row.id, latitude, longitude, accuracy, taken ? taken.toISOString() : null, OLDEST_FIX_SECONDS],
  );
  if (!updated.rows[0]) throw new ValidationError("That position is more than 2 minutes old, so it wasn't shared as where you are now.");
  return { ended: false, position: { latitude, longitude, accuracyMetres: accuracy, at: updated.rows[0].position_at }, endsAt: updated.rows[0].ends_at };
}
