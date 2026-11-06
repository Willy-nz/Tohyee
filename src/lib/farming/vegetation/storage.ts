import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ValidationError } from "@/lib/errors";

/*
 * Where satellite pictures are kept (#612, decision 1536): files on the
 * server's disk, never in the database. One folder per organisation, then
 * per farm and month. `TOHYEE_VEGETATION_DIR` chooses the folder (a bigger
 * disk, a Docker volume). They can all be fetched again, so they're not in
 * the nightly backup and are removed after the organisation's retention;
 * the numbers worked out from them stay in the database.
 */

const ORGANISATION_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function vegetationFolder(): string {
  const configured = process.env.TOHYEE_VEGETATION_DIR?.trim();
  if (configured) return configured;
  if (process.platform === "win32") return path.join(process.env.ProgramData || "C:\\ProgramData", "Tohyee", "vegetation");
  // The ignore hint stops the build's file tracer copying the project into the standalone output (#155).
  return path.join(/* turbopackIgnore: true */ process.cwd(), "vegetation-imagery");
}

export type PictureKind = "raw" | "overlay" | "change";

/** A picture's path relative to the folder: organisation/farm-N/YYYY-MM/<time>-<kind>.png. */
export function picturePath(organisationId: string, farmId: string, acquiredAt: string, kind: PictureKind): string {
  if (!ORGANISATION_ID.test(organisationId) || !/^[1-9]\d{0,17}$/.test(farmId) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(acquiredAt)) throw new ValidationError("That picture can't be stored.");
  return [organisationId, `farm-${farmId}`, acquiredAt.slice(0, 7), `${acquiredAt.replace(/[-:]/g, "")}-${kind}.png`].join("/");
}

/** The absolute path, refusing anything outside the organisation's own folder. */
export function resolvePicture(organisationId: string, relative: string): string {
  if (!ORGANISATION_ID.test(organisationId)) throw new ValidationError("Unknown organisation.");
  const root = path.resolve(vegetationFolder(), organisationId);
  const full = path.resolve(root, relative.startsWith(`${organisationId}/`) ? relative.slice(organisationId.length + 1) : relative);
  if (!full.startsWith(root + path.sep)) throw new ValidationError("That picture isn't this organisation's.");
  return full;
}

/** Writes a picture whole (a temporary file, then renamed), so a crash never leaves half a file. Returns its SHA-256. */
export async function writePicture(organisationId: string, relative: string, bytes: Uint8Array): Promise<string> {
  const target = resolvePicture(organisationId, relative);
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomBytes(6).toString("hex")}.part`;
  await writeFile(temp, bytes);
  await rename(temp, target);
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readPicture(organisationId: string, relative: string): Promise<Buffer | null> {
  try {
    return await readFile(resolvePicture(organisationId, relative));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function pictureSize(organisationId: string, relative: string): Promise<number | null> {
  try {
    return (await stat(resolvePicture(organisationId, relative))).size;
  } catch {
    return null;
  }
}

/** Removes a picture. Already gone is fine. */
export async function removePicture(organisationId: string, relative: string): Promise<void> {
  await rm(resolvePicture(organisationId, relative), { force: true });
}

/** Whether an error is the disk being full (decision 1534). */
export function isDiskFull(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOSPC" || code === "EDQUOT";
}

/** Deletes all of an organisation's satellite pictures (the demo farm, when it's deleted). */
export async function removeOrganisationPictures(organisationId: string): Promise<void> {
  if (!ORGANISATION_ID.test(organisationId)) throw new ValidationError("Unknown organisation.");
  await rm(path.join(/* turbopackIgnore: true */ vegetationFolder(), organisationId), { recursive: true, force: true });
}
