import type { OrgTx } from "@/lib/db/org-transaction";
import { add, dec, sum, toFixedString, ZERO_DECIMAL, type Decimal } from "@/lib/money/decimal";
import { incomeYearDates, incomeYearOf, RD_CATEGORY_LABELS, type RdCategory, type RdIneligibleReason } from "@/lib/rd/amounts";
import { assetSharesForYear } from "@/lib/rd/assets";
import { optionalIncomeYear, rdSettings, yearLabel } from "@/lib/rd/common";
import { approvedYearsFor, type RdActivityRef } from "@/lib/rd/register";
import { loadTags, type RdTag } from "@/lib/rd/tags";
import { todayIsoDate } from "@/lib/dates";

/**
 * The tagged costs list: one income year's tags and asset depreciation shares
 * by activity, then by eligible category or ineligible reason. It totals what
 * is tagged; it isn't the claim: the claim report (claim.ts, stage R3) adds
 * pay, overhead rules, approvals, the limits and the 15% credit, so nothing
 * here is called "claimable".
 */

export type RdCostAssetShare = { assetId: string; assetNumber: string; assetName: string; hours: string; totalHours: string; amount: string };

export type RdCostGroup = {
  eligibility: "eligible" | "ineligible";
  category: RdCategory | null;
  ineligibleReason: RdIneligibleReason | null;
  label: string;
  /** The R&D share tagged (after the percentage, before deductions). */
  amount: string;
  unusedAmount: string;
  contractorIneligibleAmount: string;
  /** Eligible groups: the share less goods not used by year end and contractors' ineligible costs. Ineligible groups: 0.00. */
  countedAmount: string;
  tags: RdTag[];
  assets: RdCostAssetShare[];
};

export type RdCostActivity = {
  activity: RdActivityRef;
  approved: boolean;
  groups: RdCostGroup[];
  countedAmount: string;
  ineligibleAmount: string;
};

export type RdCosts = {
  incomeYear: number;
  incomeYearLabel: string;
  start: string;
  end: string;
  /** Income years with tags or asset records, newest first, for the year picker. */
  years: { incomeYear: number; label: string }[];
  activities: RdCostActivity[];
  countedAmount: string;
  ineligibleAmount: string;
  /** Tags whose document was voided or reversed after tagging; not counted. */
  voidedTags: RdTag[];
  lateCount: number;
  changedCount: number;
  noApprovalCount: number;
  assetWarnings: { assetId: string; assetNumber: string; warning: string }[];
};

export async function listTaggedCosts(tx: OrgTx, incomeYearInput: unknown): Promise<RdCosts> {
  const settings = await rdSettings(tx);
  const year = optionalIncomeYear(incomeYearInput, "incomeYear") ?? incomeYearOf(todayIsoDate(), settings.yearEndMonth);
  const { start, end } = incomeYearDates(year, settings.yearEndMonth);
  const tags = await loadTags(tx, "t.status = 'active' and t.work_date between $2 and $3", [start, end], "act.code, src.posted_on, src.document_id, src.line_id");
  const assets = await assetSharesForYear(tx, settings, year);
  const active = tags.filter((tag) => !tag.sourceVoided);
  const scale = settings.scale;
  const fixed = (value: Decimal) => toFixedString(value, scale);

  const activities = new Map<string, { activity: RdActivityRef; groups: Map<string, RdCostGroup> }>();
  const groupFor = (activity: RdActivityRef, key: Omit<RdCostGroup, "amount" | "unusedAmount" | "contractorIneligibleAmount" | "countedAmount" | "tags" | "assets">) => {
    const entry = activities.get(activity.id) ?? { activity, groups: new Map<string, RdCostGroup>() };
    activities.set(activity.id, entry);
    const id = `${key.eligibility}:${key.category ?? key.ineligibleReason}`;
    const zero = fixed(ZERO_DECIMAL);
    const group = entry.groups.get(id) ?? { ...key, amount: zero, unusedAmount: zero, contractorIneligibleAmount: zero, countedAmount: zero, tags: [], assets: [] };
    entry.groups.set(id, group);
    return group;
  };

  for (const tag of active) {
    const activity: RdActivityRef = { id: tag.activity.id, code: tag.activity.code, name: tag.activity.name, kind: tag.activity.kind, status: tag.activity.status };
    const group = groupFor(activity, {
      eligibility: tag.eligibility,
      category: tag.category,
      ineligibleReason: tag.ineligibleReason,
      label: tag.eligibility === "eligible" ? tag.categoryLabel! : tag.ineligibleReasonLabel!,
    });
    group.tags.push(tag);
    group.amount = fixed(add(dec(group.amount), dec(tag.amount)));
    group.unusedAmount = fixed(add(dec(group.unusedAmount), dec(tag.unusedAmount)));
    group.contractorIneligibleAmount = fixed(add(dec(group.contractorIneligibleAmount), dec(tag.contractorIneligibleAmount)));
    group.countedAmount = fixed(add(dec(group.countedAmount), dec(tag.countedAmount)));
  }

  const assetWarnings: RdCosts["assetWarnings"] = [];
  for (const { asset, year: assetYear } of assets) {
    for (const warning of assetYear.warnings) assetWarnings.push({ assetId: asset.id, assetNumber: asset.assetNumber, warning });
    for (const share of assetYear.shares) {
      const group = groupFor(share.activity, { eligibility: "eligible", category: "depreciation", ineligibleReason: null, label: RD_CATEGORY_LABELS.depreciation });
      group.assets.push({ assetId: asset.id, assetNumber: asset.assetNumber, assetName: asset.name, hours: share.hours, totalHours: assetYear.totalHours, amount: share.amount });
      group.amount = fixed(add(dec(group.amount), dec(share.amount)));
      group.countedAmount = fixed(add(dec(group.countedAmount), dec(share.amount)));
    }
  }

  const approved = await approvedYearsFor(tx, [...activities.keys()]);
  const order = (group: RdCostGroup) => (group.eligibility === "eligible" ? 0 : 1);
  const list: RdCostActivity[] = [...activities.values()]
    .sort((a, b) => a.activity.code.localeCompare(b.activity.code))
    .map(({ activity, groups }) => {
      const sorted = [...groups.values()].sort((a, b) => order(a) - order(b) || a.label.localeCompare(b.label));
      return {
        activity,
        approved: approved.get(activity.id)?.has(year) ?? false,
        groups: sorted,
        countedAmount: fixed(sum(sorted.map((group) => dec(group.countedAmount)))),
        ineligibleAmount: fixed(sum(sorted.filter((group) => group.eligibility === "ineligible").map((group) => dec(group.amount)))),
      };
    });

  const years = (
    await tx.query<{ work_date: string }>(
      `select distinct work_date::text from rd_tags where status = 'active'
       union select distinct work_date::text from rd_asset_usage where status = 'active'
       union select make_date(income_year, $1, 1)::text from rd_asset_tax_depreciation`,
      [settings.yearEndMonth],
    )
  ).rows.map((row) => incomeYearOf(row.work_date, settings.yearEndMonth));
  const yearList = [...new Set([year, ...years])].sort((a, b) => b - a).map((incomeYear) => ({ incomeYear, label: yearLabel(settings, incomeYear) }));

  return {
    incomeYear: year,
    incomeYearLabel: yearLabel(settings, year),
    start,
    end,
    years: yearList,
    activities: list,
    countedAmount: fixed(sum(list.map((activity) => dec(activity.countedAmount)))),
    ineligibleAmount: fixed(sum(list.map((activity) => dec(activity.ineligibleAmount)))),
    voidedTags: tags.filter((tag) => tag.sourceVoided),
    lateCount: active.filter((tag) => tag.timeliness.enteredLate).length,
    changedCount: active.filter((tag) => tag.version > 1).length,
    noApprovalCount: active.filter((tag) => !approved.get(tag.activity.id)?.has(year)).length,
    assetWarnings,
  };
}
