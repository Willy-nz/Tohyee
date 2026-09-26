import { writeAuditEvent } from "@/lib/audit";
import { parseOptionalIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";

export type PeriodControls = {
  lockDate: string | null;
  unlockStart: string | null;
  unlockEnd: string | null;
  updatedAt: string;
};

type ControlsRow = {
  lock_date: string | null;
  unlock_start: string | null;
  unlock_end: string | null;
  updated_at: string;
};

function toControls(row: ControlsRow): PeriodControls {
  return {
    lockDate: row.lock_date,
    unlockStart: row.unlock_start,
    unlockEnd: row.unlock_end,
    updatedAt: row.updated_at,
  };
}

export async function getPeriodControls(tx: OrgTx): Promise<PeriodControls> {
  const result = await tx.query<ControlsRow>(
    "select lock_date, unlock_start, unlock_end, updated_at from accounting_period_controls where id = true",
  );
  return toControls(result.rows[0]);
}

/**
 * Postings dated on or before the lock date are rejected, unless they fall
 * inside the explicit unlock window. Dates are compared as YYYY-MM-DD strings,
 * which sort the same way as the dates themselves.
 */
export async function assertPostingDateAllowed(tx: OrgTx, postingDate: string): Promise<void> {
  const controls = await getPeriodControls(tx);
  if (!controls.lockDate || postingDate > controls.lockDate) {
    return;
  }
  const inUnlockWindow =
    controls.unlockStart !== null &&
    controls.unlockEnd !== null &&
    postingDate >= controls.unlockStart &&
    postingDate <= controls.unlockEnd;
  if (!inUnlockWindow) {
    throw new ValidationError(
      `${postingDate} is in a locked period (locked up to ${controls.lockDate}). Use a later date, or ask an admin to open an unlock window.`,
    );
  }
}

export async function updatePeriodControls(
  tx: OrgTx,
  input: { lockDate?: unknown; unlockStart?: unknown; unlockEnd?: unknown },
): Promise<PeriodControls> {
  const current = await getPeriodControls(tx);
  const has = (key: string) => Object.prototype.hasOwnProperty.call(input, key);
  const lockDate = has("lockDate") ? parseOptionalIsoDate(input.lockDate, "lockDate") : current.lockDate;
  const unlockStart = has("unlockStart")
    ? parseOptionalIsoDate(input.unlockStart, "unlockStart")
    : current.unlockStart;
  const unlockEnd = has("unlockEnd") ? parseOptionalIsoDate(input.unlockEnd, "unlockEnd") : current.unlockEnd;

  if ((unlockStart === null) !== (unlockEnd === null)) {
    throw new ValidationError("Set both ends of the unlock window, or neither.");
  }
  if (unlockStart !== null && unlockEnd !== null && unlockStart > unlockEnd) {
    throw new ValidationError("The unlock window must start on or before it ends.");
  }
  if (unlockStart !== null && lockDate === null) {
    throw new ValidationError("An unlock window only makes sense when there is a lock date.");
  }

  const result = await tx.query<ControlsRow>(
    `update accounting_period_controls
        set lock_date = $1, unlock_start = $2, unlock_end = $3, updated_at = now()
      where id = true
      returning lock_date, unlock_start, unlock_end, updated_at`,
    [lockDate, unlockStart, unlockEnd],
  );
  await writeAuditEvent(tx, {
    eventType: "ledger.period_controls_updated",
    entityType: "accounting_period_controls",
    entityId: "1",
    details: {
      from: { lockDate: current.lockDate, unlockStart: current.unlockStart, unlockEnd: current.unlockEnd },
      to: { lockDate, unlockStart, unlockEnd },
    },
  });
  return toControls(result.rows[0]);
}
