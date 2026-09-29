import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { listAllOrganisations } from "@/lib/organisations/admin";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { listDueRepeatingInvoiceIds, REPEATING_ACTOR, runRepeatingInvoices } from "@/lib/repeating/service";

/**
 * The repeating invoices job (RI2-RI4): every hour, each ready organisation
 * makes the invoices that are due, one template per transaction, so a
 * template that fails doesn't hold back the others. The run history's unique
 * date per template is what stops a date being made twice, so an overlapping
 * run (another server process) or a restart mid-run never duplicates one.
 * Off with TOHYEE_REPEATING_INVOICES_SCHEDULER=off. No network calls.
 */
let running = false;

/**
 * One organisation's due templates, each in its own transaction. A template
 * that throws is logged and counted as failed; the rest still run.
 */
export async function runOrganisationRepeatingInvoices(
  organisation: OrganisationRecord,
  today?: string,
): Promise<{ made: number; failed: number }> {
  let made = 0;
  let failed = 0;
  const ids = await withOrganisationTransaction(organisation, REPEATING_ACTOR, (tx) => listDueRepeatingInvoiceIds(tx, today));
  for (const id of ids) {
    try {
      const result = await withOrganisationTransaction(organisation, REPEATING_ACTOR, (tx) =>
        runRepeatingInvoices(tx, { repeatingInvoiceId: id, today }),
      );
      made += result.made;
      failed += result.failed;
    } catch (error) {
      failed += 1;
      console.warn(`[tohyee] Repeating invoice ${id} failed for ${organisation.id}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return { made, failed };
}

export async function runDueRepeatingInvoices(): Promise<{ organisations: number; made: number; failed: number }> {
  if (running) return { organisations: 0, made: 0, failed: 0 };
  running = true;
  let organisations = 0;
  let made = 0;
  let failed = 0;
  try {
    for (const organisation of await listAllOrganisations()) {
      if (!organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") continue;
      try {
        const result = await runOrganisationRepeatingInvoices(organisation);
        organisations += 1;
        made += result.made;
        failed += result.failed;
      } catch (error) {
        failed += 1;
        console.warn(`[tohyee] Repeating invoices failed for ${organisation.id}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return { organisations, made, failed };
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Checks for due repeating invoices every hour while the server runs, and two minutes after it starts. */
export function startRepeatingInvoiceScheduler(): void {
  if (timer) return;
  const tick = () => {
    runDueRepeatingInvoices().catch((error) => console.warn("[tohyee] Repeating invoice scheduler:", error));
  };
  timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 2 * 60 * 1000).unref?.();
}
