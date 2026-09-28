/**
 * Runs once when the server starts, before it accepts requests: brings the
 * core database and every organisation database up to date.
 *
 * - A failed core migration stops the server from starting.
 * - A failed organisation migration only blocks that organisation.
 * - Skipped during `next build`, when DATABASE_URL isn't set, or when
 *   TOHYEE_SKIP_STARTUP_MIGRATIONS=1.
 *
 * Then it starts the bank feed scheduler, which syncs linked Akahu accounts
 * that are due (off with TOHYEE_BANK_FEEDS_SCHEDULER=off).
 *
 * It also starts the Cloudflare Tunnel connector if remote access is turned on
 * (set TOHYEE_REMOTE_ACCESS=off to keep it off, e.g. on a test copy).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return;
  }
  if (process.env.TOHYEE_SKIP_STARTUP_MIGRATIONS === "1") {
    console.log("[tohyee] Skipping startup migrations (TOHYEE_SKIP_STARTUP_MIGRATIONS=1).");
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.warn("[tohyee] DATABASE_URL is not set; skipping database migrations.");
    return;
  }

  const { migrateEverything } = await import("@/lib/db/migrations");
  const result = await migrateEverything();
  if (result.core.applied.length > 0) {
    console.log(`[tohyee] Core database migrated: ${result.core.applied.join(", ")}`);
  }
  for (const organisation of result.organisations) {
    if (!organisation.ok) {
      console.error(
        `[tohyee] Organisation ${organisation.organisationId} could not be upgraded and is blocked: ${organisation.error}`,
      );
    } else if (organisation.applied.length > 0) {
      console.log(
        `[tohyee] Organisation ${organisation.organisationId} migrated: ${organisation.applied.join(", ")}`,
      );
    }
  }

  if (process.env.TOHYEE_BANK_FEEDS_SCHEDULER !== "off") {
    const { startBankFeedScheduler } = await import("@/lib/bank/akahu/sync");
    startBankFeedScheduler();
  }

  if (process.env.TOHYEE_REMOTE_ACCESS !== "off") {
    const { applyRemoteAccess } = await import("@/lib/remote/settings");
    const { stopTunnelOnExit } = await import("@/lib/remote/tunnel");
    stopTunnelOnExit();
    try {
      await applyRemoteAccess();
    } catch (error) {
      console.warn("[tohyee] Remote access couldn't start:", error instanceof Error ? error.message : error);
    }
  }
}
