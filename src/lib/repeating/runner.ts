import { writeAuditEvent } from "@/lib/audit";
import { todayIsoDate } from "@/lib/dates";
import type { Actor, OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, HttpError, NotFoundError, ValidationError } from "@/lib/errors";
import { datesBetween, type RepeatPeriod } from "@/lib/repeating/schedule";
import { optionalId, requireId, requireOneOf } from "@/lib/validation";

/**
 * The scheduler shared by repeating invoices (RI1-RI10) and repeating bills
 * (RB1-RB10), like NetSuite's memorized transactions: one set of rules for
 * when a template makes its documents, and a `RepeatingKind` for each
 * document type that says how to make and approve one.
 *
 * - Each scheduled date up to today not yet made is made once, oldest first
 *   (catch-up). A row in the kind's runs table per date, unique on
 *   (template, date), and the template row locked while it runs, mean
 *   running twice, or two runs at once, never make a date twice.
 * - "Approve" approves each document as a person would; a refused approval
 *   leaves the draft and records why in the history.
 * - If a document can't be made at all, the template keeps the error and
 *   stops at that date until the next run.
 * - Pause stops it; resume carries on from the resume date (dates while it
 *   was paused aren't made); end is final. A template past its end date with
 *   every date made ends itself.
 */
export const REPEATING_STATUSES = ["active", "paused", "ended"] as const;
export type RepeatingStatus = (typeof REPEATING_STATUSES)[number];
export const SAVE_AS = ["draft", "approve"] as const;
export type SaveAs = (typeof SAVE_AS)[number];
export type RunOutcome = "draft" | "approved" | "approval_refused";
export type RunResult = { made: number; approved: number; refused: number; failed: number };

/** At most this many dates are made per template in one run (the rest next run). */
const MAX_DATES_PER_RUN = 60;

/** What the scheduler needs from any template. `runs` is newest first. */
export type ScheduledTemplate = {
  id: string;
  status: RepeatingStatus;
  period: RepeatPeriod;
  every: number;
  startDate: string;
  endDate: string | null;
  resumedFrom: string | null;
  saveAs: SaveAs;
  lastError: string | null;
  nextDate: string | null;
  runs: ReadonlyArray<{ scheduledDate: string }>;
};

export type RepeatingKind<T extends ScheduledTemplate> = {
  table: "repeating_invoices" | "repeating_bills";
  runsTable: "repeating_invoice_runs" | "repeating_bill_runs";
  templateColumn: "repeating_invoice_id" | "repeating_bill_id";
  documentColumn: "invoice_id" | "bill_id";
  /** The audit trail's entity type, and the start of its event names ("repeating_invoice"). */
  entityType: "repeating_invoice" | "repeating_bill";
  /** "repeating invoice" */
  label: string;
  /** "invoice" */
  documentNoun: string;
  /** Who the background job acts as. */
  actor: Actor;
  get(tx: OrgTx, id: string): Promise<T>;
  /** Makes the draft document for `date`, the template's `sequence`th (from 1); returns its id. */
  make(tx: OrgTx, template: T, date: string, sequence: number): Promise<string>;
  /** Approves it; returns a note for the history (e.g. a credit limit warning), or null. */
  approve(tx: OrgTx, template: T, date: string, documentId: string): Promise<string | null>;
};

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The day after a YYYY-MM-DD date. */
function dayAfter(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** The first date still to be made: after the last one made, and not before a resume (RI7). */
export function firstPending(template: { startDate: string; resumedFrom: string | null; lastRun: string | null }): string {
  let from = template.startDate;
  if (template.resumedFrom && template.resumedFrom > from) from = template.resumedFrom;
  if (template.lastRun) {
    const after = dayAfter(template.lastRun);
    if (after > from) from = after;
  }
  return from;
}

export function parseWhole(input: unknown, field: string, min: number, max: number): number {
  const value = typeof input === "string" && /^\d{1,3}$/.test(input.trim()) ? Number(input.trim()) : input;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${field} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

/** Loads a template and locks it until the transaction ends. */
export async function lockTemplate<T extends ScheduledTemplate>(tx: OrgTx, kind: RepeatingKind<T>, id: string): Promise<T> {
  const locked = await tx.query(`select id from ${kind.table} where id = $1 for update`, [id]);
  if (locked.rowCount === 0) throw new NotFoundError(`${capitalised(kind.label)} not found.`);
  return kind.get(tx, id);
}

export function assertNotEnded(kind: { label: string }, template: ScheduledTemplate): void {
  if (template.status === "ended") {
    throw new ConflictError(`This ${kind.label} has ended, so it can't be changed. Save a new one instead.`);
  }
}

/**
 * When a template is changed: if how often or the first date changed on a
 * template that has made something, dates before today under the new
 * schedule aren't made (RI8).
 */
export function resumedAfterChange(
  current: ScheduledTemplate,
  next: { period: RepeatPeriod; every: number; startDate: string },
  today: string,
): { scheduleChanged: boolean; resumedFrom: string | null } {
  const scheduleChanged = next.period !== current.period || next.every !== current.every || next.startDate !== current.startDate;
  const resumedFrom =
    scheduleChanged && current.runs.length > 0 ? (current.resumedFrom && current.resumedFrom > today ? current.resumedFrom : today) : current.resumedFrom;
  return { scheduleChanged, resumedFrom };
}

/**
 * Pauses, resumes or ends a template (RI7, RB8). Paused and ended templates
 * make nothing. Resuming doesn't make the dates that fell while it was
 * paused. Ending is final.
 */
export async function setTemplateStatus<T extends ScheduledTemplate>(
  tx: OrgTx,
  kind: RepeatingKind<T>,
  id: string,
  statusInput: unknown,
  today = todayIsoDate(),
): Promise<T> {
  const status = requireOneOf(statusInput, "status", REPEATING_STATUSES);
  const current = await lockTemplate(tx, kind, id);
  assertNotEnded(kind, current);
  if (current.status === status) return current;
  const resumedFrom = status === "active" ? today : current.resumedFrom;
  await tx.query(`update ${kind.table} set status = $2, resumed_from = $3, updated_at = now() where id = $1`, [current.id, status, resumedFrom]);
  await writeAuditEvent(tx, {
    eventType: `${kind.entityType}.${status === "active" ? "resumed" : status}`,
    entityType: kind.entityType,
    entityId: current.id,
    details: { from: current.status, to: status },
  });
  return kind.get(tx, current.id);
}

function reason(kind: { documentNoun: string }, error: unknown): string {
  return (error instanceof HttpError ? error.message : `Something went wrong making this ${kind.documentNoun}; see the server log.`).slice(0, 1000);
}

/** Active templates with a date that may be due by `today`, for the job to run one at a time. */
export async function listDueTemplateIds(tx: OrgTx, kind: RepeatingKind<ScheduledTemplate>, today = todayIsoDate()): Promise<string[]> {
  const due = await tx.query<{ id: string }>(`select id from ${kind.table} where status = 'active' and start_date <= $1 order by id`, [today]);
  return due.rows.map((row) => row.id);
}

/**
 * Makes the documents that are due: for each active template (or just
 * `templateId`), every scheduled date up to `today` that hasn't been made yet,
 * oldest first. See the notes at the top of this file.
 */
export async function runTemplates<T extends ScheduledTemplate>(
  tx: OrgTx,
  kind: RepeatingKind<T>,
  options: { today?: string; templateId?: unknown; idField?: string } = {},
): Promise<RunResult> {
  const today = options.today ?? todayIsoDate();
  const only = optionalId(options.templateId, options.idField ?? "id");
  const result: RunResult = { made: 0, approved: 0, refused: 0, failed: 0 };
  const due = await tx.query<{ id: string }>(
    `select id from ${kind.table} where status = 'active' and start_date <= $1 and ($2::bigint is null or id = $2) order by id`,
    [today, only],
  );
  const noun = capitalised(kind.label);
  for (const { id } of due.rows) {
    // Locking the template makes two runs take turns, and the second sees the first's dates as made (RI3, RB4).
    await tx.query(`select id from ${kind.table} where id = $1 for update`, [id]);
    const template = await kind.get(tx, id);
    if (template.status !== "active") continue;
    const from = firstPending({ startDate: template.startDate, resumedFrom: template.resumedFrom, lastRun: template.runs[0]?.scheduledDate ?? null });
    const dates = datesBetween(
      { period: template.period, every: template.every, startDate: template.startDate, endDate: template.endDate },
      from,
      today,
      MAX_DATES_PER_RUN,
    );
    let sequence = template.runs.length;
    let lastError: string | null = null;
    for (const date of dates) {
      await tx.query("savepoint repeating_date");
      let documentId: string;
      try {
        documentId = await kind.make(tx, template, date, sequence + 1);
        await tx.query("release savepoint repeating_date");
      } catch (error) {
        await tx.query("rollback to savepoint repeating_date");
        if (!(error instanceof HttpError)) console.warn(`[tohyee] ${noun} ${template.id} on ${date}:`, error);
        lastError = `${date}: ${reason(kind, error)}`;
        result.failed += 1;
        break;
      }
      sequence += 1;
      let outcome: RunOutcome = "draft";
      let message: string | null = null;
      if (template.saveAs === "approve") {
        await tx.query("savepoint repeating_approve");
        try {
          message = await kind.approve(tx, template, date, documentId);
          await tx.query("release savepoint repeating_approve");
          outcome = "approved";
          result.approved += 1;
        } catch (error) {
          await tx.query("rollback to savepoint repeating_approve");
          if (!(error instanceof HttpError)) console.warn(`[tohyee] ${noun} ${template.id} approval on ${date}:`, error);
          outcome = "approval_refused";
          message = `Left as a draft: ${reason(kind, error)}`.slice(0, 1000);
          result.refused += 1;
        }
      }
      await tx.query(
        `insert into ${kind.runsTable} (${kind.templateColumn}, scheduled_date, ${kind.documentColumn}, outcome, message, created_by_email)
         values ($1, $2, $3, $4, $5, $6)`,
        [template.id, date, documentId, outcome, message, tx.actor.email],
      );
      await writeAuditEvent(tx, {
        eventType: `${kind.entityType}.${kind.documentNoun}_made`,
        entityType: kind.entityType,
        entityId: template.id,
        details: { scheduledDate: date, [`${kind.documentNoun}Id`]: documentId, outcome, ...(message ? { message } : {}) },
      });
      result.made += 1;
    }
    if (lastError !== null || (template.lastError !== null && dates.length > 0)) {
      await tx.query(
        `update ${kind.table} set last_error = $2, last_error_at = case when $2::text is null then null else now() end, updated_at = now() where id = $1`,
        [template.id, lastError],
      );
      if (lastError) {
        await writeAuditEvent(tx, { eventType: `${kind.entityType}.failed`, entityType: kind.entityType, entityId: template.id, details: { error: lastError } });
      }
    }
    // Past the end date with every date made: the template ends itself.
    if (lastError === null && template.endDate !== null && template.endDate <= today) {
      const after = await kind.get(tx, template.id);
      if (after.nextDate === null) {
        await tx.query(`update ${kind.table} set status = 'ended', updated_at = now() where id = $1`, [template.id]);
        await writeAuditEvent(tx, { eventType: `${kind.entityType}.ended`, entityType: kind.entityType, entityId: template.id, details: { reason: "end date reached" } });
      }
    }
  }
  return result;
}

/** The template and date that made a document, if any (RI2, RB1). */
export async function templateForDocument(
  tx: OrgTx,
  kind: RepeatingKind<ScheduledTemplate>,
  documentId: string,
): Promise<{ id: string; scheduledDate: string } | null> {
  const found = await tx.query<{ id: string; scheduled_date: string }>(
    `select ${kind.templateColumn} as id, scheduled_date from ${kind.runsTable} where ${kind.documentColumn} = $1`,
    [requireId(documentId, "id")],
  );
  const row = found.rows[0];
  return row ? { id: row.id, scheduledDate: row.scheduled_date } : null;
}
