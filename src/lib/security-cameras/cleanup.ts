import { type Actor, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { listOrganisationsForJobs } from "@/lib/organisations/admin";
import { expireEvents } from "@/lib/security-cameras/events";
import { removeStored } from "@/lib/security-cameras/storage";

/*
 * The camera media clean-up (#508, decision 1222): every hour, for every
 * organisation, events older than their farm's retention that aren't kept
 * are removed, and then their files. Rows go first (in a transaction that
 * commits), files after: a file that can't be removed is logged and left,
 * never an event pointing at nothing. Like the shared-location clean-up
 * (#498), it keeps a promise, so it runs unless TOHYEE_CAMERA_CLEANUP=off.
 * No network calls.
 */

const ACTOR: Actor = { userId: null, email: "camera media clean-up" };
const EVERY_MINUTES = 60;
let running = false;
let timer: NodeJS.Timeout | null = null;

export async function expireCameraMediaEverywhere(now = new Date()): Promise<{ organisations: number; removed: number }> {
  if (running) return { organisations: 0, removed: 0 };
  running = true;
  let organisations = 0;
  let removed = 0;
  try {
    for (const organisation of await listOrganisationsForJobs()) {
      if (!organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") continue;
      organisations += 1;
      try {
        // In batches, so a long-unattended server catches up without one huge transaction.
        for (let round = 0; round < 100; round += 1) {
          const gone = await withOrganisationTransaction(organisation, ACTOR, (tx) => expireEvents(tx, now));
          for (const media of gone) {
            await removeStored(organisation.id, media.storagePath).catch((error) => console.warn(`[tohyee] Couldn't remove expired camera media for ${organisation.id}: ${error instanceof Error ? error.message : error}`));
          }
          removed += gone.length;
          if (gone.length === 0) break;
        }
      } catch (error) {
        console.warn(`[tohyee] Camera media clean-up failed for ${organisation.id}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return { organisations, removed };
  } finally {
    running = false;
  }
}

export function startCameraCleanup(): void {
  if (timer) return;
  const tick = () => {
    expireCameraMediaEverywhere().catch((error) => console.warn("[tohyee] Camera media clean-up:", error));
  };
  timer = setInterval(tick, EVERY_MINUTES * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 3 * 60 * 1000).unref?.();
}
