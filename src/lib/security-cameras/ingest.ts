import { rm } from "node:fs/promises";
import { verifyAgainstDummy, verifyPassword } from "@/lib/auth/password";
import { type Actor, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { getOrganisation, type OrganisationRecord } from "@/lib/organisations/registry";
import { organisationOfUsername } from "@/lib/security-cameras/cameras";
import { type MediaKind, parseCameraFileName } from "@/lib/security-cameras/file-names";
import { eventTiming, localTimeToInstant } from "@/lib/security-cameras/shared";
import { moveIntoPlace, removeStored, resolveStored, storagePathFor, thumbnailPathFor } from "@/lib/security-cameras/storage";

/*
 * Turning an uploaded file into an event (#508, decisions 1217-1219). The
 * receiver has already written it to the incoming folder, counted it,
 * hashed it and checked its first bytes. Here: which camera, the times,
 * moving it into place, a small copy of a photo, and the event row. The
 * same file from the same camera twice is one event.
 */

const ACTOR: Actor = { userId: null, email: "camera upload" };

export type Uploader = { organisation: OrganisationRecord; cameraId: string; cameraName: string };

/**
 * Checks a camera's upload login. The user name says which organisation;
 * a wrong name or password takes as long as a right one. The demo farm and
 * organisations that aren't ready take no uploads.
 */
export async function authenticateCamera(username: string, password: string): Promise<Uploader | null> {
  const organisationId = organisationOfUsername(username);
  const organisation = organisationId ? await getOrganisation(organisationId).catch(() => null) : null;
  if (!organisation || organisation.demo || !organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") {
    await verifyAgainstDummy(password);
    return null;
  }
  const row = await withOrganisationTransaction(organisation, ACTOR, (tx) =>
    tx.query<{ id: string; name: string; upload_password_hash: string }>("select id::text, name, upload_password_hash from security_cameras where upload_username = $1 and is_active", [username]),
  );
  const camera = row.rows[0];
  if (!camera) {
    await verifyAgainstDummy(password);
    return null;
  }
  return (await verifyPassword(password, camera.upload_password_hash)) ? { organisation, cameraId: camera.id, cameraName: camera.name } : null;
}

export type ReceivedFile = { name: string; tempPath: string; sizeBytes: number; sha256: string; media: MediaKind; receivedAt: Date };

export type IngestResult = { status: "saved" | "duplicate" | "refused"; eventId: string | null };

async function makeThumbnail(organisationId: string, storagePath: string): Promise<boolean> {
  try {
    const sharp = (await import("sharp")).default;
    await sharp(resolveStored(organisationId, storagePath)).rotate().resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 70 }).toFile(resolveStored(organisationId, thumbnailPathFor(storagePath)));
    return true;
  } catch {
    // No image library on this server, or a photo it can't read: the full photo is shown instead.
    return false;
  }
}

export async function ingestUpload(uploader: Uploader, file: ReceivedFile): Promise<IngestResult> {
  const { organisation, cameraId } = uploader;
  const existing = await withOrganisationTransaction(organisation, ACTOR, (tx) => tx.query<{ id: string }>("select id::text from security_events where camera_id = $1 and sha256 = $2", [cameraId, file.sha256]));
  if (existing.rows[0]) {
    await rm(file.tempPath, { force: true });
    return { status: "duplicate", eventId: existing.rows[0].id };
  }
  const storagePath = storagePathFor(organisation.id, cameraId, file.receivedAt, file.sha256, file.media.extension);
  await moveIntoPlace(file.tempPath, organisation.id, storagePath);
  const hasThumbnail = file.media.kind === "snapshot" ? await makeThumbnail(organisation.id, storagePath) : false;
  const parsed = parseCameraFileName(file.name);
  const result = await withOrganisationTransaction(organisation, ACTOR, async (tx): Promise<IngestResult> => {
    const camera = await tx.query<{ farm_id: string; time_zone: string }>("select farm_id::text, time_zone from security_cameras where id = $1 and is_active for share", [cameraId]);
    if (!camera.rows[0]) return { status: "refused", eventId: null };
    const timeZone = camera.rows[0].time_zone;
    const cameraAt = parsed.cameraLocalTime ? localTimeToInstant(parsed.cameraLocalTime, timeZone) : null;
    const timing = eventTiming(cameraAt, file.receivedAt);
    const inserted = await tx.query<{ id: string }>(
      `insert into security_events (camera_id, farm_id, kind, file_name, camera_local_time, camera_time_zone, camera_at, received_at, occurred_at, clock_note, content_type, size_bytes, sha256, storage_path, has_thumbnail)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       on conflict (camera_id, sha256) do nothing returning id::text`,
      [cameraId, camera.rows[0].farm_id, file.media.kind, file.name.slice(0, 255) || "upload", parsed.cameraLocalTime, timeZone, cameraAt, file.receivedAt, timing.occurredAt, timing.clockNote, file.media.contentType, file.sizeBytes, file.sha256, storagePath, hasThumbnail],
    );
    if (inserted.rows[0]) return { status: "saved", eventId: inserted.rows[0].id };
    const again = await tx.query<{ id: string }>("select id::text from security_events where camera_id = $1 and sha256 = $2", [cameraId, file.sha256]);
    return { status: "duplicate", eventId: again.rows[0]?.id ?? null };
  });
  // Archived while it arrived: nothing points at the file, so it goes. (A duplicate shares the original's path and stays.)
  if (result.status === "refused") await removeStored(organisation.id, storagePath);
  return result;
}
