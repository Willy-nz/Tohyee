import { parseAccountCodeInput } from "@/lib/accounts/service";
import type { AccountClass, AccountType } from "@/lib/accounts/types";
import { writeAuditEvent } from "@/lib/audit";
import { parseOptionalIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import {
  type AssetBasis,
  type ChargedSegment,
  type DepreciationMethod,
  DEPRECIATION_METHODS,
  type DisposalMonthRule,
  firstDepreciationMonth,
  type FirstMonthRule,
  isMonthEnd,
  monthEnd,
  monthOf,
} from "@/lib/fixed-assets/depreciation";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, cmp, dec, parseDecimalInput, sub, sum, toFixedString, toPlainString } from "@/lib/money/decimal";
import { checkNewTags, loadTrackingContext, parseTrackingInput, sortedTags, type TrackingTags } from "@/lib/tracking/service";
import { optionalSource, optionalString, requireId, requireIdempotencyKey, requireOneOf, requireString } from "@/lib/validation";

/**
 * Fixed assets (examples FA1-FA14), like Xero's fixed asset register: asset
 * types (which accounts, and a default method and rate), assets (registered
 * from a bill line or typed in, optionally with opening accumulated
 * depreciation), and the organisation's settings for part months.
 * Registering, changing and archiving assets posts nothing; depreciation runs
 * and disposals (./runs) post. Tohyee has no built-in IRD rates: the rate and
 * method are whatever the organisation types in.
 */

export type FixedAssetSettings = {
  /** full_month: the month an asset is bought counts in full; next_month: depreciation starts the month after (FA7). */
  firstMonth: FirstMonthRule;
  /** include: the disposal month is depreciated in full; exclude: it isn't (FA8). */
  disposalMonth: DisposalMonthRule;
  financialYearEndMonth: number;
};

export async function getFixedAssetSettings(tx: OrgTx): Promise<FixedAssetSettings> {
  const found = await tx.query<{ fixed_asset_first_month: FirstMonthRule; fixed_asset_disposal_month: DisposalMonthRule; financial_year_end_month: number }>(
    "select fixed_asset_first_month, fixed_asset_disposal_month, financial_year_end_month from organisation_settings where id = true",
  );
  const row = found.rows[0];
  return { firstMonth: row.fixed_asset_first_month, disposalMonth: row.fixed_asset_disposal_month, financialYearEndMonth: row.financial_year_end_month };
}

/**
 * Changes how part months are counted (admins; FA7, FA8). It only affects
 * depreciation worked out from now on: what's been posted stays.
 */
export async function updateFixedAssetSettings(tx: OrgTx, input: { firstMonth?: unknown; disposalMonth?: unknown }): Promise<FixedAssetSettings> {
  await lockRegister(tx);
  const current = await getFixedAssetSettings(tx);
  const firstMonth = input.firstMonth === undefined ? current.firstMonth : requireOneOf(input.firstMonth, "firstMonth", ["full_month", "next_month"] as const);
  const disposalMonth =
    input.disposalMonth === undefined ? current.disposalMonth : requireOneOf(input.disposalMonth, "disposalMonth", ["include", "exclude"] as const);
  await tx.query("update organisation_settings set fixed_asset_first_month = $1, fixed_asset_disposal_month = $2, updated_at = now() where id = true", [
    firstMonth,
    disposalMonth,
  ]);
  await writeAuditEvent(tx, {
    eventType: "fixed_asset.settings_updated",
    entityType: "organisation_settings",
    entityId: tx.organisationId,
    details: { firstMonth, disposalMonth, before: { firstMonth: current.firstMonth, disposalMonth: current.disposalMonth } },
  });
  return { ...current, firstMonth, disposalMonth };
}

/**
 * Registering, changing, running and disposing all take this lock (the
 * settings row, as filing a GST return does), so runs and disposals are
 * worked out one at a time and never from a stale picture.
 */
export async function lockRegister(tx: OrgTx): Promise<void> {
  await tx.query("select 1 from organisation_settings where id = true for update");
}

// ---------------------------------------------------------------------------
// Asset types

export type FixedAssetType = {
  id: string;
  name: string;
  assetAccountCode: string;
  assetAccountName: string;
  accumulatedDepreciationAccountCode: string;
  accumulatedDepreciationAccountName: string;
  depreciationExpenseAccountCode: string;
  depreciationExpenseAccountName: string;
  method: DepreciationMethod;
  /** Annual %, e.g. "30"; null for no depreciation. */
  rate: string | null;
  isArchived: boolean;
  assetCount: number;
};

type TypeRow = {
  id: string;
  name: string;
  asset_code: string;
  asset_name: string;
  accum_code: string;
  accum_name: string;
  expense_code: string;
  expense_name: string;
  method: DepreciationMethod;
  rate: string | null;
  archived_at: string | null;
  asset_count: string;
};

const TYPE_SELECT = `select t.id::text, t.name, aa.code as asset_code, aa.name as asset_name, ad.code as accum_code, ad.name as accum_name,
       ae.code as expense_code, ae.name as expense_name, t.method, t.rate::text, t.archived_at,
       (select count(*) from fixed_assets f where f.type_id = t.id and f.status <> 'archived')::text as asset_count
  from fixed_asset_types t
  join accounts aa on aa.id = t.asset_account_id
  join accounts ad on ad.id = t.accumulated_depreciation_account_id
  join accounts ae on ae.id = t.depreciation_expense_account_id`;

function toType(row: TypeRow): FixedAssetType {
  return {
    id: row.id,
    name: row.name,
    assetAccountCode: row.asset_code,
    assetAccountName: row.asset_name,
    accumulatedDepreciationAccountCode: row.accum_code,
    accumulatedDepreciationAccountName: row.accum_name,
    depreciationExpenseAccountCode: row.expense_code,
    depreciationExpenseAccountName: row.expense_name,
    method: row.method,
    rate: row.rate === null ? null : toPlainString(dec(row.rate)),
    isArchived: row.archived_at !== null,
    assetCount: Number(row.asset_count),
  };
}

export async function listFixedAssetTypes(tx: OrgTx, options: { includeArchived?: unknown } = {}): Promise<FixedAssetType[]> {
  const all = options.includeArchived === true || options.includeArchived === "true";
  const found = await tx.query<TypeRow>(`${TYPE_SELECT} where ($1 or t.archived_at is null) order by lower(t.name), t.id`, [all]);
  return found.rows.map(toType);
}

export async function getFixedAssetType(tx: OrgTx, idInput: unknown): Promise<FixedAssetType> {
  const id = requireId(idInput, "typeId");
  const found = await tx.query<TypeRow>(`${TYPE_SELECT} where t.id = $1`, [id]);
  if (!found.rows[0]) throw new NotFoundError("Asset type not found.");
  return toType(found.rows[0]);
}

type AccountRow = {
  id: string;
  code: string;
  name: string;
  account_class: AccountClass;
  account_type: AccountType;
  system_key: string | null;
  currency_code: string | null;
  is_active: boolean;
};

async function findAccount(tx: OrgTx, code: string, label: string): Promise<AccountRow> {
  const found = await tx.query<AccountRow>(
    "select id::text, code, name, account_class, account_type, system_key, currency_code, is_active from accounts where lower(code) = lower($1)",
    [code],
  );
  const account = found.rows[0];
  if (!account) throw new ValidationError(`${label}: there's no account with the code ${code}.`);
  if (!account.is_active) throw new ValidationError(`${label}: account ${account.code} (${account.name}) is archived.`);
  if (account.currency_code !== null && account.currency_code !== tx.baseCurrency) {
    throw new ValidationError(`${label}: account ${account.code} (${account.name}) is in ${account.currency_code}; fixed assets are in the base currency.`);
  }
  return account;
}

/** The asset and accumulated depreciation accounts are fixed or non-current asset accounts not used by Tohyee for anything else (FA1). */
function assertAssetSideAccount(account: AccountRow, label: string): void {
  if ((account.account_type !== "fixed_asset" && account.account_type !== "non_current_asset") || account.system_key !== null) {
    throw new ValidationError(`${label}: account ${account.code} (${account.name}) isn't a fixed asset account. Choose a fixed or non-current asset account.`);
  }
}

type TypeInput = {
  name: string;
  assetAccountCode: string;
  accumulatedDepreciationAccountCode: string;
  depreciationExpenseAccountCode: string;
  method: DepreciationMethod;
  rate: string | null;
};

function parseMethodAndRate(methodInput: unknown, rateInput: unknown): { method: DepreciationMethod; rate: string | null } {
  const method = requireOneOf(methodInput, "method", DEPRECIATION_METHODS);
  if (method === "none") {
    if (rateInput != null && rateInput !== "") throw new ValidationError("An asset with no depreciation has no rate.");
    return { method, rate: null };
  }
  if (rateInput == null || rateInput === "") throw new ValidationError("The depreciation rate is required (the annual %, e.g. 30).");
  const rate = parseDecimalInput(rateInput, "The depreciation rate", { maxScale: 4 });
  if (cmp(dec(rate), dec("100")) > 0) throw new ValidationError("The depreciation rate is a % of at most 100.");
  return { method, rate };
}

function parseTypeInput(input: Record<string, unknown>): TypeInput {
  return {
    name: requireString(input.name, "name", { maxLength: 100 }),
    assetAccountCode: parseAccountCodeInput(input.assetAccountCode, "assetAccountCode"),
    accumulatedDepreciationAccountCode: parseAccountCodeInput(input.accumulatedDepreciationAccountCode, "accumulatedDepreciationAccountCode"),
    depreciationExpenseAccountCode: parseAccountCodeInput(input.depreciationExpenseAccountCode, "depreciationExpenseAccountCode"),
    ...parseMethodAndRate(input.method, input.rate),
  };
}

async function resolveTypeAccounts(tx: OrgTx, input: TypeInput): Promise<{ asset: AccountRow; accumulated: AccountRow; expense: AccountRow }> {
  const asset = await findAccount(tx, input.assetAccountCode, "Asset account");
  assertAssetSideAccount(asset, "Asset account");
  const accumulated = await findAccount(tx, input.accumulatedDepreciationAccountCode, "Accumulated depreciation account");
  assertAssetSideAccount(accumulated, "Accumulated depreciation account");
  if (accumulated.id === asset.id) throw new ValidationError("The accumulated depreciation account has to be a different account from the asset account.");
  const expense = await findAccount(tx, input.depreciationExpenseAccountCode, "Depreciation expense account");
  if (expense.account_class !== "expense" || expense.system_key !== null) {
    throw new ValidationError(`Depreciation expense account: account ${expense.code} (${expense.name}) isn't an expense account.`);
  }
  return { asset, accumulated, expense };
}

async function assertNameFree(tx: OrgTx, name: string, exceptId: string | null): Promise<void> {
  const taken = await tx.query("select 1 from fixed_asset_types where lower(name) = lower($1) and archived_at is null and ($2::bigint is null or id <> $2)", [
    name,
    exceptId,
  ]);
  if (taken.rowCount) throw new ConflictError(`There's already an asset type called ${name}.`);
}

/** Adds an asset type (admins; FA1). */
export async function createFixedAssetType(
  tx: OrgTx,
  command: Record<string, unknown> & { source?: unknown; idempotencyKey: unknown },
): Promise<{ created: boolean; type: FixedAssetType }> {
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const input = parseTypeInput(command);
  const hash = requestHash("fixed_asset_type", {
    ...input,
    assetAccountCode: input.assetAccountCode.toLowerCase(),
    accumulatedDepreciationAccountCode: input.accumulatedDepreciationAccountCode.toLowerCase(),
    depreciationExpenseAccountCode: input.depreciationExpenseAccountCode.toLowerCase(),
  });
  const earlier = await tx.query<{ id: string; request_hash: string }>(
    "select id::text, request_hash from fixed_asset_types where command_source = $1 and idempotency_key = $2",
    [source, idempotencyKey],
  );
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "asset type");
    return { created: false, type: await getFixedAssetType(tx, earlier.rows[0].id) };
  }
  const accounts = await resolveTypeAccounts(tx, input);
  await assertNameFree(tx, input.name, null);
  const inserted = await tx.query<{ id: string }>(
    `insert into fixed_asset_types (command_source, idempotency_key, request_hash, name, asset_account_id, accumulated_depreciation_account_id,
                                    depreciation_expense_account_id, method, rate, created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10, $11) returning id::text`,
    [source, idempotencyKey, hash, input.name, accounts.asset.id, accounts.accumulated.id, accounts.expense.id, input.method, input.rate, tx.actor.userId, tx.actor.email],
  );
  const id = inserted.rows[0].id;
  await writeAuditEvent(tx, { eventType: "fixed_asset_type.created", entityType: "fixed_asset_type", entityId: id, details: { ...input } });
  return { created: true, type: await getFixedAssetType(tx, id) };
}

/**
 * Changes an asset type (admins). Its default method and rate only apply to
 * assets registered afterwards; its accounts can't change once it has assets
 * (the database refuses too).
 */
export async function updateFixedAssetType(tx: OrgTx, idInput: unknown, command: Record<string, unknown>): Promise<FixedAssetType> {
  const current = await getFixedAssetType(tx, idInput);
  if (current.isArchived) throw new ConflictError(`${current.name} is archived. Bring it back before changing it.`);
  const input = parseTypeInput({
    name: command.name ?? current.name,
    assetAccountCode: command.assetAccountCode ?? current.assetAccountCode,
    accumulatedDepreciationAccountCode: command.accumulatedDepreciationAccountCode ?? current.accumulatedDepreciationAccountCode,
    depreciationExpenseAccountCode: command.depreciationExpenseAccountCode ?? current.depreciationExpenseAccountCode,
    method: command.method ?? current.method,
    rate: command.method !== undefined || command.rate !== undefined ? command.rate : current.rate,
  });
  const accounts = await resolveTypeAccounts(tx, input);
  const accountsChanged =
    accounts.asset.code !== current.assetAccountCode ||
    accounts.accumulated.code !== current.accumulatedDepreciationAccountCode ||
    accounts.expense.code !== current.depreciationExpenseAccountCode;
  if (accountsChanged && current.assetCount > 0) {
    throw new ConflictError(`${current.name} has assets, so its accounts can't change. Add a new asset type instead.`);
  }
  await assertNameFree(tx, input.name, current.id);
  await tx.query(
    `update fixed_asset_types set name = $2, asset_account_id = $3, accumulated_depreciation_account_id = $4, depreciation_expense_account_id = $5,
            method = $6, rate = $7::numeric, updated_at = now() where id = $1`,
    [current.id, input.name, accounts.asset.id, accounts.accumulated.id, accounts.expense.id, input.method, input.rate],
  );
  await writeAuditEvent(tx, { eventType: "fixed_asset_type.updated", entityType: "fixed_asset_type", entityId: current.id, details: { ...input } });
  return getFixedAssetType(tx, current.id);
}

/** Archives an asset type (it can't be deleted), or brings it back. Archived types can't be used for new assets. */
export async function archiveFixedAssetType(tx: OrgTx, idInput: unknown, command: { archived?: unknown }): Promise<FixedAssetType> {
  const current = await getFixedAssetType(tx, idInput);
  const archived = command.archived !== false;
  if (!archived) await assertNameFree(tx, current.name, current.id);
  await tx.query(
    `update fixed_asset_types set archived_at = case when $2 then coalesce(archived_at, now()) else null end,
            archived_by_email = case when $2 then $3 else null end, updated_at = now() where id = $1`,
    [current.id, archived, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: archived ? "fixed_asset_type.archived" : "fixed_asset_type.restored",
    entityType: "fixed_asset_type",
    entityId: current.id,
    details: { name: current.name },
  });
  return getFixedAssetType(tx, current.id);
}

// ---------------------------------------------------------------------------
// Assets

export type FixedAssetStatus = "registered" | "disposed" | "archived";

export type DepreciationHistoryLine = {
  kind: "run" | "disposal";
  /** The run's or disposal's id. */
  sourceId: string;
  /** The run's period end, or the disposal date. */
  date: string;
  fromMonth: string;
  toMonth: string;
  months: number;
  amount: string;
  /** False once the run is rolled back or the disposal undone. */
  counts: boolean;
};

export type FixedAssetDisposal = {
  id: string;
  status: "active" | "undone";
  disposalDate: string;
  proceeds: string;
  proceedsAccountCode: string | null;
  gainLossAccountCode: string;
  capitalGainAccountCode: string;
  cost: string;
  depreciation: string;
  accumulatedDepreciation: string;
  bookValue: string;
  depreciationRecovered: string;
  capitalGain: string;
  loss: string;
  journalId: string;
  undoJournalId: string | null;
  createdByEmail: string | null;
  createdAt: string;
  undoneByEmail: string | null;
  undoneAt: string | null;
};

export type FixedAssetSummary = {
  id: string;
  assetNumber: string;
  name: string;
  description: string | null;
  typeId: string;
  typeName: string;
  status: FixedAssetStatus;
  purchaseDate: string;
  cost: string;
  billLineId: string | null;
  billId: string | null;
  method: DepreciationMethod;
  rate: string | null;
  residualValue: string;
  openingDate: string | null;
  openingAccumulatedDepreciation: string;
  tracking: TrackingTags;
  /** Opening plus depreciation posted by active runs and an active disposal. */
  accumulatedDepreciation: string;
  bookValue: string;
  /** The last month end depreciation has been charged to, if any. */
  depreciatedTo: string | null;
  /** Whether depreciation or a disposal counts against it (then only its name, description and tracking can change). */
  hasHistory: boolean;
  assetAccountCode: string;
  accumulatedDepreciationAccountCode: string;
  depreciationExpenseAccountCode: string;
  archivedAt: string | null;
  createdByEmail: string | null;
  createdAt: string;
};

export type FixedAsset = FixedAssetSummary & { history: DepreciationHistoryLine[]; disposals: FixedAssetDisposal[] };

type AssetRow = {
  id: string;
  asset_number: string;
  name: string;
  description: string | null;
  type_id: string;
  type_name: string;
  status: FixedAssetStatus;
  purchase_date: string;
  cost: string;
  bill_line_id: string | null;
  bill_id: string | null;
  method: DepreciationMethod;
  rate: string | null;
  residual_value: string;
  opening_date: string | null;
  opening_accumulated_depreciation: string;
  tracking: TrackingTags;
  charged: string;
  last_month: string | null;
  has_history: boolean;
  asset_code: string;
  accum_code: string;
  expense_code: string;
  archived_at: string | null;
  created_by_email: string | null;
  created_at: string;
};

/** Depreciation lines that count: from active runs and active disposals. */
export const COUNTING_LINES_SQL = `select l.*, coalesce(r.period_end, d.disposal_date) as charged_on
  from fixed_asset_depreciation_lines l
  left join fixed_asset_depreciation_runs r on r.id = l.run_id
  left join fixed_asset_disposals d on d.id = l.disposal_id
 where (r.status = 'active' or d.status = 'active')`;

const ASSET_SELECT = `select f.id::text, f.asset_number, f.name, f.description, f.type_id::text, t.name as type_name, f.status, f.purchase_date,
       f.cost::text, f.bill_line_id::text, bl.bill_id::text, f.method, f.rate::text, f.residual_value::text, f.opening_date,
       f.opening_accumulated_depreciation::text, f.tracking,
       coalesce((select sum(c.amount) from (${COUNTING_LINES_SQL}) c where c.asset_id = f.id), 0)::text as charged,
       (select max(c.to_month) from (${COUNTING_LINES_SQL}) c where c.asset_id = f.id) as last_month,
       tohyee_fixed_asset_has_history(f.id) as has_history,
       aa.code as asset_code, ad.code as accum_code, ae.code as expense_code,
       f.archived_at, f.created_by_email, f.created_at
  from fixed_assets f
  join fixed_asset_types t on t.id = f.type_id
  join accounts aa on aa.id = t.asset_account_id
  join accounts ad on ad.id = t.accumulated_depreciation_account_id
  join accounts ae on ae.id = t.depreciation_expense_account_id
  left join bill_lines bl on bl.id = f.bill_line_id`;

function toSummary(row: AssetRow, scale: number): FixedAssetSummary {
  const cost = dec(row.cost);
  const accumulated = add(dec(row.opening_accumulated_depreciation), dec(row.charged));
  const disposed = row.status === "disposed";
  const lastMonth = row.last_month ? monthEnd(monthOf(row.last_month)) : null;
  return {
    id: row.id,
    assetNumber: row.asset_number,
    name: row.name,
    description: row.description,
    typeId: row.type_id,
    typeName: row.type_name,
    status: row.status,
    purchaseDate: row.purchase_date,
    cost: toFixedString(cost, scale),
    billLineId: row.bill_line_id,
    billId: row.bill_id,
    method: row.method,
    rate: row.rate === null ? null : toPlainString(dec(row.rate)),
    residualValue: toFixedString(dec(row.residual_value), scale),
    openingDate: row.opening_date,
    openingAccumulatedDepreciation: toFixedString(dec(row.opening_accumulated_depreciation), scale),
    tracking: row.tracking ?? {},
    accumulatedDepreciation: toFixedString(disposed ? dec("0") : accumulated, scale),
    bookValue: toFixedString(disposed ? dec("0") : sub(cost, accumulated), scale),
    depreciatedTo: lastMonth ?? row.opening_date,
    hasHistory: row.has_history,
    assetAccountCode: row.asset_code,
    accumulatedDepreciationAccountCode: row.accum_code,
    depreciationExpenseAccountCode: row.expense_code,
    archivedAt: row.archived_at,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
  };
}

export async function getFixedAsset(tx: OrgTx, idInput: unknown): Promise<FixedAsset> {
  const id = requireId(idInput, "assetId");
  const scale = currencyMinorUnits(tx.baseCurrency);
  const found = await tx.query<AssetRow>(`${ASSET_SELECT} where f.id = $1`, [id]);
  if (!found.rows[0]) throw new NotFoundError("Fixed asset not found.");
  const history = await tx.query<{
    run_id: string | null;
    disposal_id: string | null;
    period_end: string | null;
    disposal_date: string | null;
    from_month: string;
    to_month: string;
    months: number;
    amount: string;
    counts: boolean;
  }>(
    `select l.run_id::text, l.disposal_id::text, r.period_end, d.disposal_date, l.from_month, l.to_month, l.months, l.amount::text,
            coalesce(r.status = 'active', d.status = 'active') as counts
       from fixed_asset_depreciation_lines l
       left join fixed_asset_depreciation_runs r on r.id = l.run_id
       left join fixed_asset_disposals d on d.id = l.disposal_id
      where l.asset_id = $1 order by l.id`,
    [id],
  );
  const disposals = await tx.query<{
    id: string;
    status: "active" | "undone";
    disposal_date: string;
    proceeds: string;
    proceeds_code: string | null;
    gain_code: string;
    capital_code: string;
    cost: string;
    depreciation: string;
    accumulated_depreciation: string;
    depreciation_recovered: string;
    capital_gain: string;
    loss: string;
    journal_id: string;
    undo_journal_id: string | null;
    created_by_email: string | null;
    created_at: string;
    undone_by_email: string | null;
    undone_at: string | null;
  }>(
    `select d.id::text, d.status, d.disposal_date, d.proceeds::text, pa.code as proceeds_code, ga.code as gain_code, ca.code as capital_code,
            d.cost::text, d.depreciation::text, d.accumulated_depreciation::text, d.depreciation_recovered::text, d.capital_gain::text, d.loss::text,
            d.journal_id::text, d.undo_journal_id::text, d.created_by_email, d.created_at, d.undone_by_email, d.undone_at
       from fixed_asset_disposals d
       left join accounts pa on pa.id = d.proceeds_account_id
       join accounts ga on ga.id = d.gain_loss_account_id
       join accounts ca on ca.id = d.capital_gain_account_id
      where d.asset_id = $1 order by d.id`,
    [id],
  );
  const fixed = (value: string) => toFixedString(dec(value), scale);
  return {
    ...toSummary(found.rows[0], scale),
    history: history.rows.map((row) => ({
      kind: row.run_id ? "run" : "disposal",
      sourceId: (row.run_id ?? row.disposal_id)!,
      date: (row.period_end ?? row.disposal_date)!,
      fromMonth: monthOf(row.from_month),
      toMonth: monthOf(row.to_month),
      months: row.months,
      amount: fixed(row.amount),
      counts: row.counts,
    })),
    disposals: disposals.rows.map((row) => ({
      id: row.id,
      status: row.status,
      disposalDate: row.disposal_date,
      proceeds: fixed(row.proceeds),
      proceedsAccountCode: row.proceeds_code,
      gainLossAccountCode: row.gain_code,
      capitalGainAccountCode: row.capital_code,
      cost: fixed(row.cost),
      depreciation: fixed(row.depreciation),
      accumulatedDepreciation: fixed(row.accumulated_depreciation),
      bookValue: toFixedString(sub(dec(row.cost), dec(row.accumulated_depreciation)), scale),
      depreciationRecovered: fixed(row.depreciation_recovered),
      capitalGain: fixed(row.capital_gain),
      loss: fixed(row.loss),
      journalId: row.journal_id,
      undoJournalId: row.undo_journal_id,
      createdByEmail: row.created_by_email,
      createdAt: row.created_at,
      undoneByEmail: row.undone_by_email,
      undoneAt: row.undone_at,
    })),
  };
}

/** Assets by number; `status` is registered (the default), disposed, archived or all. */
export async function listFixedAssets(tx: OrgTx, filters: { status?: unknown } = {}): Promise<FixedAssetSummary[]> {
  const status = filters.status == null || filters.status === "" ? "registered" : String(filters.status);
  if (!["registered", "disposed", "archived", "all"].includes(status)) {
    throw new ValidationError("status must be registered, disposed, archived or all.");
  }
  const found = await tx.query<AssetRow>(`${ASSET_SELECT} where ($1 = 'all' or f.status = $1) order by f.asset_number`, [status]);
  const scale = currencyMinorUnits(tx.baseCurrency);
  return found.rows.map((row) => toSummary(row, scale));
}

/** What can be typed for an asset. */
type AssetInput = {
  name: string;
  description: string | null;
  typeId: string;
  purchaseDate: string | null;
  cost: string | null;
  billLineId: string | null;
  method: DepreciationMethod | null;
  rate: string | null;
  residualValue: string;
  openingDate: string | null;
  openingAccumulatedDepreciation: string;
  tracking: TrackingTags;
};

function parseAssetInput(input: Record<string, unknown>, scale: number): AssetInput {
  const methodGiven = input.method != null && input.method !== "";
  const methodAndRate = methodGiven ? parseMethodAndRate(input.method, input.rate) : { method: null, rate: null };
  const money = (value: unknown, label: string, allowZero: boolean) =>
    toFixedString(dec(parseDecimalInput(value, label, { maxScale: scale, allowZero })), scale);
  return {
    name: requireString(input.name, "name", { maxLength: 200 }),
    description: optionalString(input.description, "description", { maxLength: 1000 }),
    typeId: requireId(input.typeId, "typeId"),
    purchaseDate: parseOptionalIsoDate(input.purchaseDate, "purchaseDate"),
    cost: input.cost == null || input.cost === "" ? null : money(input.cost, "The cost", false),
    billLineId: input.billLineId == null || input.billLineId === "" ? null : requireId(input.billLineId, "billLineId"),
    method: methodAndRate.method,
    rate: methodAndRate.rate,
    residualValue: input.residualValue == null || input.residualValue === "" ? toFixedString(dec("0"), scale) : money(input.residualValue, "The residual value", true),
    openingDate: parseOptionalIsoDate(input.openingDate, "openingDate"),
    openingAccumulatedDepreciation:
      input.openingAccumulatedDepreciation == null || input.openingAccumulatedDepreciation === ""
        ? toFixedString(dec("0"), scale)
        : money(input.openingAccumulatedDepreciation, "The opening accumulated depreciation", true),
    tracking: sortedTags(parseTrackingInput(input.tracking, "The asset")),
  };
}

type ResolvedAsset = {
  name: string;
  description: string | null;
  typeId: string;
  purchaseDate: string;
  cost: string;
  billLineId: string | null;
  method: DepreciationMethod;
  rate: string | null;
  residualValue: string;
  openingDate: string | null;
  openingAccumulatedDepreciation: string;
  tracking: TrackingTags;
};

/**
 * Checks an asset against the organisation's data (FA2): an active type, the
 * bill line (an approved bill's line on the type's asset account, with enough
 * of its amount excluding GST not already registered), the method and rate
 * (the type's unless given), residual value and opening balance.
 */
async function resolveAsset(tx: OrgTx, input: AssetInput, exceptAssetId: string | null, keptTags: ReadonlySet<string>): Promise<ResolvedAsset> {
  const scale = currencyMinorUnits(tx.baseCurrency);
  const type = await tx.query<{ id: string; name: string; asset_account_id: string; method: DepreciationMethod; rate: string | null; archived_at: string | null }>(
    "select id::text, name, asset_account_id::text, method, rate::text, archived_at from fixed_asset_types where id = $1",
    [input.typeId],
  );
  const assetType = type.rows[0];
  if (!assetType) throw new ValidationError("There's no such asset type.");
  let purchaseDate = input.purchaseDate;
  let cost = input.cost;
  if (input.billLineId) {
    const line = await tx.query<{ net_amount: string; account_id: string; code: string; status: string; bill_date: string; registered: string }>(
      `select l.net_amount::text, l.account_id::text, a.code, b.status, b.bill_date,
              coalesce((select sum(f.cost) from fixed_assets f where f.bill_line_id = l.id and f.status <> 'archived' and ($2::bigint is null or f.id <> $2)), 0)::text as registered
         from bill_lines l join bills b on b.id = l.bill_id join accounts a on a.id = l.account_id where l.id = $1`,
      [input.billLineId, exceptAssetId],
    );
    const found = line.rows[0];
    if (!found) throw new ValidationError("There's no such bill line.");
    if (found.status !== "approved") throw new ValidationError("An asset can only be registered from an approved bill's line.");
    if (found.account_id !== assetType.asset_account_id) {
      throw new ValidationError(`That bill line is on account ${found.code}, not ${assetType.name}'s asset account. Choose the matching asset type.`);
    }
    const left = sub(dec(found.net_amount), dec(found.registered));
    if (cmp(left, dec("0")) <= 0) throw new ValidationError("That bill line's cost has already been registered as assets.");
    if (cost === null) cost = toFixedString(left, scale);
    if (cmp(dec(cost), left) > 0) {
      throw new ValidationError(`The cost can't be more than what's left of the bill line excluding GST (${toFixedString(left, scale)}).`);
    }
    purchaseDate ??= found.bill_date;
  }
  if (purchaseDate === null) throw new ValidationError("purchaseDate is required (YYYY-MM-DD).");
  if (cost === null) throw new ValidationError("The cost is required.");
  const method = input.method ?? assetType.method;
  const rate = input.method ? input.rate : assetType.rate === null ? null : toPlainString(dec(assetType.rate));
  if (cmp(dec(input.residualValue), dec(cost)) > 0) throw new ValidationError("The residual value can't be more than the cost.");
  if (input.openingDate === null && cmp(dec(input.openingAccumulatedDepreciation), dec("0")) > 0) {
    throw new ValidationError("Opening accumulated depreciation needs the date it's as at (the month end the register starts from).");
  }
  if (input.openingDate !== null) {
    if (!isMonthEnd(input.openingDate)) throw new ValidationError("The opening balance date must be a month end, e.g. 2026-03-31.");
    if (input.openingDate < purchaseDate) throw new ValidationError("The opening balance date can't be before the purchase date.");
  }
  if (cmp(dec(input.openingAccumulatedDepreciation), sub(dec(cost), dec(input.residualValue))) > 0) {
    throw new ValidationError("The opening accumulated depreciation can't be more than the cost less the residual value.");
  }
  checkNewTags(await loadTrackingContext(tx), input.tracking, "The asset", keptTags);
  return {
    name: input.name,
    description: input.description,
    typeId: assetType.id,
    purchaseDate,
    cost,
    billLineId: input.billLineId,
    method,
    rate,
    residualValue: input.residualValue,
    openingDate: input.openingDate,
    openingAccumulatedDepreciation: input.openingAccumulatedDepreciation,
    tracking: input.tracking,
  };
}

function hashAsset(input: AssetInput): Record<string, unknown> {
  return { ...input, ...(Object.keys(input.tracking).length === 0 ? { tracking: undefined } : {}) };
}

/**
 * Registers an asset (bookkeepers; FA2). It posts nothing: its cost is
 * already in the ledger, from the bill line it names or however it was
 * bought. Numbers come from a counter (FA-0001, no gaps).
 */
export async function createFixedAsset(
  tx: OrgTx,
  command: Record<string, unknown> & { source?: unknown; idempotencyKey: unknown },
): Promise<{ created: boolean; asset: FixedAsset }> {
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const scale = currencyMinorUnits(tx.baseCurrency);
  const input = parseAssetInput(command, scale);
  const hash = requestHash("fixed_asset", hashAsset(input));
  const replay = async () => {
    const earlier = await tx.query<{ id: string; request_hash: string }>(
      "select id::text, request_hash from fixed_assets where command_source = $1 and idempotency_key = $2",
      [source, idempotencyKey],
    );
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].request_hash, hash, "fixed asset");
    return { created: false, asset: await getFixedAsset(tx, earlier.rows[0].id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  await lockRegister(tx);
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;
  const resolved = await resolveAsset(tx, input, null, new Set());
  const archivedType = await tx.query("select 1 from fixed_asset_types where id = $1 and archived_at is not null", [resolved.typeId]);
  if (archivedType.rowCount) throw new ValidationError("That asset type is archived. Choose another, or bring it back first.");
  const numbered = await tx.query<{ last_number: number }>("update fixed_asset_numbering set last_number = last_number + 1 where id = true returning last_number");
  const assetNumber = `FA-${String(numbered.rows[0].last_number).padStart(4, "0")}`;
  const inserted = await tx.query<{ id: string }>(
    `insert into fixed_assets (command_source, idempotency_key, request_hash, asset_number, name, description, type_id, purchase_date, cost,
                               bill_line_id, method, rate, residual_value, opening_date, opening_accumulated_depreciation, tracking,
                               created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10, $11, $12::numeric, $13::numeric, $14, $15::numeric, $16::jsonb, $17, $18)
     returning id::text`,
    [
      source,
      idempotencyKey,
      hash,
      assetNumber,
      resolved.name,
      resolved.description,
      resolved.typeId,
      resolved.purchaseDate,
      resolved.cost,
      resolved.billLineId,
      resolved.method,
      resolved.rate,
      resolved.residualValue,
      resolved.openingDate,
      resolved.openingAccumulatedDepreciation,
      JSON.stringify(resolved.tracking),
      tx.actor.userId,
      tx.actor.email,
    ],
  );
  const id = inserted.rows[0].id;
  await writeAuditEvent(tx, {
    eventType: "fixed_asset.registered",
    entityType: "fixed_asset",
    entityId: id,
    details: { assetNumber, cost: resolved.cost, purchaseDate: resolved.purchaseDate, billLineId: resolved.billLineId, method: resolved.method, rate: resolved.rate },
  });
  return { created: true, asset: await getFixedAsset(tx, id) };
}

/**
 * Changes an asset (FA14). Its name, description and tracking can always
 * change; everything else only while no depreciation or disposal counts
 * against it (roll back the runs first). The database refuses too.
 */
export async function updateFixedAsset(tx: OrgTx, idInput: unknown, command: Record<string, unknown>): Promise<FixedAsset> {
  await lockRegister(tx);
  const current = await getFixedAsset(tx, idInput);
  if (current.status === "archived") throw new ConflictError(`${current.assetNumber} is archived and can't change.`);
  const scale = currencyMinorUnits(tx.baseCurrency);
  const pick = (field: string, fallback: unknown) => (command[field] === undefined ? fallback : command[field]);
  const methodChanged = command.method !== undefined || command.rate !== undefined;
  const input = parseAssetInput(
    {
      name: pick("name", current.name),
      description: pick("description", current.description),
      typeId: pick("typeId", current.typeId),
      purchaseDate: pick("purchaseDate", current.purchaseDate),
      cost: pick("cost", current.cost),
      billLineId: pick("billLineId", current.billLineId),
      method: methodChanged ? pick("method", current.method) : current.method,
      rate: methodChanged ? command.rate : current.rate,
      residualValue: pick("residualValue", current.residualValue),
      openingDate: pick("openingDate", current.openingDate),
      openingAccumulatedDepreciation: pick("openingAccumulatedDepreciation", current.openingAccumulatedDepreciation),
      tracking: pick("tracking", current.tracking),
    },
    scale,
  );
  const resolved = await resolveAsset(tx, input, current.id, new Set(Object.values(current.tracking)));
  const fixedChanged =
    resolved.typeId !== current.typeId ||
    resolved.purchaseDate !== current.purchaseDate ||
    resolved.cost !== current.cost ||
    resolved.billLineId !== current.billLineId ||
    resolved.method !== current.method ||
    resolved.rate !== current.rate ||
    resolved.residualValue !== current.residualValue ||
    resolved.openingDate !== current.openingDate ||
    resolved.openingAccumulatedDepreciation !== current.openingAccumulatedDepreciation;
  if (fixedChanged && current.hasHistory) {
    throw new ConflictError(
      `${current.assetNumber} has depreciation${current.status === "disposed" ? " and a disposal" : ""}, so only its name, description and tracking can change. Roll back its depreciation first to change the rest.`,
    );
  }
  await tx.query(
    `update fixed_assets set name = $2, description = $3, type_id = $4, purchase_date = $5, cost = $6::numeric, bill_line_id = $7, method = $8,
            rate = $9::numeric, residual_value = $10::numeric, opening_date = $11, opening_accumulated_depreciation = $12::numeric, tracking = $13::jsonb,
            updated_at = now()
      where id = $1`,
    [
      current.id,
      resolved.name,
      resolved.description,
      resolved.typeId,
      resolved.purchaseDate,
      resolved.cost,
      resolved.billLineId,
      resolved.method,
      resolved.rate,
      resolved.residualValue,
      resolved.openingDate,
      resolved.openingAccumulatedDepreciation,
      JSON.stringify(resolved.tracking),
    ],
  );
  await writeAuditEvent(tx, {
    eventType: "fixed_asset.updated",
    entityType: "fixed_asset",
    entityId: current.id,
    details: {
      before: { name: current.name, cost: current.cost, method: current.method, rate: current.rate, purchaseDate: current.purchaseDate },
      after: { name: resolved.name, cost: resolved.cost, method: resolved.method, rate: resolved.rate, purchaseDate: resolved.purchaseDate },
    },
  });
  return getFixedAsset(tx, current.id);
}

/** Archives an asset registered by mistake (FA14): only while no depreciation or disposal counts against it. It's never deleted. */
export async function archiveFixedAsset(tx: OrgTx, idInput: unknown): Promise<FixedAsset> {
  await lockRegister(tx);
  const current = await getFixedAsset(tx, idInput);
  if (current.status === "archived") return current;
  if (current.hasHistory) {
    throw new ConflictError(`${current.assetNumber} has depreciation or a disposal, so it can't be archived. Dispose of it instead.`);
  }
  await tx.query("update fixed_assets set status = 'archived', archived_at = now(), archived_by_email = $2, updated_at = now() where id = $1", [
    current.id,
    tx.actor.email,
  ]);
  await writeAuditEvent(tx, { eventType: "fixed_asset.archived", entityType: "fixed_asset", entityId: current.id, details: { assetNumber: current.assetNumber } });
  return getFixedAsset(tx, current.id);
}

export type AssetBillLine = {
  billLineId: string;
  billId: string;
  billDate: string;
  supplierName: string;
  supplierInvoiceNumber: string;
  description: string;
  accountCode: string;
  netAmount: string;
  /** What's not yet registered as assets. */
  unregistered: string;
};

/** Approved bill lines on an asset type's asset account with cost not yet registered (FA2), newest first. */
export async function listBillLinesForAssets(tx: OrgTx): Promise<AssetBillLine[]> {
  const scale = currencyMinorUnits(tx.baseCurrency);
  const found = await tx.query<{
    id: string;
    bill_id: string;
    bill_date: string;
    supplier: string;
    number: string;
    description: string;
    code: string;
    net_amount: string;
    registered: string;
  }>(
    `select l.id::text, b.id::text as bill_id, b.bill_date, c.name as supplier, b.supplier_invoice_number as number, l.description, a.code,
            l.net_amount::text,
            coalesce((select sum(f.cost) from fixed_assets f where f.bill_line_id = l.id and f.status <> 'archived'), 0)::text as registered
       from bill_lines l
       join bills b on b.id = l.bill_id
       join contacts c on c.id = b.contact_id
       join accounts a on a.id = l.account_id
      where b.status = 'approved'
        and l.account_id in (select asset_account_id from fixed_asset_types where archived_at is null)
      order by b.bill_date desc, b.id desc, l.line_order
      limit 200`,
  );
  return found.rows
    .map((row) => ({
      billLineId: row.id,
      billId: row.bill_id,
      billDate: row.bill_date,
      supplierName: row.supplier,
      supplierInvoiceNumber: row.number,
      description: row.description,
      accountCode: row.code,
      netAmount: toFixedString(dec(row.net_amount), scale),
      unregistered: toFixedString(sub(dec(row.net_amount), dec(row.registered)), scale),
    }))
    .filter((line) => cmp(dec(line.unregistered), dec("0")) > 0);
}

// ---------------------------------------------------------------------------
// What runs and disposals work from

export type AssetState = {
  id: string;
  assetNumber: string;
  name: string;
  status: FixedAssetStatus;
  typeId: string;
  typeName: string;
  purchaseDate: string;
  openingDate: string | null;
  cost: string;
  residualValue: string;
  openingAccumulated: string;
  method: DepreciationMethod;
  rate: string | null;
  tracking: TrackingTags;
  assetAccountCode: string;
  accumulatedAccountCode: string;
  expenseAccountCode: string;
  charged: ChargedSegment[];
};

/** Assets with their accounts and the depreciation that counts against them. */
export async function loadAssetStates(tx: OrgTx, filter: { assetId?: string; status?: FixedAssetStatus }): Promise<AssetState[]> {
  const assets = await tx.query<{
    id: string;
    asset_number: string;
    name: string;
    status: FixedAssetStatus;
    type_id: string;
    type_name: string;
    purchase_date: string;
    opening_date: string | null;
    cost: string;
    residual_value: string;
    opening_accumulated_depreciation: string;
    method: DepreciationMethod;
    rate: string | null;
    tracking: TrackingTags;
    asset_code: string;
    accum_code: string;
    expense_code: string;
  }>(
    `select f.id::text, f.asset_number, f.name, f.status, f.type_id::text, t.name as type_name, f.purchase_date, f.opening_date, f.cost::text,
            f.residual_value::text, f.opening_accumulated_depreciation::text, f.method, f.rate::text, f.tracking,
            aa.code as asset_code, ad.code as accum_code, ae.code as expense_code
       from fixed_assets f
       join fixed_asset_types t on t.id = f.type_id
       join accounts aa on aa.id = t.asset_account_id
       join accounts ad on ad.id = t.accumulated_depreciation_account_id
       join accounts ae on ae.id = t.depreciation_expense_account_id
      where ($1::bigint is null or f.id = $1) and ($2::text is null or f.status = $2)
      order by f.asset_number`,
    [filter.assetId ?? null, filter.status ?? null],
  );
  const lines = await tx.query<{ asset_id: string; financial_year_start: string; from_month: string; to_month: string; amount: string }>(
    `select c.asset_id::text, c.financial_year_start, c.from_month, c.to_month, c.amount::text from (${COUNTING_LINES_SQL}) c
      where ($1::bigint is null or c.asset_id = $1) order by c.id`,
    [filter.assetId ?? null],
  );
  const charged = new Map<string, ChargedSegment[]>();
  for (const line of lines.rows) {
    const list = charged.get(line.asset_id) ?? [];
    list.push({ financialYearStart: line.financial_year_start, fromMonth: monthOf(line.from_month), toMonth: monthOf(line.to_month), amount: line.amount });
    charged.set(line.asset_id, list);
  }
  return assets.rows.map((row) => ({
    id: row.id,
    assetNumber: row.asset_number,
    name: row.name,
    status: row.status,
    typeId: row.type_id,
    typeName: row.type_name,
    purchaseDate: row.purchase_date,
    openingDate: row.opening_date,
    cost: row.cost,
    residualValue: row.residual_value,
    openingAccumulated: row.opening_accumulated_depreciation,
    method: row.method,
    rate: row.rate === null ? null : toPlainString(dec(row.rate)),
    tracking: row.tracking ?? {},
    assetAccountCode: row.asset_code,
    accumulatedAccountCode: row.accum_code,
    expenseAccountCode: row.expense_code,
    charged: charged.get(row.id) ?? [],
  }));
}

/**
 * What the maths needs for an asset. Once depreciation has been charged, the
 * first month is the earliest one charged, so changing the first-month
 * setting later doesn't change how this year's figure is counted.
 */
export function basisOf(asset: AssetState, rule: FirstMonthRule): AssetBasis {
  const byRule = firstDepreciationMonth(asset.purchaseDate, asset.openingDate, rule);
  const earliest = asset.charged.reduce((first, segment) => (segment.fromMonth < first ? segment.fromMonth : first), byRule);
  return {
    method: asset.method,
    rate: asset.rate,
    cost: asset.cost,
    residualValue: asset.residualValue,
    openingAccumulated: asset.openingAccumulated,
    firstMonth: earliest,
  };
}

export function accumulatedOf(asset: AssetState): string {
  return toPlainString(add(dec(asset.openingAccumulated), sum(asset.charged.map((segment) => dec(segment.amount)))));
}
