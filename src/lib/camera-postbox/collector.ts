import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { BoxError, type BoxTarget, callBox, CertificateChangedError, downloadFromBox } from "@/lib/camera-postbox/client";
import { displayFingerprint, isQueuedFile, loginsVersion, openSealedFile, type QueuedFile } from "@/lib/camera-postbox/protocol";
import { type ContactReport, currentLogins, type ErrorKind, postboxConnection, recordContact } from "@/lib/camera-postbox/service";
import { type Actor, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { listOrganisationsForJobs } from "@/lib/organisations/admin";
import { getOrganisation, type OrganisationRecord } from "@/lib/organisations/registry";
import { SNIFF_BYTES, sniffMedia } from "@/lib/security-cameras/file-names";
import { ingestUpload } from "@/lib/security-cameras/ingest";
import { incomingFolder } from "@/lib/security-cameras/storage";

/*
 * Collecting from the camera post box (decisions 1230-1231). Every minute,
 * for each organisation with a post box, Tohyee:
 *
 * 1. asks how it is (files waiting, disk space), and pushes the camera
 *    logins if the post box's differ from Tohyee's;
 * 2. downloads each waiting file, opens it with Tohyee's private key, and
 *    checks its size, SHA-256 and that it's a JPEG or MP4;
 * 3. hands it to the same ingest as a direct upload (one event per camera
 *    and SHA-256, the camera's clock, retention);
 * 4. only then tells the post box it has it, and the post box deletes it.
 *
 * If Tohyee stops between 3 and 4, the file is still on the post box; next
 * time it's downloaded again, ingest says "already have it", and it's
 * confirmed. No file is lost and no event is made twice.
 *
 * No network calls inside transactions: the connection is read in one,
 * the post box is called, and what it said is saved in another.
 */

const ACTOR: Actor = { userId: null, email: "camera post box" };
const EVERY_MS = 60_000;
/** One run stops starting new downloads after this, so runs don't pile up. */
const RUN_BUDGET_MS = 50_000;
/** A file that fails this many times in a row is left on the post box (it's reported, not deleted). */
const MAX_ATTEMPTS = 3;

const failedAttempts = new Map<string, number>();
const running = new Set<string>();

export type CollectResult = { collected: number; duplicates: number; discarded: number; failed: number; waiting: number | null; error: { kind: ErrorKind; text: string } | null } | null;

export type CollectOptions = {
  /** For tests: runs after a file is ingested and before the post box is told. Throwing stands in for Tohyee stopping there. */
  beforeConfirm?: (file: QueuedFile) => void | Promise<void>;
  limit?: number;
  now?: () => Date;
};

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function headOf(file: string): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function describe(error: unknown, target: BoxTarget): { kind: ErrorKind; text: string } {
  if (error instanceof CertificateChangedError) {
    return {
      kind: "certificate_changed",
      text: `The post box at ${target.address} has a different security certificate (${displayFingerprint(error.seen).slice(0, 23)}…) from the one Tohyee paired with. Tohyee stopped sending it anything. If you didn't rebuild the post box, someone may be pretending to be it. Pair again with a new code from the post box.`,
    };
  }
  if (error instanceof BoxError) {
    if (error.kind === "token_refused") return { kind: "token_refused", text: `The post box doesn't accept Tohyee's token any more (it may have been reinstalled or paired elsewhere). Pair again. (${error.message})` };
    return { kind: error.kind, text: error.message };
  }
  return { kind: "box_error", text: error instanceof Error ? error.message.slice(0, 300) : "Something went wrong collecting from the post box." };
}

/** Takes one file: download, open, check, ingest, then confirm. Returns what happened. */
async function takeFile(organisation: OrganisationRecord, target: BoxTarget, keys: { publicKey: string; privateKey: string }, file: QueuedFile, options: CollectOptions): Promise<"saved" | "duplicate" | "discarded"> {
  const folder = incomingFolder();
  await mkdir(folder, { recursive: true });
  const sealed = path.join(folder, `${randomUUID()}.sealed`);
  const opened = path.join(folder, `${randomUUID()}.part`);
  try {
    await downloadFromBox(target, file.id, file.storedBytes, sealed);
    await openSealedFile(sealed, opened, keys);
    await rm(sealed, { force: true });
    if ((await sha256Of(opened)) !== file.sha256) throw new Error(`A file from the post box (${file.fileName}) isn't the file it said: its SHA-256 doesn't match.`);
    const media = sniffMedia(await headOf(opened));
    let status: "saved" | "duplicate" | "discarded";
    if (!media) {
      // The post box checks this too; a file that isn't a photo or clip is never kept.
      status = "discarded";
    } else {
      const camera = await withOrganisationTransaction(organisation, ACTOR, (tx) => tx.query<{ id: string; name: string }>("select id::text, name from security_cameras where id = $1 and is_active", [file.cameraId]));
      if (!camera.rows[0]) {
        // Archived (or gone) since it uploaded: a direct upload would be refused too.
        status = "discarded";
      } else {
        const now = options.now?.() ?? new Date();
        const sent = new Date(file.receivedAt);
        const receivedAt = sent.getTime() > now.getTime() ? now : sent;
        const result = await ingestUpload({ organisation, cameraId: camera.rows[0].id, cameraName: camera.rows[0].name }, { name: file.fileName, tempPath: opened, sizeBytes: file.sizeBytes, sha256: file.sha256, media, receivedAt });
        status = result.status === "refused" ? "discarded" : result.status;
      }
    }
    await options.beforeConfirm?.(file);
    try {
      await callBox(target, { method: "POST", path: `/v1/files/${encodeURIComponent(file.id)}/received`, body: { sha256: file.sha256 } });
    } catch (error) {
      // Already gone from the post box (confirmed by an earlier run that stopped before it heard back): that's fine.
      if (!(error instanceof BoxError && error.status === 404)) throw error;
    }
    return status;
  } finally {
    await rm(sealed, { force: true });
    await rm(opened, { force: true });
  }
}

/** One collection for one organisation. Null when it has no post box. */
export async function collectFromPostbox(organisation: OrganisationRecord, options: CollectOptions = {}): Promise<CollectResult> {
  if (running.has(organisation.id)) return null;
  running.add(organisation.id);
  try {
    const setup = await withOrganisationTransaction(organisation, ACTOR, async (tx) => {
      const connection = await postboxConnection(tx);
      return connection ? { connection, logins: await currentLogins(tx) } : null;
    });
    if (!setup) return null;
    const { target, keys } = setup.connection;
    const started = Date.now();
    const report: ContactReport = { collected: 0 };
    const result = { collected: 0, duplicates: 0, discarded: 0, failed: 0, waiting: null as number | null, error: null as { kind: ErrorKind; text: string } | null };
    try {
      const status = await callBox<{ version?: string; logins?: { version?: string } }>(target, { method: "GET", path: "/v1/status" });
      report.boxVersion = typeof status.version === "string" ? status.version.slice(0, 40) : null;
      const wanted = loginsVersion(setup.logins);
      if (status.logins?.version !== wanted) {
        await callBox(target, { method: "PUT", path: "/v1/logins", body: { logins: setup.logins } });
      }
      report.loginsPushedVersion = wanted;
      const listing = await callBox<{ files?: unknown[] }>(target, { method: "GET", path: `/v1/files?limit=${options.limit ?? 50}` });
      const files = (Array.isArray(listing.files) ? listing.files : []).filter(isQueuedFile);
      let lastFailure: string | null = null;
      for (const file of files) {
        if (Date.now() - started > RUN_BUDGET_MS) break;
        const key = `${organisation.id}:${file.id}`;
        if ((failedAttempts.get(key) ?? 0) >= MAX_ATTEMPTS) {
          result.failed += 1;
          continue;
        }
        try {
          const outcome = await takeFile(organisation, target, keys, file, options);
          failedAttempts.delete(key);
          if (outcome === "saved") result.collected += 1;
          else if (outcome === "duplicate") result.duplicates += 1;
          else result.discarded += 1;
        } catch (error) {
          // Losing the connection or the certificate stops the run; a bad file is counted and skipped.
          if (error instanceof CertificateChangedError || (error instanceof BoxError && error.kind !== "box_error")) throw error;
          failedAttempts.set(key, (failedAttempts.get(key) ?? 0) + 1);
          if (failedAttempts.size > 10_000) failedAttempts.delete(failedAttempts.keys().next().value!);
          result.failed += 1;
          lastFailure = error instanceof Error ? error.message : String(error);
          console.warn(`[tohyee] Camera post box file for ${organisation.id} couldn't be taken: ${lastFailure}`);
        }
      }
      const after = await callBox<{ queue?: { files?: number; bytes?: number }; disk?: { freeBytes?: number; totalBytes?: number }; lowDisk?: boolean }>(target, { method: "GET", path: "/v1/status" });
      report.filesWaiting = Number(after.queue?.files ?? 0);
      report.bytesWaiting = Number(after.queue?.bytes ?? 0);
      report.diskFreeBytes = Number(after.disk?.freeBytes ?? 0);
      report.diskTotalBytes = Number(after.disk?.totalBytes ?? 0);
      report.lowDisk = after.lowDisk === true;
      result.waiting = report.filesWaiting;
      report.collected = result.collected;
      report.error = result.failed ? { kind: "file_failed", text: `${result.failed} file${result.failed === 1 ? "" : "s"} on the post box couldn't be taken, so ${result.failed === 1 ? "it stays" : "they stay"} there. Last problem: ${lastFailure ?? "tried too many times"}` } : null;
      result.error = report.error;
    } catch (error) {
      result.error = describe(error, target);
      report.error = result.error;
      report.collected = result.collected;
      console.warn(`[tohyee] Camera post box for ${organisation.id}: ${result.error.text}`);
    }
    await withOrganisationTransaction(organisation, ACTOR, (tx) => recordContact(tx, target.token!, report));
    return result;
  } finally {
    running.delete(organisation.id);
  }
}

export async function collectFromPostboxById(organisationId: string, options: CollectOptions = {}): Promise<CollectResult> {
  const organisation = await getOrganisation(organisationId);
  if (!organisation) return null;
  return collectFromPostbox(organisation, options);
}

let timer: NodeJS.Timeout | null = null;
let ticking = false;

/** Every minute, every organisation that has a post box. Off with TOHYEE_CAMERA_POSTBOX=off. */
export function startPostboxCollector(): void {
  if (timer) return;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      for (const organisation of await listOrganisationsForJobs()) {
        if (organisation.demo || !organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") continue;
        await collectFromPostbox(organisation).catch((error) => console.warn(`[tohyee] Camera post box collection failed for ${organisation.id}:`, error instanceof Error ? error.message : error));
      }
    } catch (error) {
      console.warn("[tohyee] Camera post box collection:", error instanceof Error ? error.message : error);
    } finally {
      ticking = false;
    }
  };
  timer = setInterval(() => void tick(), EVERY_MS);
  timer.unref?.();
  setTimeout(() => void tick(), 90_000).unref?.();
}
