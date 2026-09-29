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
 * Before that it opens the local-only address for server settings
 * (127.0.0.1, TOHYEE_ADMIN_PORT; "off" turns it off).
 *
 * And the CRM mail sync, which syncs connected Gmail and Microsoft 365
 * mailboxes every 15 minutes (off with TOHYEE_MAIL_SYNC_SCHEDULER=off).
 *
 * And the repeating invoices job, which makes due invoices every hour
 * (off with TOHYEE_REPEATING_INVOICES_SCHEDULER=off).
 *
 * And the backup scheduler, which backs up every organisation each night
 * (off with TOHYEE_BACKUP_SCHEDULER=off; the time and folder are server settings).
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
  // Server settings open only from this computer (see src/lib/server-admin/local.ts).
  if (process.env.TOHYEE_ADMIN_PORT !== "off") {
    const { startLocalAdminListener } = await import("@/lib/server-admin/listener");
    startLocalAdminListener();
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

  if (process.env.TOHYEE_MAIL_SYNC_SCHEDULER !== "off") {
    const { startMailScheduler } = await import("@/lib/crm/mail/service");
    startMailScheduler();
  }

  if (process.env.TOHYEE_REPEATING_INVOICES_SCHEDULER !== "off") {
    const { startRepeatingInvoiceScheduler } = await import("@/lib/repeating/scheduler");
    startRepeatingInvoiceScheduler();
  }

  if (process.env.TOHYEE_BACKUP_SCHEDULER !== "off") {
    const { startBackupScheduler } = await import("@/lib/backups/scheduler");
    startBackupScheduler();
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
