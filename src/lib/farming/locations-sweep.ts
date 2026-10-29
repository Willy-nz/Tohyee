import { type Actor, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { deleteExpiredShares } from "@/lib/farming/locations";
import { listOrganisationsForJobs } from "@/lib/organisations/admin";

/*
 * Deletes shared locations whose time is up (#498 item 7, decision 1127),
 * every 10 minutes for every organisation, so a position doesn't wait for
 * someone to open the map before it goes. Always on: it's how the
 * retention promise is kept. No network calls.
 */

const ACTOR: Actor = { userId: null, email: "location sharing clean-up" };
const EVERY_MINUTES = 10;
let running = false;
let timer: NodeJS.Timeout | null = null;

export async function deleteExpiredLocationsEverywhere(): Promise<{ organisations: number; deleted: number }> {
  if (running) return { organisations: 0, deleted: 0 };
  running = true;
  let organisations = 0;
  let deleted = 0;
  try {
    for (const organisation of await listOrganisationsForJobs()) {
      if (!organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") continue;
      organisations += 1;
      try {
        deleted += await withOrganisationTransaction(organisation, ACTOR, (tx) => deleteExpiredShares(tx));
      } catch (error) {
        console.warn(`[tohyee] Deleting expired shared locations failed for ${organisation.id}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return { organisations, deleted };
  } finally {
    running = false;
  }
}

export function startLocationSweep(): void {
  if (timer) return;
  const tick = () => {
    deleteExpiredLocationsEverywhere().catch((error) => console.warn("[tohyee] Shared location clean-up:", error));
  };
  timer = setInterval(tick, EVERY_MINUTES * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 60 * 1000).unref?.();
}
