import { accountingEnabled } from "@/lib/organisations/accounting-switch";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { listAllOrganisations } from "@/lib/organisations/admin";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { REPEATING_BILL_KIND } from "@/lib/repeating/bills";
import { listDueTemplateIds, type RepeatingKind, runTemplates, type ScheduledTemplate } from "@/lib/repeating/runner";
import { REPEATING_INVOICE_KIND } from "@/lib/repeating/service";

/**
 * The repeating invoices and bills job (RI2-RI4, RB2-RB4): every hour, each
 * ready organisation makes the invoices and bills that are due, one template
 * per transaction, so a template that fails doesn't hold back the others. The
 * run history's unique date per template is what stops a date being made
 * twice, so an overlapping run (another server process) or a restart
 * mid-run never duplicates one. Off with
 * TOHYEE_REPEATING_INVOICES_SCHEDULER=off (both kinds). No network calls.
 */
let running = false;

const KINDS: ReadonlyArray<RepeatingKind<ScheduledTemplate>> = [REPEATING_INVOICE_KIND, REPEATING_BILL_KIND];

/**
 * One organisation's due templates of one kind, each in its own transaction.
 * A template that throws is logged and counted as failed; the rest still run.
 */
async function runOrganisationKind(
  organisation: OrganisationRecord,
  kind: RepeatingKind<ScheduledTemplate>,
  today?: string,
): Promise<{ made: number; failed: number }> {
  let made = 0;
  let failed = 0;
  // Paused while Accounting is off (MOD6); the dates missed are made once it's back on.
  const ids = await withOrganisationTransaction(organisation, kind.actor, async (tx) => ((await accountingEnabled(tx)) ? listDueTemplateIds(tx, kind, today) : []));
  for (const id of ids) {
    try {
      const result = await withOrganisationTransaction(organisation, kind.actor, (tx) => runTemplates(tx, kind, { templateId: id, today }));
      made += result.made;
      failed += result.failed;
    } catch (error) {
      failed += 1;
      console.warn(`[tohyee] ${kind.label} ${id} failed for ${organisation.id}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return { made, failed };
}

/** One organisation's due repeating invoices (RI3). */
export function runOrganisationRepeatingInvoices(organisation: OrganisationRecord, today?: string): Promise<{ made: number; failed: number }> {
  return runOrganisationKind(organisation, REPEATING_INVOICE_KIND, today);
}

/** One organisation's due repeating bills (RB4). */
export function runOrganisationRepeatingBills(organisation: OrganisationRecord, today?: string): Promise<{ made: number; failed: number }> {
  return runOrganisationKind(organisation, REPEATING_BILL_KIND, today);
}

export async function runDueRepeatingDocuments(): Promise<{ organisations: number; made: number; failed: number }> {
  if (running) return { organisations: 0, made: 0, failed: 0 };
  running = true;
  let organisations = 0;
  let made = 0;
  let failed = 0;
  try {
    for (const organisation of await listAllOrganisations()) {
      if (!organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") continue;
      organisations += 1;
      for (const kind of KINDS) {
        try {
          const result = await runOrganisationKind(organisation, kind);
          made += result.made;
          failed += result.failed;
        } catch (error) {
          failed += 1;
          console.warn(`[tohyee] Repeating ${kind.documentNoun}s failed for ${organisation.id}: ${error instanceof Error ? error.message : error}`);
        }
      }
    }
    return { organisations, made, failed };
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Checks for due repeating invoices and bills every hour while the server runs, and two minutes after it starts. */
export function startRepeatingInvoiceScheduler(): void {
  if (timer) return;
  const tick = () => {
    runDueRepeatingDocuments().catch((error) => console.warn("[tohyee] Repeating invoice and bill scheduler:", error));
  };
  timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 2 * 60 * 1000).unref?.();
}
