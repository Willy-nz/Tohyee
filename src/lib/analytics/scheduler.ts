import { localParts } from "@/lib/backups/service";
import type { Actor } from "@/lib/db/org-transaction";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { organisationSourceFolder } from "@/lib/analytics/folders";
import { BOOKS_TABLE_NAME, refreshBooks } from "@/lib/analytics/books";
import { type LoadRun, runLoad } from "@/lib/analytics/sources";
import { getOrganisation } from "@/lib/organisations/registry";

/**
 * The nightly reload (decision 357): each source set to reload daily is
 * loaded once a day after LOAD_TIME (business time), after the nightly
 * backups; a scheduled load that failed is tried again an hour later.
 */
export const LOAD_TIME = "04:00";
const RETRY_AFTER_MS = 60 * 60 * 1000;

export const SCHEDULE_ACTOR: Actor = { userId: null, email: "analytics-loader@tohyee" };

type Recent = { status: string; trigger: string; startedAt: Date };

/** Whether a source's daily load is due now, given its loads in the last two days. */
export function loadDue(now: Date, runs: Recent[], loadTime = LOAD_TIME): boolean {
  const today = localParts(now);
  if (today.time < loadTime) return false;
  const sinceLoadTime = runs.filter((run) => {
    const at = localParts(run.startedAt);
    return at.date === today.date && at.time >= loadTime;
  });
  if (sinceLoadTime.some((run) => run.status === "ok" || run.status === "running")) return false;
  const lastTry = sinceLoadTime
    .filter((run) => run.trigger === "schedule")
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
  return !lastTry || now.getTime() - lastTry.startedAt.getTime() >= RETRY_AFTER_MS;
}

let running = false;

/** Loads whatever is due across every organisation with analytics on. Returns what it did. */
export async function runDueLoads(now = new Date()): Promise<LoadRun[]> {
  if (running) return [];
  running = true;
  const made: LoadRun[] = [];
  try {
    const organisations = await coreQuery<{ id: string }>(
      "select id from organisations where is_active and provisioning_status = 'ready' and migration_status = 'current' order by id",
    );
    for (const { id } of organisations.rows) {
      const hasFolder = Boolean(await organisationSourceFolder(id));
      const organisation = await getOrganisation(id);
      if (!organisation) continue;
      try {
        const due = await withOrganisationTransaction(
          organisation,
          SCHEDULE_ACTOR,
          async (tx) => {
            const enabled = await tx.query<{ on: boolean }>("select analytics_enabled as on from organisation_settings where id = true");
            if (!enabled.rows[0]?.on) return [];
            // The books are copied for every organisation with Analytics on; CSV sources need a folder.
            const sources = hasFolder
              ? await tx.query<{ id: string }>("select id::text from analytics_sources where reload_daily order by id")
              : { rows: [] as Array<{ id: string }> };
            const books = await tx.query<{ status: string; trigger: string; started_at: Date }>(
              `select status, trigger, started_at from analytics_load_runs
                where source_id is null and table_name = $1 and started_at > now() - interval '2 days'`,
              [BOOKS_TABLE_NAME],
            );
            const booksDue = loadDue(
              now,
              books.rows.map((run) => ({ status: run.status, trigger: run.trigger, startedAt: new Date(run.started_at) })),
            );
            const runs = await tx.query<{ source_id: string; status: string; trigger: string; started_at: Date }>(
              `select source_id::text, status, trigger, started_at from analytics_load_runs
                where source_id is not null and started_at > now() - interval '2 days'`,
            );
            const due: string[] = booksDue ? ["books"] : [];
            return due.concat(sources.rows
              .map((source) => source.id)
              .filter((sourceId) =>
                loadDue(
                  now,
                  runs.rows
                    .filter((run) => run.source_id === sourceId)
                    .map((run) => ({ status: run.status, trigger: run.trigger, startedAt: new Date(run.started_at) })),
                ),
              ));
          },
          { readOnly: true },
        );
        for (const sourceId of due) {
          try {
            const run =
              sourceId === "books" ? await refreshBooks(organisation, SCHEDULE_ACTOR, "schedule") : await runLoad(organisation, SCHEDULE_ACTOR, sourceId, "schedule");
            made.push(run);
            if (run.status === "failed") console.warn(`[tohyee] Analytics load of ${run.sourceName} (${id}) failed: ${run.error}`);
          } catch (error) {
            console.warn(`[tohyee] Analytics load (${id}):`, error instanceof Error ? error.message : error);
          }
        }
      } catch (error) {
        console.warn(`[tohyee] Analytics scheduler (${id}):`, error instanceof Error ? error.message : error);
      }
    }
    return made;
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Checks every 5 minutes whether any daily load is due, while the server runs. */
export function startAnalyticsScheduler(): void {
  if (timer) return;
  const tick = () => {
    runDueLoads().catch((error) => console.warn("[tohyee] Analytics scheduler:", error instanceof Error ? error.message : error));
  };
  timer = setInterval(tick, 5 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 3 * 60 * 1000).unref?.();
}
