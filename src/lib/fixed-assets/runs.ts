import { parseAccountCodeInput } from "@/lib/accounts/service";
import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import {
  disposalFigures,
  type DisposalFigures,
  isMonthEnd,
  lastMonthBeforeDisposal,
  monthEnd,
  monthOf,
  type PlannedSegment,
  planDepreciation,
} from "@/lib/fixed-assets/depreciation";
import {
  type AssetState,
  accumulatedOf,
  basisOf,
  type FixedAsset,
  getFixedAsset,
  getFixedAssetSettings,
  loadAssetStates,
  lockRegister,
} from "@/lib/fixed-assets/service";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { getJournal, parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { assertPostingDateAllowed } from "@/lib/ledger/period-controls";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, cmp, dec, type Decimal, isZero, parseDecimalInput, sum, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { trackingKey, type TrackingTags } from "@/lib/tracking/service";
import { optionalSource, requireId, requireIdempotencyKey } from "@/lib/validation";

/**
 * Depreciation runs and disposals (examples FA3-FA12). A run to a month end
 * works out each registered asset's depreciation for the months since it was
 * last charged and posts one journal: Dr depreciation expense / Cr
 * accumulated depreciation, one pair per asset type and set of tracking tags.
 * Runs go forward one month end after another; the latest can be rolled back
 * with the exact reversal (on its own date). A disposal posts depreciation up
 * to it, takes the cost and accumulated depreciation off, clears the proceeds
 * and posts the gain or loss; it can be undone with the exact reversal.
 */

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function longDate(date: string): string {
  return `${Number(date.slice(8, 10))} ${MONTH_NAMES[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

export function runReference(periodEnd: string): string {
  return `DEP-${periodEnd.slice(0, 7)}`;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

export type RunLine = {
  assetId: string;
  assetNumber: string;
  assetName: string;
  typeName: string;
  fromMonth: string;
  toMonth: string;
  months: number;
  amount: string;
};

export type JournalPreviewLine = { accountCode: string; debitAmount: string; creditAmount: string; description: string; tracking: TrackingTags };

export type DepreciationRun = {
  id: string;
  reference: string;
  periodEnd: string;
  status: "active" | "rolled_back";
  total: string;
  journalId: string | null;
  rollbackJournalId: string | null;
  createdByEmail: string | null;
  createdAt: string;
  rolledBackByEmail: string | null;
  rolledBackAt: string | null;
  lines: RunLine[];
};

type RunRow = {
  id: string;
  period_end: string;
  status: "active" | "rolled_back";
  total: string;
  journal_id: string | null;
  rollback_journal_id: string | null;
  created_by_email: string | null;
  created_at: string;
  rolled_back_by_email: string | null;
  rolled_back_at: string | null;
};

const RUN_SELECT = `select id::text, period_end, status, total::text, journal_id::text, rollback_journal_id::text, created_by_email, created_at,
       rolled_back_by_email, rolled_back_at from fixed_asset_depreciation_runs`;

async function runLines(tx: OrgTx, runIds: string[], scale: number): Promise<Map<string, RunLine[]>> {
  const found = await tx.query<{
    run_id: string;
    asset_id: string;
    asset_number: string;
    name: string;
    type_name: string;
    from_month: string;
    to_month: string;
    months: number;
    amount: string;
  }>(
    `select l.run_id::text, l.asset_id::text, f.asset_number, f.name, t.name as type_name, l.from_month, l.to_month, l.months, l.amount::text
       from fixed_asset_depreciation_lines l join fixed_assets f on f.id = l.asset_id join fixed_asset_types t on t.id = f.type_id
      where l.run_id = any($1::bigint[]) order by f.asset_number, l.from_month`,
    [runIds],
  );
  const byRun = new Map<string, RunLine[]>();
  for (const row of found.rows) {
    const list = byRun.get(row.run_id) ?? [];
    list.push({
      assetId: row.asset_id,
      assetNumber: row.asset_number,
      assetName: row.name,
      typeName: row.type_name,
      fromMonth: monthOf(row.from_month),
      toMonth: monthOf(row.to_month),
      months: row.months,
      amount: toFixedString(dec(row.amount), scale),
    });
    byRun.set(row.run_id, list);
  }
  return byRun;
}

function toRun(row: RunRow, lines: RunLine[], scale: number): DepreciationRun {
  return {
    id: row.id,
    reference: runReference(row.period_end),
    periodEnd: row.period_end,
    status: row.status,
    total: toFixedString(dec(row.total), scale),
    journalId: row.journal_id,
    rollbackJournalId: row.rollback_journal_id,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    rolledBackByEmail: row.rolled_back_by_email,
    rolledBackAt: row.rolled_back_at,
    lines,
  };
}

export async function getDepreciationRun(tx: OrgTx, idInput: unknown): Promise<DepreciationRun> {
  const id = requireId(idInput, "runId");
  const scale = currencyMinorUnits(tx.baseCurrency);
  const found = await tx.query<RunRow>(`${RUN_SELECT} where id = $1`, [id]);
  if (!found.rows[0]) throw new NotFoundError("Depreciation run not found.");
  return toRun(found.rows[0], (await runLines(tx, [id], scale)).get(id) ?? [], scale);
}

/** Runs, newest first, with their lines. */
export async function listDepreciationRuns(tx: OrgTx): Promise<DepreciationRun[]> {
  const scale = currencyMinorUnits(tx.baseCurrency);
  const found = await tx.query<RunRow>(`${RUN_SELECT} order by period_end desc, id desc limit 120`);
  const lines = await runLines(tx, found.rows.map((row) => row.id), scale);
  return found.rows.map((row) => toRun(row, lines.get(row.id) ?? [], scale));
}

async function latestActiveRun(tx: OrgTx): Promise<string | null> {
  const found = await tx.query<{ period_end: string | null }>("select max(period_end) as period_end from fixed_asset_depreciation_runs where status = 'active'");
  return found.rows[0]?.period_end ?? null;
}

type Planned = { asset: AssetState; segments: PlannedSegment[]; amount: Decimal };

/** Groups depreciation into journal lines: Dr expense / Cr accumulated depreciation per asset type and set of tags, by type name. */
function depreciationJournalLines(planned: Planned[], scale: number, label: string): JournalPreviewLine[] {
  const groups = new Map<string, { typeName: string; expense: string; accumulated: string; tracking: TrackingTags; amount: Decimal }>();
  for (const entry of planned) {
    if (isZero(entry.amount)) continue;
    const { asset } = entry;
    const key = `${asset.typeName}\u0000${asset.typeId}|${asset.expenseAccountCode}|${asset.accumulatedAccountCode}|${trackingKey(asset.tracking)}`;
    const group = groups.get(key) ?? {
      typeName: asset.typeName,
      expense: asset.expenseAccountCode,
      accumulated: asset.accumulatedAccountCode,
      tracking: asset.tracking,
      amount: ZERO_DECIMAL,
    };
    group.amount = add(group.amount, entry.amount);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .flatMap(([, group]) => {
      const amount = toFixedString(group.amount, scale);
      const description = `${label} - ${group.typeName}`.slice(0, 200);
      return [
        { accountCode: group.expense, debitAmount: amount, creditAmount: "0.00", description, tracking: group.tracking },
        { accountCode: group.accumulated, debitAmount: "0.00", creditAmount: amount, description, tracking: group.tracking },
      ];
    });
}

export type RunPreview = {
  periodEnd: string;
  /** The latest active run's period end, if any. */
  lastRunPeriodEnd: string | null;
  lines: RunLine[];
  total: string;
  journalLines: JournalPreviewLine[];
};

function parsePeriodEnd(input: unknown): string {
  const periodEnd = parseIsoDate(input, "periodEnd");
  if (!isMonthEnd(periodEnd)) throw new ValidationError("Depreciation is run to a month end, e.g. 2026-06-30.");
  return periodEnd;
}

async function planRun(tx: OrgTx, periodEnd: string): Promise<{ preview: RunPreview; planned: Planned[] }> {
  const settings = await getFixedAssetSettings(tx);
  const scale = currencyMinorUnits(tx.baseCurrency);
  const lastRunPeriodEnd = await latestActiveRun(tx);
  if (lastRunPeriodEnd !== null && periodEnd <= lastRunPeriodEnd) {
    throw new ValidationError(`Depreciation has already been run to ${longDate(lastRunPeriodEnd)}. Run it to a later month end, or roll that run back first.`);
  }
  // Decision 337: not past the end of this month, so this year's figures don't
  // include depreciation for months that haven't happened.
  const thisMonthEnd = monthEnd(monthOf(todayIsoDate()));
  if (periodEnd > thisMonthEnd) {
    throw new ValidationError(`Depreciation can be run up to the end of this month (${longDate(thisMonthEnd)}), not to ${longDate(periodEnd)}.`);
  }
  const assets = await loadAssetStates(tx, { status: "registered" });
  const planned = assets
    .map((asset) => {
      const segments = planDepreciation(basisOf(asset, settings.firstMonth), asset.charged, monthOf(periodEnd), settings.financialYearEndMonth, scale);
      return { asset, segments, amount: sum(segments.map((segment) => dec(segment.amount))) };
    })
    .filter((entry) => entry.segments.length > 0);
  const lines = planned.flatMap(({ asset, segments }) =>
    segments.map((segment) => ({
      assetId: asset.id,
      assetNumber: asset.assetNumber,
      assetName: asset.name,
      typeName: asset.typeName,
      fromMonth: segment.fromMonth,
      toMonth: segment.toMonth,
      months: segment.months,
      amount: segment.amount,
    })),
  );
  const total = toFixedString(sum(planned.map((entry) => entry.amount)), scale);
  return {
    preview: { periodEnd, lastRunPeriodEnd, lines, total, journalLines: depreciationJournalLines(planned, scale, `Depreciation to ${longDate(periodEnd)}`) },
    planned,
  };
}

/** What a run to `periodEnd` would post (FA3), without posting it. */
export async function previewDepreciationRun(tx: OrgTx, periodEndInput: unknown): Promise<RunPreview> {
  return (await planRun(tx, parsePeriodEnd(periodEndInput))).preview;
}

/**
 * Runs depreciation to a month end (bookkeepers; FA3-FA7, FA12): after the
 * latest active run, in an open period. Posts one journal on the period end
 * (none if there's nothing to charge) and records each asset's months.
 */
export async function runDepreciation(
  tx: OrgTx,
  command: { source?: unknown; idempotencyKey: unknown; periodEnd: unknown },
): Promise<{ created: boolean; run: DepreciationRun }> {
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const periodEnd = parsePeriodEnd(command.periodEnd);
  const hash = requestHash("fixed_asset_depreciation_run", { periodEnd });
  const replay = async () => {
    const earlier = await tx.query<{ id: string; request_hash: string }>(
      "select id::text, request_hash from fixed_asset_depreciation_runs where command_source = $1 and idempotency_key = $2",
      [source, idempotencyKey],
    );
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].request_hash, hash, "depreciation run");
    return { created: false, run: await getDepreciationRun(tx, earlier.rows[0].id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  await lockRegister(tx);
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;
  await assertPostingDateAllowed(tx, periodEnd);
  const { preview, planned } = await planRun(tx, periodEnd);
  const next = await tx.query<{ id: string }>("select nextval(pg_get_serial_sequence('fixed_asset_depreciation_runs', 'id'))::text as id");
  const runId = next.rows[0].id;
  let journalId: string | null = null;
  if (preview.journalLines.length > 0) {
    const posted = await postJournalBody(
      tx,
      "fixed_asset_depreciation:run",
      runId,
      parseJournalBody(tx, {
        postingDate: periodEnd,
        reference: runReference(periodEnd),
        description: `Depreciation to ${longDate(periodEnd)}`,
        lines: preview.journalLines,
      }),
      { origin: "fixed_asset_depreciation" },
    );
    journalId = posted.journal.id;
  }
  try {
    await tx.query(
      `insert into fixed_asset_depreciation_runs (id, command_source, idempotency_key, request_hash, period_end, total, journal_id,
                                                  created_by_user_id, created_by_email)
       values ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9)`,
      [runId, source, idempotencyKey, hash, periodEnd, preview.total, journalId, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`Depreciation has already been run to ${longDate(periodEnd)}.`);
    throw error;
  }
  for (const { asset, segments } of planned) {
    for (const segment of segments) {
      await tx.query(
        `insert into fixed_asset_depreciation_lines (run_id, asset_id, financial_year_start, from_month, to_month, months, amount)
         values ($1, $2, $3, $4, $5, $6, $7::numeric)`,
        [runId, asset.id, segment.financialYearStart, `${segment.fromMonth}-01`, `${segment.toMonth}-01`, segment.months, segment.amount],
      );
    }
  }
  await writeAuditEvent(tx, {
    eventType: "fixed_asset_depreciation.run",
    entityType: "fixed_asset_depreciation_run",
    entityId: runId,
    details: { periodEnd, total: preview.total, journalId, assets: planned.length },
  });
  return { created: true, run: await getDepreciationRun(tx, runId) };
}

/**
 * Rolls back the latest active run (bookkeepers; FA5, FA11): posts the exact
 * reversal of its journal on its own date (which must be open), and its
 * months count again for the next run. Refused for an earlier run, or while
 * an asset it depreciated has an active disposal.
 */
export async function rollBackDepreciationRun(
  tx: OrgTx,
  idInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown },
): Promise<{ created: boolean; run: DepreciationRun }> {
  const id = requireId(idInput, "runId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const hash = requestHash("fixed_asset_depreciation_rollback", { id });
  const replay = async () => {
    const earlier = await tx.query<{ id: string; hash: string }>(
      "select id::text, rollback_request_hash as hash from fixed_asset_depreciation_runs where rollback_command_source = $1 and rollback_idempotency_key = $2",
      [source, idempotencyKey],
    );
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].hash, hash, "rollback");
    return { created: false, run: await getDepreciationRun(tx, earlier.rows[0].id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  await lockRegister(tx);
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;
  const run = await getDepreciationRun(tx, id);
  if (run.status === "rolled_back") throw new ConflictError(`The run to ${run.periodEnd} has already been rolled back.`);
  const latest = await latestActiveRun(tx);
  if (latest !== run.periodEnd) throw new ConflictError(`Only the latest run can be rolled back. Roll back the run to ${latest} first.`);
  const blocking = await tx.query<{ asset_number: string }>(
    `select distinct f.asset_number from fixed_asset_depreciation_lines l
       join fixed_asset_disposals d on d.asset_id = l.asset_id and d.status = 'active'
       join fixed_assets f on f.id = l.asset_id
      where l.run_id = $1 order by f.asset_number`,
    [id],
  );
  if (blocking.rows[0]) {
    throw new ConflictError(`Undo the disposal of ${blocking.rows.map((row) => row.asset_number).join(", ")} first: it was worked out from this run.`);
  }
  let rollbackJournalId: string | null = null;
  if (run.journalId) {
    const original = await getJournal(tx, run.journalId);
    const posted = await postJournalBody(
      tx,
      "fixed_asset_depreciation:rollback",
      id,
      parseJournalBody(tx, {
        postingDate: run.periodEnd,
        reference: `VOID-${original.reference}`.slice(0, 100),
        description: `Rollback of depreciation to ${longDate(run.periodEnd)}`,
        lines: original.lines.map((line) => ({
          accountCode: line.accountCode,
          debitAmount: line.creditAmount,
          creditAmount: line.debitAmount,
          description: line.description,
          tracking: line.tracking,
        })),
      }),
      { origin: "fixed_asset_depreciation", relatedJournalId: original.id, correctionKind: "reversal" },
    );
    rollbackJournalId = posted.journal.id;
  } else {
    await assertPostingDateAllowed(tx, run.periodEnd);
  }
  try {
    await tx.query(
      `update fixed_asset_depreciation_runs
          set status = 'rolled_back', rollback_journal_id = $2, rollback_command_source = $3, rollback_idempotency_key = $4, rollback_request_hash = $5,
              rolled_back_by_user_id = $6, rolled_back_by_email = $7, rolled_back_at = now()
        where id = $1`,
      [id, rollbackJournalId, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("That idempotency key was already used for a different rollback. Use a new key.");
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "fixed_asset_depreciation.rolled_back",
    entityType: "fixed_asset_depreciation_run",
    entityId: id,
    details: { periodEnd: run.periodEnd, journalId: rollbackJournalId },
  });
  return { created: true, run: await getDepreciationRun(tx, id) };
}

// ---------------------------------------------------------------------------
// Disposals

export type DisposalPreview = DisposalFigures & {
  assetId: string;
  assetNumber: string;
  disposalDate: string;
  /** Depreciation this disposal charges, for the months since the asset was last charged. */
  depreciation: string;
  depreciationLines: Array<{ fromMonth: string; toMonth: string; months: number; amount: string }>;
  journalLines: JournalPreviewLine[];
};

type DisposalInput = {
  disposalDate: string;
  proceeds: string;
  proceedsAccountCode: string | null;
  gainLossAccountCode: string | null;
  capitalGainAccountCode: string | null;
};

function parseDisposalInput(command: Record<string, unknown>, scale: number): DisposalInput {
  const proceeds =
    command.proceeds == null || command.proceeds === ""
      ? toFixedString(ZERO_DECIMAL, scale)
      : toFixedString(dec(parseDecimalInput(command.proceeds, "The proceeds (excluding GST)", { maxScale: scale, allowZero: true })), scale);
  const code = (value: unknown, field: string) => (value == null || value === "" ? null : parseAccountCodeInput(value, field));
  return {
    disposalDate: parseIsoDate(command.disposalDate, "disposalDate"),
    proceeds,
    proceedsAccountCode: code(command.proceedsAccountCode, "proceedsAccountCode"),
    gainLossAccountCode: code(command.gainLossAccountCode, "gainLossAccountCode"),
    capitalGainAccountCode: code(command.capitalGainAccountCode, "capitalGainAccountCode"),
  };
}

type AccountCheck = { id: string; code: string; name: string; account_class: string; account_type: string; system_key: string | null; currency_code: string | null; is_active: boolean };

async function accountByCode(tx: OrgTx, code: string, label: string): Promise<AccountCheck> {
  const found = await tx.query<AccountCheck>(
    "select id::text, code, name, account_class, account_type, system_key, currency_code, is_active from accounts where lower(code) = lower($1)",
    [code],
  );
  const account = found.rows[0];
  if (!account) throw new ValidationError(`${label}: there's no account with the code ${code}.`);
  if (!account.is_active) throw new ValidationError(`${label}: account ${account.code} (${account.name}) is archived.`);
  if (account.currency_code !== null && account.currency_code !== tx.baseCurrency) {
    throw new ValidationError(`${label}: account ${account.code} (${account.name}) is in ${account.currency_code}; disposals are in the base currency.`);
  }
  return account;
}

async function systemAccountCode(tx: OrgTx, systemKey: string, label: string): Promise<string> {
  const found = await tx.query<{ code: string }>("select code from accounts where system_key = $1", [systemKey]);
  if (!found.rows[0]) throw new ValidationError(`No account is set up for ${label}. Choose one.`);
  return found.rows[0].code;
}

const CONTROL_KEYS = new Set(["accounts_receivable", "accounts_payable", "expense_claims_payable", "gst", "inventory"]);

/** The accounts a disposal posts to (FA8): proceeds cleared from any account but bank, card and control accounts; gains and losses to income or expense accounts. */
async function disposalAccounts(tx: OrgTx, input: DisposalInput): Promise<{ proceeds: AccountCheck | null; gainLoss: AccountCheck; capitalGain: AccountCheck }> {
  let proceeds: AccountCheck | null = null;
  if (cmp(dec(input.proceeds), ZERO_DECIMAL) > 0) {
    if (!input.proceedsAccountCode) {
      throw new ValidationError("Choose the account the sale was coded to (proceedsAccountCode), so the proceeds are cleared from it.");
    }
    proceeds = await accountByCode(tx, input.proceedsAccountCode, "Proceeds account");
    if (proceeds.account_type === "bank" || proceeds.account_type === "credit_card" || (proceeds.system_key && CONTROL_KEYS.has(proceeds.system_key))) {
      throw new ValidationError(
        `Proceeds account: account ${proceeds.code} (${proceeds.name}) can't be used. Code the sale (an invoice or receive money) to an account, then clear it from that account here.`,
      );
    }
  } else if (input.proceedsAccountCode) {
    throw new ValidationError("A write-off has no proceeds, so it has no proceeds account.");
  }
  const profitAndLoss = async (code: string, label: string) => {
    const account = await accountByCode(tx, code, label);
    if (account.account_class !== "revenue" && account.account_class !== "expense") {
      throw new ValidationError(`${label}: account ${account.code} (${account.name}) isn't an income or expense account.`);
    }
    return account;
  };
  const gainLoss = await profitAndLoss(input.gainLossAccountCode ?? (await systemAccountCode(tx, "fixed_asset_disposal", "gains and losses on disposals")), "Gain or loss account");
  const capitalGain = await profitAndLoss(
    input.capitalGainAccountCode ?? (await systemAccountCode(tx, "fixed_asset_capital_gain", "capital gains on disposals")),
    "Capital gain account",
  );
  return { proceeds, gainLoss, capitalGain };
}

async function planDisposal(
  tx: OrgTx,
  assetId: string,
  input: DisposalInput,
  accounts: { proceeds: AccountCheck | null; gainLoss: AccountCheck; capitalGain: AccountCheck } | null,
): Promise<{ preview: DisposalPreview; asset: AssetState; segments: PlannedSegment[] }> {
  const settings = await getFixedAssetSettings(tx);
  const scale = currencyMinorUnits(tx.baseCurrency);
  const [asset] = await loadAssetStates(tx, { assetId });
  if (!asset) throw new NotFoundError("Fixed asset not found.");
  if (asset.status !== "registered") throw new ConflictError(`${asset.assetNumber} is ${asset.status}, so it can't be disposed of.`);
  if (input.disposalDate < asset.purchaseDate) throw new ValidationError(`The disposal date can't be before ${asset.assetNumber} was bought (${asset.purchaseDate}).`);
  if (asset.openingDate && input.disposalDate <= asset.openingDate) {
    throw new ValidationError(`The disposal date must be after ${asset.assetNumber}'s opening balance date (${asset.openingDate}).`);
  }
  const latest = await latestActiveRun(tx);
  if (latest && input.disposalDate <= latest) {
    throw new ValidationError(`Depreciation has been run to ${latest}, so the disposal must be after it. Roll that run back first to dispose of it earlier.`);
  }
  const segments = planDepreciation(
    basisOf(asset, settings.firstMonth),
    asset.charged,
    lastMonthBeforeDisposal(input.disposalDate, settings.disposalMonth),
    settings.financialYearEndMonth,
    scale,
  );
  const depreciation = sum(segments.map((segment) => dec(segment.amount)));
  const accumulated = add(dec(accumulatedOf(asset)), depreciation);
  const figures = disposalFigures(asset.cost, toFixedString(accumulated, scale), input.proceeds, scale);
  const journalLines: JournalPreviewLine[] = [];
  const line = (accountCode: string, side: "debit" | "credit", amount: string, description: string) => {
    if (isZero(dec(amount))) return;
    journalLines.push({
      accountCode,
      debitAmount: side === "debit" ? amount : "0.00",
      creditAmount: side === "credit" ? amount : "0.00",
      description,
      tracking: asset.tracking,
    });
  };
  const label = `${asset.assetNumber} ${asset.name}`.slice(0, 150);
  const fixed = (value: Decimal) => toFixedString(value, scale);
  line(asset.expenseAccountCode, "debit", fixed(depreciation), `Depreciation to disposal - ${label}`);
  line(asset.accumulatedAccountCode, "credit", fixed(depreciation), `Depreciation to disposal - ${label}`);
  line(asset.accumulatedAccountCode, "debit", figures.accumulatedDepreciation, `Accumulated depreciation - ${label}`);
  line(asset.assetAccountCode, "credit", figures.cost, `Cost - ${label}`);
  if (accounts) {
    if (accounts.proceeds) line(accounts.proceeds.code, "debit", figures.proceeds, `Proceeds - ${label}`);
    line(accounts.gainLoss.code, "credit", figures.depreciationRecovered, `Depreciation recovered - ${label}`);
    line(accounts.capitalGain.code, "credit", figures.capitalGain, `Capital gain - ${label}`);
    line(accounts.gainLoss.code, "debit", figures.loss, `Loss on disposal - ${label}`);
  }
  return {
    preview: {
      ...figures,
      assetId: asset.id,
      assetNumber: asset.assetNumber,
      disposalDate: input.disposalDate,
      depreciation: fixed(depreciation),
      depreciationLines: segments.map((segment) => ({ fromMonth: segment.fromMonth, toMonth: segment.toMonth, months: segment.months, amount: segment.amount })),
      journalLines,
    },
    asset,
    segments,
  };
}

/** What disposing of an asset would post (FA8), without posting it. */
export async function previewDisposal(tx: OrgTx, assetIdInput: unknown, command: Record<string, unknown>): Promise<DisposalPreview> {
  const assetId = requireId(assetIdInput, "assetId");
  const input = parseDisposalInput(command, currencyMinorUnits(tx.baseCurrency));
  const accounts = await disposalAccounts(tx, input);
  return (await planDisposal(tx, assetId, input, accounts)).preview;
}

/**
 * Sells or writes off an asset (bookkeepers; FA8-FA10, FA12). On the
 * disposal date it posts: depreciation since it was last charged (the
 * disposal month by the organisation's setting), Dr accumulated depreciation
 * / Cr cost to take it off, Dr the proceeds (excluding GST) out of the
 * account the sale was coded to, and the difference: Cr depreciation
 * recovered and capital gain, or Dr the loss.
 */
export async function disposeFixedAsset(
  tx: OrgTx,
  assetIdInput: unknown,
  command: Record<string, unknown> & { source?: unknown; idempotencyKey: unknown },
): Promise<{ created: boolean; asset: FixedAsset }> {
  const assetId = requireId(assetIdInput, "assetId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const scale = currencyMinorUnits(tx.baseCurrency);
  const input = parseDisposalInput(command, scale);
  const hash = requestHash("fixed_asset_disposal", {
    assetId,
    ...input,
    proceedsAccountCode: input.proceedsAccountCode?.toLowerCase() ?? null,
    gainLossAccountCode: input.gainLossAccountCode?.toLowerCase() ?? null,
    capitalGainAccountCode: input.capitalGainAccountCode?.toLowerCase() ?? null,
  });
  const replay = async () => {
    const earlier = await tx.query<{ asset_id: string; request_hash: string }>(
      "select asset_id::text, request_hash from fixed_asset_disposals where command_source = $1 and idempotency_key = $2",
      [source, idempotencyKey],
    );
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].request_hash, hash, "disposal");
    return { created: false, asset: await getFixedAsset(tx, earlier.rows[0].asset_id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  await lockRegister(tx);
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;
  const accounts = await disposalAccounts(tx, input);
  await assertPostingDateAllowed(tx, input.disposalDate);
  const { preview, asset, segments } = await planDisposal(tx, assetId, input, accounts);
  const next = await tx.query<{ id: string }>("select nextval(pg_get_serial_sequence('fixed_asset_disposals', 'id'))::text as id");
  const disposalId = next.rows[0].id;
  const kind = isZero(dec(preview.proceeds)) ? "Write-off" : "Disposal";
  const posted = await postJournalBody(
    tx,
    "fixed_asset_disposal:dispose",
    disposalId,
    parseJournalBody(tx, {
      postingDate: input.disposalDate,
      reference: asset.assetNumber,
      description: `${kind} of ${asset.assetNumber} ${asset.name}`.slice(0, 500),
      lines: preview.journalLines,
    }),
    { origin: "fixed_asset_disposal" },
  );
  try {
    await tx.query(
      `insert into fixed_asset_disposals (id, command_source, idempotency_key, request_hash, asset_id, disposal_date, proceeds, proceeds_account_id,
                                          gain_loss_account_id, capital_gain_account_id, cost, depreciation, accumulated_depreciation,
                                          depreciation_recovered, capital_gain, loss, journal_id, created_by_user_id, created_by_email)
       values ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10, $11::numeric, $12::numeric, $13::numeric, $14::numeric, $15::numeric, $16::numeric,
               $17, $18, $19)`,
      [
        disposalId,
        source,
        idempotencyKey,
        hash,
        asset.id,
        input.disposalDate,
        preview.proceeds,
        accounts.proceeds?.id ?? null,
        accounts.gainLoss.id,
        accounts.capitalGain.id,
        preview.cost,
        preview.depreciation,
        preview.accumulatedDepreciation,
        preview.depreciationRecovered,
        preview.capitalGain,
        preview.loss,
        posted.journal.id,
        tx.actor.userId,
        tx.actor.email,
      ],
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`${asset.assetNumber} has already been disposed of.`);
    throw error;
  }
  for (const segment of segments) {
    await tx.query(
      `insert into fixed_asset_depreciation_lines (disposal_id, asset_id, financial_year_start, from_month, to_month, months, amount)
       values ($1, $2, $3, $4, $5, $6, $7::numeric)`,
      [disposalId, asset.id, segment.financialYearStart, `${segment.fromMonth}-01`, `${segment.toMonth}-01`, segment.months, segment.amount],
    );
  }
  await tx.query("update fixed_assets set status = 'disposed', updated_at = now() where id = $1", [asset.id]);
  await writeAuditEvent(tx, {
    eventType: "fixed_asset.disposed",
    entityType: "fixed_asset",
    entityId: asset.id,
    details: {
      disposalId,
      disposalDate: input.disposalDate,
      proceeds: preview.proceeds,
      bookValue: preview.bookValue,
      loss: preview.loss,
      depreciationRecovered: preview.depreciationRecovered,
      capitalGain: preview.capitalGain,
      journalId: posted.journal.id,
    },
  });
  return { created: true, asset: await getFixedAsset(tx, asset.id) };
}

/**
 * Undoes an asset's disposal (bookkeepers; FA11): posts the exact reversal of
 * its journal on the disposal date (which must be open), and the asset is
 * registered again, depreciated to where it was before.
 */
export async function undoDisposal(
  tx: OrgTx,
  assetIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown },
): Promise<{ created: boolean; asset: FixedAsset }> {
  const assetId = requireId(assetIdInput, "assetId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const hash = requestHash("fixed_asset_disposal_undo", { assetId });
  const replay = async () => {
    const earlier = await tx.query<{ asset_id: string; hash: string }>(
      "select asset_id::text, undo_request_hash as hash from fixed_asset_disposals where undo_command_source = $1 and undo_idempotency_key = $2",
      [source, idempotencyKey],
    );
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].hash, hash, "undo");
    return { created: false, asset: await getFixedAsset(tx, earlier.rows[0].asset_id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  await lockRegister(tx);
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;
  const asset = await getFixedAsset(tx, assetId);
  const disposal = asset.disposals.find((entry) => entry.status === "active");
  if (!disposal) throw new ConflictError(`${asset.assetNumber} hasn't been disposed of, so there's nothing to undo.`);
  const original = await getJournal(tx, disposal.journalId);
  const posted = await postJournalBody(
    tx,
    "fixed_asset_disposal:undo",
    disposal.id,
    parseJournalBody(tx, {
      postingDate: disposal.disposalDate,
      reference: `VOID-${original.reference}`.slice(0, 100),
      description: `Undo of the disposal of ${asset.assetNumber} ${asset.name}`.slice(0, 500),
      lines: original.lines.map((line) => ({
        accountCode: line.accountCode,
        debitAmount: line.creditAmount,
        creditAmount: line.debitAmount,
        description: line.description,
        tracking: line.tracking,
      })),
    }),
    { origin: "fixed_asset_disposal", relatedJournalId: original.id, correctionKind: "reversal" },
  );
  try {
    await tx.query(
      `update fixed_asset_disposals
          set status = 'undone', undo_journal_id = $2, undo_command_source = $3, undo_idempotency_key = $4, undo_request_hash = $5,
              undone_by_user_id = $6, undone_by_email = $7, undone_at = now()
        where id = $1`,
      [disposal.id, posted.journal.id, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("That idempotency key was already used for a different undo. Use a new key.");
    throw error;
  }
  await tx.query("update fixed_assets set status = 'registered', updated_at = now() where id = $1", [asset.id]);
  await writeAuditEvent(tx, {
    eventType: "fixed_asset.disposal_undone",
    entityType: "fixed_asset",
    entityId: asset.id,
    details: { disposalId: disposal.id, disposalDate: disposal.disposalDate, journalId: posted.journal.id },
  });
  return { created: true, asset: await getFixedAsset(tx, asset.id) };
}
