import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { financialYearStart } from "@/lib/financial-year";
import { type DepreciationMethod } from "@/lib/fixed-assets/depreciation";
import { COUNTING_LINES_SQL, getFixedAssetSettings } from "@/lib/fixed-assets/service";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, dec, type Decimal, sub, toFixedString, toPlainString, ZERO_DECIMAL } from "@/lib/money/decimal";

/**
 * The fixed asset register as at a date (example FA13), like Xero's: each
 * asset held with its cost, accumulated depreciation, book value and this
 * financial year's depreciation, grouped by asset type with totals; assets
 * disposed of this year listed apart; and a check that the register's cost
 * and accumulated depreciation tie to the ledger balances of the accounts the
 * asset types use (manual journals to those accounts show as differences).
 * It stores and posts nothing.
 */

export type RegisterAsset = {
  id: string;
  assetNumber: string;
  name: string;
  purchaseDate: string;
  method: DepreciationMethod;
  rate: string | null;
  cost: string;
  accumulatedDepreciation: string;
  bookValue: string;
  depreciationThisYear: string;
};

export type RegisterTotals = { cost: string; accumulatedDepreciation: string; bookValue: string; depreciationThisYear: string };

export type RegisterGroup = { typeId: string; typeName: string; assets: RegisterAsset[]; totals: RegisterTotals };

export type RegisterDisposal = {
  id: string;
  assetNumber: string;
  name: string;
  typeName: string;
  disposalDate: string;
  cost: string;
  accumulatedDepreciation: string;
  proceeds: string;
  /** Depreciation recovered and capital gain less the loss: positive is a gain. */
  gainOrLoss: string;
  depreciationThisYear: string;
};

export type RegisterLedgerCheck = {
  accountCode: string;
  accountName: string;
  /** cost: the asset account; accumulated_depreciation: shown as a positive balance. */
  role: "cost" | "accumulated_depreciation";
  register: string;
  ledger: string;
  difference: string;
};

export type FixedAssetRegister = {
  asOf: string;
  financialYearStart: string;
  groups: RegisterGroup[];
  totals: RegisterTotals;
  disposals: RegisterDisposal[];
  ledger: RegisterLedgerCheck[];
  /** True when every account ties. */
  ties: boolean;
};

type Totals = { cost: Decimal; accumulated: Decimal; thisYear: Decimal };

export async function fixedAssetRegister(tx: OrgTx, input: { asOf: unknown }): Promise<FixedAssetRegister> {
  const asOf = parseIsoDate(input.asOf, "asOf");
  const settings = await getFixedAssetSettings(tx);
  const yearStart = financialYearStart(asOf, settings.financialYearEndMonth);
  const scale = currencyMinorUnits(tx.baseCurrency);
  const fixed = (value: Decimal) => toFixedString(value, scale);

  const assets = await tx.query<{
    id: string;
    asset_number: string;
    name: string;
    type_id: string;
    type_name: string;
    purchase_date: string;
    method: DepreciationMethod;
    rate: string | null;
    cost: string;
    opening: string;
    charged: string;
    this_year: string;
    asset_account: string;
    accum_account: string;
    disposal_id: string | null;
    disposal_date: string | null;
    proceeds: string | null;
    gain_or_loss: string | null;
  }>(
    `select f.id::text, f.asset_number, f.name, t.id::text as type_id, t.name as type_name, f.purchase_date, f.method, f.rate::text, f.cost::text,
            f.opening_accumulated_depreciation::text as opening,
            coalesce((select sum(c.amount) from (${COUNTING_LINES_SQL}) c where c.asset_id = f.id and c.charged_on <= $1), 0)::text as charged,
            coalesce((select sum(c.amount) from (${COUNTING_LINES_SQL}) c where c.asset_id = f.id and c.charged_on between $2 and $1), 0)::text as this_year,
            t.asset_account_id::text as asset_account, t.accumulated_depreciation_account_id::text as accum_account,
            d.id::text as disposal_id, d.disposal_date, d.proceeds::text,
            (d.depreciation_recovered + d.capital_gain - d.loss)::text as gain_or_loss
       from fixed_assets f
       join fixed_asset_types t on t.id = f.type_id
       left join fixed_asset_disposals d on d.asset_id = f.id and d.status = 'active' and d.disposal_date <= $1
      where f.status <> 'archived' and coalesce(f.opening_date, f.purchase_date) <= $1
      order by lower(t.name), t.id, f.asset_number`,
    [asOf, yearStart],
  );

  const groups = new Map<string, { typeId: string; typeName: string; assets: RegisterAsset[]; totals: Totals }>();
  const byAccount = new Map<string, Decimal>();
  const addTo = (accountId: string, amount: Decimal) => byAccount.set(accountId, add(byAccount.get(accountId) ?? ZERO_DECIMAL, amount));
  const grand: Totals = { cost: ZERO_DECIMAL, accumulated: ZERO_DECIMAL, thisYear: ZERO_DECIMAL };
  const disposals: RegisterDisposal[] = [];
  for (const row of assets.rows) {
    const cost = dec(row.cost);
    const accumulated = add(dec(row.opening), dec(row.charged));
    const thisYear = dec(row.this_year);
    if (row.disposal_id) {
      if (row.disposal_date! >= yearStart) {
        disposals.push({
          id: row.id,
          assetNumber: row.asset_number,
          name: row.name,
          typeName: row.type_name,
          disposalDate: row.disposal_date!,
          cost: fixed(cost),
          accumulatedDepreciation: fixed(accumulated),
          proceeds: fixed(dec(row.proceeds!)),
          gainOrLoss: fixed(dec(row.gain_or_loss!)),
          depreciationThisYear: fixed(thisYear),
        });
      }
      continue;
    }
    const group = groups.get(row.type_id) ?? {
      typeId: row.type_id,
      typeName: row.type_name,
      assets: [],
      totals: { cost: ZERO_DECIMAL, accumulated: ZERO_DECIMAL, thisYear: ZERO_DECIMAL },
    };
    group.assets.push({
      id: row.id,
      assetNumber: row.asset_number,
      name: row.name,
      purchaseDate: row.purchase_date,
      method: row.method,
      rate: row.rate === null ? null : toPlainString(dec(row.rate)),
      cost: fixed(cost),
      accumulatedDepreciation: fixed(accumulated),
      bookValue: fixed(sub(cost, accumulated)),
      depreciationThisYear: fixed(thisYear),
    });
    for (const totals of [group.totals, grand]) {
      totals.cost = add(totals.cost, cost);
      totals.accumulated = add(totals.accumulated, accumulated);
      totals.thisYear = add(totals.thisYear, thisYear);
    }
    groups.set(row.type_id, group);
    addTo(`cost:${row.asset_account}`, cost);
    addTo(`accum:${row.accum_account}`, accumulated);
  }

  // Every account an active asset type uses, even with nothing on the register.
  const types = await tx.query<{ asset_account: string; accum_account: string }>(
    "select asset_account_id::text as asset_account, accumulated_depreciation_account_id::text as accum_account from fixed_asset_types where archived_at is null",
  );
  const costAccounts = new Set([...types.rows.map((row) => row.asset_account), ...assets.rows.map((row) => row.asset_account)]);
  const accumAccounts = new Set([...types.rows.map((row) => row.accum_account), ...assets.rows.map((row) => row.accum_account)]);
  const balances = await tx.query<{ id: string; code: string; name: string; balance: string }>(
    `select a.id::text, a.code, a.name,
            coalesce((select sum(l.debit_amount - l.credit_amount) from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
                       where l.account_id = a.id and j.posting_date <= $2), 0)::text as balance
       from accounts a where a.id = any($1::bigint[]) order by a.code`,
    [[...new Set([...costAccounts, ...accumAccounts])], asOf],
  );
  const ledger: RegisterLedgerCheck[] = [];
  for (const account of balances.rows) {
    const debitBalance = dec(account.balance);
    for (const role of ["cost", "accumulated_depreciation"] as const) {
      if (role === "cost" ? !costAccounts.has(account.id) : !accumAccounts.has(account.id)) continue;
      const register = byAccount.get(`${role === "cost" ? "cost" : "accum"}:${account.id}`) ?? ZERO_DECIMAL;
      const ledgerBalance = role === "cost" ? debitBalance : sub(ZERO_DECIMAL, debitBalance);
      ledger.push({
        accountCode: account.code,
        accountName: account.name,
        role,
        register: fixed(register),
        ledger: fixed(ledgerBalance),
        difference: fixed(sub(ledgerBalance, register)),
      });
    }
  }
  const outTotals = (totals: Totals): RegisterTotals => ({
    cost: fixed(totals.cost),
    accumulatedDepreciation: fixed(totals.accumulated),
    bookValue: fixed(sub(totals.cost, totals.accumulated)),
    depreciationThisYear: fixed(totals.thisYear),
  });
  return {
    asOf,
    financialYearStart: yearStart,
    groups: [...groups.values()].map((group) => ({ typeId: group.typeId, typeName: group.typeName, assets: group.assets, totals: outTotals(group.totals) })),
    totals: outTotals(grand),
    disposals,
    ledger,
    ties: ledger.every((entry) => entry.difference === fixed(ZERO_DECIMAL)),
  };
}
