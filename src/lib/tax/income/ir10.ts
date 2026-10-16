import type { AccountType } from "@/lib/accounts/types";
import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { addDays } from "@/lib/financial-year";
import { add, cmp, dec, type Decimal, isNegative, isZero, neg, sub, ZERO_DECIMAL } from "@/lib/money/decimal";
import { accountTotals, earningsOf, financialYearEndMonth, naturalAmount } from "@/lib/reports/financial";
import { taxAssetTotals } from "@/lib/tax/income/assets";
import { allowedBoxes, allowedRoles, defaultBox, defaultRole, IR10_BOX_LABELS, IR10_ROLES, type Ir10Role } from "@/lib/tax/income/ir10-boxes";
import { incomeYearDates, money, moneyText, type Treatment, type Workpaper } from "@/lib/tax/income/rules";
import { requireId } from "@/lib/validation";

/*
 * The IR10 financial statements summary from the books (examples ITX19-ITX24,
 * decision 547). Owners and admins only (the API checks). Nothing is filed.
 */

export type Ir10Account = {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  isActive: boolean;
  box: number;
  role: Ir10Role | null;
  /** Chosen for this account, rather than the default. */
  isSet: boolean;
  allowedBoxes: number[];
  allowedRoles: Ir10Role[];
};

type AccountRow = { id: string; code: string; name: string; account_type: AccountType; system_key: string | null; is_active: boolean; box: number | null; role: Ir10Role | null; has_row: boolean };

/** Every account with its IR10 box and role, set or default (ITX19). */
export async function listIr10Accounts(tx: OrgTx): Promise<Ir10Account[]> {
  const rows = (
    await tx.query<AccountRow>(
      `select a.id::text, a.code, a.name, a.account_type, a.system_key, a.is_active, m.box, m.role, m.account_id is not null as has_row
         from accounts a left join account_ir10 m on m.account_id = a.id order by a.code, a.id`,
    )
  ).rows;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const boxOf = (row: AccountRow) => row.box ?? defaultBox({ code: row.code, name: row.name, type: row.account_type, systemKey: row.system_key });
  // An accumulated depreciation account follows its type's asset account unless set.
  const follows = new Map<string, string>();
  const types = await tx.query<{ asset_account_id: string; accumulated_depreciation_account_id: string }>(
    "select asset_account_id::text, accumulated_depreciation_account_id::text from fixed_asset_types order by id",
  );
  for (const type of types.rows) if (!follows.has(type.accumulated_depreciation_account_id)) follows.set(type.accumulated_depreciation_account_id, type.asset_account_id);
  return rows.map((row) => {
    const allowed = allowedBoxes(row.account_type);
    let box = boxOf(row);
    const assetAccount = follows.get(row.id);
    if (row.box === null && assetAccount && byId.get(assetAccount)) {
      const followed = boxOf(byId.get(assetAccount)!);
      if (allowed.includes(followed)) box = followed;
    }
    return {
      accountId: row.id,
      code: row.code,
      name: row.name,
      type: row.account_type,
      isActive: row.is_active,
      box,
      role: row.has_row ? row.role : defaultRole({ code: row.code, name: row.name, type: row.account_type, systemKey: row.system_key }),
      isSet: row.has_row,
      allowedBoxes: allowed,
      allowedRoles: allowedRoles(row.account_type),
    };
  });
}

/** Chooses an account's IR10 box and role (ITX19). */
export async function setIr10Account(tx: OrgTx, input: { accountId: unknown; box: unknown; role?: unknown }): Promise<Ir10Account> {
  const accountId = requireId(input.accountId, "accountId");
  const found = await tx.query<{ code: string; name: string; account_type: AccountType }>("select code, name, account_type from accounts where id = $1 for update", [accountId]);
  const account = found.rows[0];
  if (!account) throw new NotFoundError("Account not found.");
  const box = typeof input.box === "string" ? Number(input.box) : input.box;
  const allowed = allowedBoxes(account.account_type);
  if (typeof box !== "number" || !allowed.includes(box)) {
    throw new ValidationError(`${account.code} ${account.name} can go in IR10 box ${allowed.join(", ")}${allowed.length > 1 ? " (one of them)" : ""}.`);
  }
  let role: Ir10Role | null = null;
  if (input.role != null && input.role !== "") {
    if (typeof input.role !== "string" || !IR10_ROLES.includes(input.role as Ir10Role)) throw new ValidationError(`role must be one of: ${IR10_ROLES.join(", ")}.`);
    role = input.role as Ir10Role;
    if (!allowedRoles(account.account_type).includes(role)) throw new ValidationError(`${account.code} ${account.name} can't be marked as ${role.replace("_", " ")}.`);
  }
  const before = (await listIr10Accounts(tx)).find((entry) => entry.accountId === accountId)!;
  await tx.query(
    `insert into account_ir10 (account_id, box, role, updated_by_email) values ($1, $2, $3, $4)
     on conflict (account_id) do update set box = excluded.box, role = excluded.role, updated_by_email = excluded.updated_by_email, updated_at = now()`,
    [accountId, box, role, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "income_tax.ir10_account_set", entityType: "account", entityId: accountId, details: { code: account.code, from: { box: before.box, role: before.role }, to: { box, role } } });
  return (await listIr10Accounts(tx)).find((entry) => entry.accountId === accountId)!;
}

export type Ir10 = {
  /** Box number to amount ("1234.56"), or null when blank. Box 1 is "Yes" or "No". */
  boxes: Record<number, string | null>;
  labels: Record<number, string>;
  checks: Array<{ label: string; ok: boolean; detail: string }>;
  notes: string[];
};

/** The IR10 for a finished income year (ITX20-ITX24). `workpaper` is that year's taxable income workpaper. */
export async function buildIr10(
  tx: OrgTx,
  input: {
    incomeYear: number;
    workpaper: Workpaper;
    multipleActivity: boolean;
    treatments: Map<string, { treatment: Treatment }>;
  },
): Promise<Ir10> {
  const { start, end } = incomeYearDates(input.incomeYear, await financialYearEndMonth(tx));
  const accounts = await listIr10Accounts(tx);
  const byId = new Map(accounts.map((account) => [account.accountId, account]));
  const box = new Map<number, Decimal>();
  const put = (number: number, amount: Decimal) => box.set(number, add(box.get(number) ?? ZERO_DECIMAL, amount));
  const get = (number: number) => box.get(number) ?? ZERO_DECIMAL;

  // Profit and loss (ITX20).
  let directCosts = ZERO_DECIMAL;
  let untaxed = ZERO_DECIMAL;
  for (const row of await accountTotals(tx, start, end)) {
    const account = byId.get(row.id);
    if (!account) continue;
    const amount = naturalAmount(row);
    if (account.type === "direct_costs") directCosts = add(directCosts, amount);
    else if (row.account_class === "revenue" || row.account_class === "expense") put(account.box, amount);
    if (row.account_class === "revenue" && input.treatments.get(row.id)?.treatment === "not_taxable") untaxed = add(untaxed, amount);
  }
  const stockAt = async (date: string) => {
    let total = ZERO_DECIMAL;
    for (const row of await accountTotals(tx, null, date)) if (byId.get(row.id)?.type === "inventory") total = add(total, naturalAmount(row));
    return total;
  };
  const opening = await stockAt(addDays(start, -1));
  const closing = await stockAt(end);
  box.set(3, opening);
  box.set(5, closing);
  box.set(4, sub(add(directCosts, closing), opening));
  box.set(6, sub(add(get(2), get(5)), add(get(3), get(4))));
  box.set(11, [6, 7, 8, 9, 10].reduce((sum, number) => add(sum, get(number)), ZERO_DECIMAL));
  box.set(25, [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24].reduce((sum, number) => add(sum, get(number)), ZERO_DECIMAL));
  box.set(27, sub(get(11), get(25)));

  // Tax adjustments (ITX21): taxable profit before losses brought forward and other income.
  const taxable = sub(dec(input.workpaper.beforeLosses), dec(input.workpaper.otherIncome));
  box.set(29, taxable);
  box.set(28, sub(taxable, get(27)));

  // Balance sheet (ITX22).
  let equity = ZERO_DECIMAL;
  const all = await accountTotals(tx, null, end);
  let currentAccounts = ZERO_DECIMAL;
  for (const row of all) {
    const account = byId.get(row.id);
    if (!account) continue;
    const amount = naturalAmount(row);
    if (account.role === "current_account") currentAccounts = add(currentAccounts, row.account_class === "asset" ? neg(amount) : amount);
    if (row.account_class === "asset") {
      if (account.type === "bank" && isNegative(amount)) put(46, neg(amount));
      else put(account.box, amount);
    } else if (row.account_class === "liability") put(account.box, amount);
    else if (row.account_class === "equity") equity = add(equity, amount);
  }
  box.set(43, Array.from({ length: 13 }, (_, index) => get(30 + index)).reduce((sum, value) => add(sum, value), ZERO_DECIMAL));
  box.set(48, [44, 45, 46, 47].reduce((sum, number) => add(sum, get(number)), ZERO_DECIMAL));
  box.set(50, add(get(48), get(49)));
  box.set(51, add(equity, earningsOf(all)));

  // Other information (ITX23).
  const assets = await taxAssetTotals(tx, input.incomeYear);
  box.set(52, add(sub(get(13), assets.bookDepreciation), add(assets.boostClaimed, assets.depreciationClaimed)));
  box.set(53, untaxed);
  box.set(54, assets.additions);
  box.set(55, assets.disposalProceeds);
  let drawings = ZERO_DECIMAL;
  let dividends = ZERO_DECIMAL;
  for (const row of await accountTotals(tx, start, end)) {
    const account = byId.get(row.id);
    const movement = sub(dec(row.debits), dec(row.credits));
    if (account?.role === "drawings") drawings = add(drawings, movement);
    if (account?.role === "dividends_paid") dividends = add(dividends, movement);
  }
  box.set(56, dividends);
  box.set(57, drawings);
  box.set(58, currentAccounts);
  box.set(59, assets.loss);
  box.set(60, assets.boostAssetValue);

  const boxes: Record<number, string | null> = { 1: input.multipleActivity ? "Yes" : "No" };
  for (let number = 2; number <= 60; number += 1) {
    const value = box.get(number) ?? ZERO_DECIMAL;
    boxes[number] = number === 26 || isZero(value) ? null : money(value);
  }
  const netProfit = dec(input.workpaper.netProfit);
  const checks = [
    {
      label: "Box 27 equals the profit and loss's net profit",
      ok: cmp(get(27), netProfit) === 0,
      detail: `Box 27 ${moneyText(get(27))}; profit and loss ${moneyText(netProfit)}`,
    },
    {
      label: "Total assets less total liabilities equals owners' equity (43 - 50 = 51)",
      ok: cmp(sub(get(43), get(50)), get(51)) === 0,
      detail: `${moneyText(get(43))} - ${moneyText(get(50))} = ${moneyText(sub(get(43), get(50)))}; box 51 ${moneyText(get(51))}`,
    },
  ];
  const notes = [
    "Box 26 (exceptional items) is left blank: Tohyee doesn't separate them out. If they're over 5% of turnover, enter them in myIR.",
    "Boxes 54, 55 and 60 count only assets in the fixed asset register.",
    "Box 58 adds up current accounts' closing balances, with money owed to the owners positive (our reading; IRD's guide doesn't say).",
    "Amounts show cents; check whether myIR wants whole dollars.",
  ];
  return { boxes, labels: IR10_BOX_LABELS, checks, notes };
}
