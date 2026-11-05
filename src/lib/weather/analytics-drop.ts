import { WEATHER_TABLE } from "@/lib/analytics/farm-weather";

/**
 * Takes the forecast records out of the organisation's analytics file once
 * they may no longer be combined (decision 1549), without waiting for the
 * next daily load (which leaves them out too). Best effort: an organisation
 * without an analytics file has nothing to take out.
 */
export async function dropWeatherAnalytics(organisationId: string): Promise<void> {
  try {
    const { dropTable, listTables } = await import("@/lib/analytics/engine");
    const tables = await listTables(organisationId);
    if (tables.has(WEATHER_TABLE)) await dropTable(organisationId, WEATHER_TABLE);
  } catch (error) {
    console.warn("[tohyee] Couldn't take forecast records out of Analytics:", error instanceof Error ? error.message : error);
  }
}
