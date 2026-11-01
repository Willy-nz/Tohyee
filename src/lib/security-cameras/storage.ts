import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { ValidationError } from "@/lib/errors";

/*
 * Where camera media is kept (#508, decision 1219): files on disk, never in
 * the database. One folder per organisation, then per camera and month,
 * each file named by its SHA-256, so the same file from the same camera is
 * one file. `TOHYEE_CAMERA_MEDIA_DIR` chooses the folder (a Docker volume,
 * a bigger disk). It isn't in the nightly database backup.
 */

const ORGANISATION_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function cameraMediaFolder(): string {
  const configured = process.env.TOHYEE_CAMERA_MEDIA_DIR?.trim();
  if (configured) return configured;
  if (process.platform === "win32") return path.join(process.env.ProgramData || "C:\\ProgramData", "Tohyee", "camera-media");
  // The ignore hint stops the build's file tracer copying the project into the standalone output (#155).
  return path.join(/* turbopackIgnore: true */ process.cwd(), "camera-media");
}

/** Where uploads are written while they arrive, before they're checked. Inside the media folder, so moving one into place is a rename. */
export function incomingFolder(): string {
  return path.join(/* turbopackIgnore: true */ cameraMediaFolder(), ".incoming");
}

/** A stored file's path relative to the media folder. */
export function storagePathFor(organisationId: string, cameraId: string, receivedAt: Date, sha256: string, extension: "jpg" | "mp4"): string {
  if (!ORGANISATION_ID.test(organisationId) || !/^[1-9]\d{0,17}$/.test(cameraId) || !/^[0-9a-f]{64}$/.test(sha256)) throw new ValidationError("That file can't be stored.");
  const month = receivedAt.toISOString().slice(0, 7);
  return [organisationId, `camera-${cameraId}`, month, `${sha256}.${extension}`].join("/");
}

export function thumbnailPathFor(storagePath: string): string {
  return storagePath.replace(/\.(jpg|mp4)$/, ".thumb.jpg");
}

/**
 * The absolute path of a stored file, refusing anything that would leave
 * the organisation's own folder: the path comes from the database, but it's
 * checked anyway.
 */
export function resolveStored(organisationId: string, storagePath: string): string {
  if (!ORGANISATION_ID.test(organisationId)) throw new ValidationError("Unknown organisation.");
  const root = path.resolve(cameraMediaFolder(), organisationId);
  const full = path.resolve(root, storagePath.startsWith(`${organisationId}/`) ? storagePath.slice(organisationId.length + 1) : storagePath);
  if (!full.startsWith(root + path.sep)) throw new ValidationError("That file isn't in this organisation's media.");
  return full;
}

/** Moves a checked upload into place. The same content from the same camera lands on the same path, so a resend just replaces it with itself. */
export async function moveIntoPlace(tempPath: string, organisationId: string, storagePath: string): Promise<string> {
  const target = resolveStored(organisationId, storagePath);
  await mkdir(path.dirname(target), { recursive: true });
  await rename(tempPath, target);
  return target;
}

/** Deletes a stored file and its thumbnail. Already gone is fine. */
export async function removeStored(organisationId: string, storagePath: string): Promise<void> {
  await rm(resolveStored(organisationId, storagePath), { force: true });
  await rm(resolveStored(organisationId, thumbnailPathFor(storagePath)), { force: true });
}

/** Deletes all of an organisation's camera media (the demo farm, when it's deleted). */
export async function removeOrganisationMedia(organisationId: string): Promise<void> {
  if (!ORGANISATION_ID.test(organisationId)) throw new ValidationError("Unknown organisation.");
  await rm(path.join(/* turbopackIgnore: true */ cameraMediaFolder(), organisationId), { recursive: true, force: true });
}
