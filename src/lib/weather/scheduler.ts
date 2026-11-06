import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { listOrganisationsForJobs } from "@/lib/organisations/admin";
import { refreshWeather, sweepOldForecasts } from "@/lib/weather/service";

/*
 * The forecast refresh (decision 1544): every 10 minutes, each ready
 * organisation whose forecast is on and due (every 1, 3, 6 or 12 hours, as
 * chosen) is refreshed, and kept forecasts 24 hours old are deleted. An
 * organisation whose refreshing stopped (the spending guard) is skipped
 * until an admin tests the connection again. Off with
 * TOHYEE_WEATHER_SCHEDULER=off (the 24-hour deletion then happens when the
 * forecast is next read, as it's never shown past 24 hours).
 */

export const WEATHER_ACTOR = { userId: null, email: "weather-forecast@tohyee" };

let running = false;

export async function runDueWeatherRefreshes(now = new Date()): Promise<{ organisations: number; refreshed: number; failed: number }> {
  if (running) return { organisations: 0, refreshed: 0, failed: 0 };
  running = true;
  let organisations = 0;
  let refreshed = 0;
  let failed = 0;
  try {
    for (const organisation of await listOrganisationsForJobs()) {
      if (!organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") continue;
      try {
        await withOrganisationTransaction(organisation, WEATHER_ACTOR, (tx) => sweepOldForecasts(tx, now));
        const result = await refreshWeather(organisation, WEATHER_ACTOR, { now });
        if (result.skipped) continue;
        organisations += 1;
        refreshed += result.refreshed;
        failed += result.failed;
      } catch (error) {
        failed += 1;
        console.warn(`[tohyee] Weather forecast refresh failed for ${organisation.id}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return { organisations, refreshed, failed };
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startWeatherScheduler(): void {
  if (timer) return;
  const tick = () => {
    runDueWeatherRefreshes().catch((error) => console.warn("[tohyee] Weather forecast scheduler:", error instanceof Error ? error.message : error));
  };
  timer = setInterval(tick, 10 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 3 * 60 * 1000).unref?.();
}
