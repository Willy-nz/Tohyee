/**
 * Runs once when the server starts, before it accepts requests: brings the
 * core database and every organisation database up to date.
 *
 * - A failed core migration stops the server from starting.
 * - A failed organisation migration only blocks that organisation.
 * - Skipped during `next build`, when DATABASE_URL isn't set, or when
 *   TOEYEE_SKIP_STARTUP_MIGRATIONS=1.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return;
  }
  if (process.env.TOEYEE_SKIP_STARTUP_MIGRATIONS === "1") {
    console.log("[toeyee] Skipping startup migrations (TOEYEE_SKIP_STARTUP_MIGRATIONS=1).");
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.warn("[toeyee] DATABASE_URL is not set; skipping database migrations.");
    return;
  }

  const { migrateEverything } = await import("@/lib/db/migrations");
  const result = await migrateEverything();
  if (result.core.applied.length > 0) {
    console.log(`[toeyee] Core database migrated: ${result.core.applied.join(", ")}`);
  }
  for (const organisation of result.organisations) {
    if (!organisation.ok) {
      console.error(
        `[toeyee] Organisation ${organisation.organisationId} could not be upgraded and is blocked: ${organisation.error}`,
      );
    } else if (organisation.applied.length > 0) {
      console.log(
        `[toeyee] Organisation ${organisation.organisationId} migrated: ${organisation.applied.join(", ")}`,
      );
    }
  }
}
