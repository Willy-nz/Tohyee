/**
 * npm run db:migrate
 *
 * Migrates the core database, then every organisation database. The server
 * also does this on startup; this script is for development and for checking
 * an upgrade by hand.
 */
import { closeAllPools } from "@/lib/db/pools";
import { migrateEverything } from "@/lib/db/migrations";

async function main() {
  const result = await migrateEverything();
  console.log(
    result.core.applied.length > 0
      ? `core: applied ${result.core.applied.join(", ")}`
      : `core: up to date (${result.core.version})`,
  );
  let failed = 0;
  for (const organisation of result.organisations) {
    if (!organisation.ok) {
      failed += 1;
      console.error(`${organisation.organisationId}: FAILED - ${organisation.error}`);
    } else {
      console.log(
        `${organisation.organisationId}: ${
          organisation.applied.length > 0 ? `applied ${organisation.applied.join(", ")}` : "up to date"
        }`,
      );
    }
  }
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeAllPools());
