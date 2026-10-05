import { writeAuditEvent } from "@/lib/audit";
import { csvCell } from "@/lib/csv";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { cmp, dec, sum, toFixedString, ZERO_DECIMAL, type Decimal } from "@/lib/money/decimal";
import { incomeYearDates, incomeYearOf, RD_CATEGORY_LABELS, RD_INELIGIBLE_REASONS, type RdCategory, type RdIneligibleReason } from "@/lib/rd/amounts";
import { assetSharesForYear } from "@/lib/rd/assets";
import { calculateClaim, RD_CLAIM_CATEGORIES, type ClaimBucketInput, type ClaimFigures } from "@/lib/rd/claim-figures";
import { iso, optionalIncomeYear, rdSettings, writeHistory, yearLabel, type RdSettings } from "@/lib/rd/common";
import { dueReminders, longDate, rdDeadlines, type RdDeadlines, type RdReminder } from "@/lib/rd/deadlines";
import { applyOverheadRules, type RdOverheadApplied } from "@/lib/rd/overheads";
import { loadRdPays, type RdPay } from "@/lib/rd/payroll";
import { listActivities, type RdActivity } from "@/lib/rd/register";
import { loadTags } from "@/lib/rd/tags";

/**
 * The RDTI claim report for an income year (stage R3; examples RD3, RD4,
 * RD7, RD10, RD16-RD20, RD23-RD42; decisions 30-50, 66-75). Read-only: it
 * posts nothing and changes no amount (an export only records its summary).
 * Built on the R2 tags, asset tax depreciation, the overhead rules and
 * posted pay runs. Tohyee never says an activity qualifies: IRD decides.
 */

export type RdClaimSource = "tag" | "asset" | "overhead" | "payroll";

export type RdClaimItem = {
  source: RdClaimSource;
  /** Tag, asset, overhead rule or pay run id. */
  recordId: string;
  activityId: string;
  activityCode: string;
  category: RdCategory;
  date: string;
  incomeYear: number;
  label: string;
  amount: string;
  overseas: boolean;
  internalSoftware: boolean;
  commercialProduction: boolean;
  feedstock: boolean;
  /** Supporting activity from the year before its core activity's first year (RD4). */
  carriedIn: boolean;
  enteredLate: boolean;
  timelinessText: string | null;
  /** Payroll items only, and only for people with payroll access. */
  employeeName: string | null;
  /** How many pays a payroll total stands for, when employee detail is hidden. */
  payCount: number | null;
};

export type RdNotCountedReason =
  | "no_approval"
  | "no_core_activity"
  | "claim_next_year"
  | "default_split"
  | "feedstock"
  | "commercial_production"
  | "unused_by_year_end"
  | "voided";

export type RdNotCounted = { reason: RdNotCountedReason; label: string; note: string | null; amount: string; items: RdClaimItem[] };

export type RdClaimActivity = {
  activity: Pick<RdActivity, "id" | "code" | "name" | "projectName" | "kind" | "place" | "status" | "changedSinceApproval"> & { supports: string[] };
  approved: boolean;
  /** Counted amounts by category before the overseas limit. */
  categories: Record<RdCategory, string>;
  counted: string;
  notCounted: string;
  items: RdClaimItem[];
};

export type RdIneligibleGroup = { reason: RdIneligibleReason; label: string; source: string; amount: string; items: RdClaimItem[] };

export type RdClaimPayroll = {
  /** Whether the viewer has payroll access and sees each employee's pay. */
  detail: boolean;
  pays: RdPay[] | null;
  counted: string;
  defaultSplit: string;
  /** Reimbursements on the pay runs: not employee costs (decision 66). */
  excluded: string;
  lateCount: number;
};

export type RdClaimDifference = { figure: string; before: string | null; after: string | null };

export type RdClaimExport = { exportedAt: string; exportedByEmail: string; differences: RdClaimDifference[] };

export type RdClaimReport = {
  incomeYear: number;
  incomeYearLabel: string;
  start: string;
  end: string;
  years: { incomeYear: number; label: string }[];
  figures: ClaimFigures;
  activities: RdClaimActivity[];
  notCounted: RdNotCounted[];
  ineligible: RdIneligibleGroup[];
  ineligibleTotal: string;
  overheads: RdOverheadApplied[];
  payroll: RdClaimPayroll;
  deadlines: RdDeadlines;
  reminders: RdReminder[] | null;
  notes: string[];
  materialChanges: string[];
  lateCount: number;
  changedCount: number;
  lastExport: RdClaimExport | null;
};

const NOT_COUNTED_ORDER: RdNotCountedReason[] = [
  "no_approval",
  "no_core_activity",
  "claim_next_year",
  "default_split",
  "feedstock",
  "commercial_production",
  "unused_by_year_end",
  "voided",
];

const SIGNIFICANT_PERFORMER = dec("2000000");

function emptyCategories(zero: string): Record<RdCategory, string> {
  return { materials_overheads: zero, depreciation: zero, employee: zero, contract: zero, approved_research_provider: zero };
}

function notCountedLabel(reason: RdNotCountedReason, settings: RdSettings, year: number): string {
  const label = yearLabel(settings, year);
  switch (reason) {
    case "no_approval":
      return `No approval entered for ${label}`;
    case "no_core_activity":
      return `Supporting activity: none of the core activities it supports has an approval for ${label}`;
    case "claim_next_year":
      return `Supporting activity before its core activity: claim with ${yearLabel(settings, year + 1)}`;
    case "default_split":
      return "Default split, no time record";
    case "feedstock":
      return "Feedstock: the output's value isn't recorded, so it isn't counted";
    case "commercial_production":
      return "Commercial production: only employee related costs count (LY 5(1)(c))";
    case "unused_by_year_end":
      return "Goods not used by year end: tag them in the year they're used";
    case "voided":
      return "Document voided or reversed after tagging";
  }
}

type Candidate = { item: RdClaimItem; activity: RdActivity };

export type ClaimOptions = { payrollDetail: boolean; showReminders: boolean; today?: string };

/** The claim report for an income year (viewers and above; decision 75). */
export async function buildClaimReport(tx: OrgTx, incomeYearInput: unknown, options: ClaimOptions): Promise<RdClaimReport> {
  const settings = await rdSettings(tx);
  const today = options.today ?? todayIsoDate();
  const year = optionalIncomeYear(incomeYearInput, "incomeYear") ?? incomeYearOf(today, settings.yearEndMonth);
  const { start, end } = incomeYearDates(year, settings.yearEndMonth);
  const previous = incomeYearDates(year - 1, settings.yearEndMonth);
  const scale = settings.scale;
  const fixed = (value: Decimal) => toFixedString(value, scale);
  const zero = fixed(ZERO_DECIMAL);
  const label = yearLabel(settings, year);

  const activities = await listActivities(tx, { includeArchived: true });
  const byId = new Map(activities.map((activity) => [activity.id, activity]));
  const approvedFor = (activity: RdActivity, forYear: number) => activity.approvedYears.includes(forYear);
  const yearOf = (date: string) => incomeYearOf(date, settings.yearEndMonth);

  const base = (activity: RdActivity, fields: Omit<RdClaimItem, "activityId" | "activityCode" | "incomeYear" | "carriedIn" | "employeeName" | "payCount"> & { employeeName?: string | null }): RdClaimItem => ({
    activityId: activity.id,
    activityCode: activity.code,
    incomeYear: yearOf(fields.date),
    carriedIn: false,
    payCount: null,
    ...fields,
    employeeName: fields.employeeName ?? null,
  });

  const candidates: Candidate[] = [];
  const notCounted = new Map<RdNotCountedReason, RdClaimItem[]>();
  const listNotCounted = (reason: RdNotCountedReason, item: RdClaimItem) => notCounted.set(reason, [...(notCounted.get(reason) ?? []), item]);
  const ineligible = new Map<RdIneligibleReason, RdClaimItem[]>();

  // Tags (RD8, RD9, RD12, RD13) in this year and the year before (RD4).
  const tags = await loadTags(tx, "t.status = 'active' and t.work_date between $2 and $3", [previous.start, end], "act.code, src.posted_on, src.document_id, src.line_id");
  let changedCount = 0;
  for (const tag of tags) {
    const activity = byId.get(tag.activity.id);
    if (!activity) continue;
    const inYear = tag.incomeYear === year;
    const item = (amount: string) =>
      base(activity, {
        source: "tag",
        recordId: tag.id,
        category: tag.category ?? "materials_overheads",
        date: tag.timeliness.workDate,
        label: `${tag.documentLabel}: ${tag.description}`,
        amount,
        overseas: tag.overseas,
        internalSoftware: tag.internalSoftware,
        commercialProduction: tag.commercialProduction,
        feedstock: tag.feedstock,
        enteredLate: tag.timeliness.enteredLate,
        timelinessText: tag.timeliness.timelinessText,
      });
    if (inYear && tag.version > 1) changedCount += 1;
    if (tag.sourceVoided) {
      if (inYear) listNotCounted("voided", item(tag.amount));
      continue;
    }
    if (tag.eligibility === "ineligible") {
      if (inYear && tag.ineligibleReason) ineligible.set(tag.ineligibleReason, [...(ineligible.get(tag.ineligibleReason) ?? []), item(tag.amount)]);
      continue;
    }
    if (inYear && cmp(dec(tag.unusedAmount), ZERO_DECIMAL) > 0) listNotCounted("unused_by_year_end", item(tag.unusedAmount));
    if (cmp(dec(tag.countedAmount), ZERO_DECIMAL) > 0) candidates.push({ item: item(tag.countedAmount), activity });
  }

  // Tax depreciation by usage (RD11).
  const assetWarnings: string[] = [];
  for (const forYear of [year - 1, year]) {
    for (const { asset, year: assetYear } of await assetSharesForYear(tx, settings, forYear)) {
      if (forYear === year) for (const warning of assetYear.warnings) assetWarnings.push(`${asset.assetNumber}: ${warning}`);
      for (const share of assetYear.shares) {
        const activity = byId.get(share.activity.id);
        if (!activity || cmp(dec(share.amount), ZERO_DECIMAL) <= 0) continue;
        const yearDates = incomeYearDates(forYear, settings.yearEndMonth);
        candidates.push({
          activity,
          item: base(activity, {
            source: "asset",
            recordId: asset.id,
            category: "depreciation",
            date: yearDates.end,
            label: `${asset.assetNumber} ${asset.name}: ${share.hours} of ${assetYear.totalHours} hours`,
            amount: share.amount,
            overseas: activity.place === "overseas",
            internalSoftware: false,
            commercialProduction: false,
            feedstock: false,
            enteredLate: false,
            timelinessText: null,
          }),
        });
      }
    }
  }

  // Overhead rules (RD10, RD34, RD35).
  const overheadsBefore = await applyOverheadRules(tx, previous.start, previous.end);
  const overheads = await applyOverheadRules(tx, start, end);
  for (const applied of [...overheadsBefore, ...overheads]) {
    const activity = byId.get(applied.rule.activity.id);
    if (!activity) continue;
    for (const share of applied.shares) {
      if (cmp(dec(share.amount), ZERO_DECIMAL) <= 0) continue;
      candidates.push({
        activity,
        item: base(activity, {
          source: "overhead",
          recordId: applied.rule.id,
          category: "materials_overheads",
          date: share.postedOn,
          label: `${share.documentLabel}: ${share.description} (${applied.rule.percentage}% of ${share.lineAmount}, ${applied.rule.basisLabel.toLowerCase()})`,
          amount: share.amount,
          overseas: activity.place === "overseas",
          internalSoftware: false,
          commercialProduction: false,
          feedstock: false,
          enteredLate: applied.rule.timeliness.enteredLate,
          timelinessText: applied.rule.timeliness.timelinessText,
        }),
      });
    }
  }

  // Pay (RD28-RD32, TS5-TS9): timesheet shares count; allocation shares only when 100% R&D (decisions 34, 100).
  const pays = await loadRdPays(tx, previous.start, end);
  let payrollLate = 0;
  let excluded: Decimal = ZERO_DECIMAL;
  for (const pay of pays) {
    const inYear = yearOf(pay.payDate) === year;
    if (inYear) excluded = sum([excluded, dec(pay.excluded)]);
    if (inYear && pay.enteredLate && pay.shares.length > 0) payrollLate += 1;
    for (const share of pay.shares) {
      const activity = byId.get(share.activityId);
      if (!activity || cmp(dec(share.amount), ZERO_DECIMAL) <= 0) continue;
      const item = base(activity, {
        source: "payroll",
        recordId: pay.payRunId,
        category: "employee",
        date: pay.payDate,
        label:
          share.source === "timesheet"
            ? `${pay.payRunReference} paid ${pay.payDate}: ${share.hours} h on the approved timesheet, ${share.percentage}% of ${pay.cost}`
            : `${pay.payRunReference} paid ${pay.payDate}: ${share.percentage}% of ${pay.cost}`,
        amount: share.amount,
        overseas: activity.place === "overseas",
        internalSoftware: false,
        commercialProduction: false,
        feedstock: false,
        enteredLate: share.enteredLate,
        timelinessText: share.timelinessText,
        employeeName: pay.employeeName,
      });
      if (!share.counts) {
        if (inYear) listNotCounted("default_split", item);
        continue;
      }
      candidates.push({ activity, item });
    }
  }

  // Which candidates count (decisions 47, 69, 71; RD3, RD4, RD37-RD39).
  const counted: RdClaimItem[] = [];
  const cores = (activity: RdActivity) => activity.supports.map((ref) => byId.get(ref.id)).filter((core): core is RdActivity => core != null);
  for (const { item, activity } of candidates) {
    const supporting = activity.kind === "supporting" ? cores(activity) : [];
    if (item.incomeYear !== year) {
      // The year before: only supporting activity whose core activities start this year (RD4).
      const carry = supporting.length > 0 && supporting.every((core) => core.firstIncomeYear >= year) && supporting.some((core) => core.firstIncomeYear === year);
      if (item.incomeYear !== year - 1 || !carry) continue;
      item.carriedIn = true;
    } else if (supporting.length > 0 && supporting.every((core) => core.firstIncomeYear > year) && supporting.some((core) => core.firstIncomeYear === year + 1)) {
      listNotCounted("claim_next_year", item);
      continue;
    }
    if (!approvedFor(activity, year)) {
      listNotCounted("no_approval", item);
      continue;
    }
    if (activity.kind === "supporting" && !supporting.some((core) => approvedFor(core, year))) {
      listNotCounted("no_core_activity", item);
      continue;
    }
    if (item.feedstock) {
      listNotCounted("feedstock", item);
      continue;
    }
    if (item.commercialProduction && item.category !== "employee") {
      listNotCounted("commercial_production", item);
      continue;
    }
    counted.push(item);
  }

  // Buckets for the figures.
  const buckets = new Map<string, ClaimBucketInput>();
  for (const item of counted) {
    const activity = byId.get(item.activityId)!;
    const key = [item.activityId, item.category, item.overseas, item.internalSoftware, item.commercialProduction, item.carriedIn].join("|");
    const bucket = buckets.get(key) ?? {
      activityId: activity.id,
      activityCode: activity.code,
      projectName: activity.projectName,
      kind: activity.kind,
      category: item.category,
      overseas: item.overseas,
      internalSoftware: item.internalSoftware,
      commercialProduction: item.commercialProduction,
      carriedIn: item.carriedIn,
      amount: zero,
    };
    bucket.amount = fixed(sum([dec(bucket.amount), dec(item.amount)]));
    buckets.set(key, bucket);
  }
  const ordered = [...buckets.values()].sort(
    (a, b) => a.projectName.localeCompare(b.projectName) || a.activityCode.localeCompare(b.activityCode) || RD_CLAIM_CATEGORIES.indexOf(a.category) - RD_CLAIM_CATEGORIES.indexOf(b.category),
  );
  const figures = calculateClaim(ordered, scale);

  // Hide each employee's pay from people without payroll access (decision 75).
  const shown = (items: RdClaimItem[]): RdClaimItem[] => {
    if (options.payrollDetail) return items;
    const others = items.filter((item) => item.source !== "payroll");
    const totals = new Map<string, RdClaimItem>();
    for (const item of items.filter((entry) => entry.source === "payroll")) {
      const key = `${item.activityId}|${item.category}|${item.carriedIn}`;
      const total = totals.get(key);
      if (total) {
        total.amount = fixed(sum([dec(total.amount), dec(item.amount)]));
        total.payCount = (total.payCount ?? 0) + 1;
        total.enteredLate = total.enteredLate || item.enteredLate;
      } else {
        totals.set(key, { ...item, recordId: "", label: "Pay runs (each employee's pay needs payroll access)", date: item.date, employeeName: null, timelinessText: null, payCount: 1 });
      }
    }
    return [...others, ...totals.values()];
  };

  const activityIds = new Set([...counted, ...[...notCounted.values()].flat(), ...[...ineligible.values()].flat()].map((item) => item.activityId));
  const activityRows: RdClaimActivity[] = activities
    .filter((activity) => activityIds.has(activity.id))
    .map((activity) => {
      const mine = counted.filter((item) => item.activityId === activity.id);
      const categories = emptyCategories(zero);
      for (const category of RD_CLAIM_CATEGORIES) categories[category] = fixed(sum(mine.filter((item) => item.category === category).map((item) => dec(item.amount))));
      const left = [...notCounted.values()].flat().filter((item) => item.activityId === activity.id);
      return {
        activity: {
          id: activity.id,
          code: activity.code,
          name: activity.name,
          projectName: activity.projectName,
          kind: activity.kind,
          place: activity.place,
          status: activity.status,
          changedSinceApproval: activity.changedSinceApproval,
          supports: activity.supports.map((core) => core.code),
        },
        approved: approvedFor(activity, year),
        categories,
        counted: fixed(sum(mine.map((item) => dec(item.amount)))),
        notCounted: fixed(sum(left.map((item) => dec(item.amount)))),
        items: shown(mine),
      };
    })
    .sort((a, b) => a.activity.projectName.localeCompare(b.activity.projectName) || a.activity.code.localeCompare(b.activity.code));

  const deadlines = rdDeadlines(year, settings.yearEndMonth);
  const generalApproval = deadlines.supported ? deadlines.deadlines.find((entry) => entry.kind === "general_approval")! : null;
  const notCountedList: RdNotCounted[] = NOT_COUNTED_ORDER.filter((reason) => notCounted.has(reason)).map((reason) => {
    const items = notCounted.get(reason)!;
    return {
      reason,
      label: notCountedLabel(reason, settings, year),
      note:
        reason === "no_approval" && generalApproval && today > generalApproval.onTimeBy
          ? `Claimable only if general approval was applied for by ${longDate(generalApproval.dueDate)} (TAA 68CB(2B); IR1240 p 19).`
          : null,
      amount: fixed(sum(items.map((item) => dec(item.amount)))),
      items: shown(items),
    };
  });

  const ineligibleList: RdIneligibleGroup[] = [...ineligible.entries()]
    .map(([reason, items]) => ({
      reason,
      label: RD_INELIGIBLE_REASONS[reason].label,
      source: RD_INELIGIBLE_REASONS[reason].source,
      amount: fixed(sum(items.map((item) => dec(item.amount)))),
      items,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const yearPays = pays.filter((pay) => yearOf(pay.payDate) === year);
  const payrollCounted = counted.filter((item) => item.source === "payroll" && item.incomeYear === year);
  const payroll: RdClaimPayroll = {
    detail: options.payrollDetail,
    pays: options.payrollDetail ? yearPays : null,
    counted: fixed(sum(payrollCounted.map((item) => dec(item.amount)))),
    defaultSplit: fixed(sum((notCounted.get("default_split") ?? []).map((item) => dec(item.amount)))),
    excluded: fixed(excluded),
    lateCount: payrollLate,
  };

  const yearItemActivities = new Set([...counted, ...[...notCounted.values()].flat()].map((item) => item.activityId));
  const changed = activities.filter((activity) => yearItemActivities.has(activity.id) && activity.changedSinceApproval);
  const materialChanges = changed.map(
    (activity) => `${activity.code} (${activity.projectName}) changed since its approval was entered, so the supplementary return's “no material change” declaration can't be prefilled for that project (RD3, RD27).`,
  );

  const notes: string[] = [...assetWarnings];
  if (cmp(dec(figures.totalEligible), SIGNIFICANT_PERFORMER) > 0) {
    notes.push("Eligible expenditure is over $2 million: the significant performer route (criteria and methodologies approval, TAA 68CC) exists; Tohyee doesn't support it.");
  }
  notes.push("An organisation and its associates share the $120 million maximum (IR1240 p 72-73); Tohyee can't see associates' figures.");
  if (cmp(dec(payroll.excluded), ZERO_DECIMAL) > 0) {
    notes.push(`Reimbursements of ${payroll.excluded} on pay runs aren't employee costs and aren't counted (decision 66).`);
  }
  // Timesheets approved after the pay run they'd have covered aren't used (TS9; decision 37).
  const laterTimesheets = yearPays.flatMap((pay) => pay.laterTimesheets.map((later) => ({ pay, later })));
  if (options.payrollDetail) {
    for (const { pay, later } of laterTimesheets) {
      notes.push(
        `${pay.employeeName}: the timesheet for the week of ${longDate(later.weekStart)} was approved after ${pay.payRunReference}, so its ${later.rdHours} R&D hours aren't used (decision 37).`,
      );
    }
  } else if (laterTimesheets.length > 0) {
    notes.push(
      `${laterTimesheets.length} timesheet${laterTimesheets.length === 1 ? " was" : "s were"} approved after ${laterTimesheets.length === 1 ? "its pay run" : "their pay runs"}, so ${laterTimesheets.length === 1 ? "its" : "their"} R&D hours aren't used (decision 37).`,
    );
  }

  const lateCount =
    counted.concat([...notCounted.values()].flat()).filter((item) => item.enteredLate && item.incomeYear === year && item.source === "tag").length +
    payrollLate +
    overheads.filter((applied) => applied.rule.timeliness.enteredLate).length;

  const reminders = options.showReminders
    ? dueReminders({
        incomeYear: year,
        yearEndMonth: settings.yearEndMonth,
        today,
        approvalEntered: activities.some((activity) => approvedFor(activity, year)),
        materialChange: changed.length > 0,
      })
    : null;

  const report: RdClaimReport = {
    incomeYear: year,
    incomeYearLabel: label,
    start,
    end,
    years: await claimYears(tx, settings, year),
    figures,
    activities: activityRows,
    notCounted: notCountedList,
    ineligible: ineligibleList,
    ineligibleTotal: fixed(sum(ineligibleList.map((group) => dec(group.amount)))),
    overheads,
    payroll,
    deadlines,
    reminders,
    notes,
    materialChanges,
    lateCount,
    changedCount,
    lastExport: null,
  };
  report.lastExport = await lastExport(tx, year, summaryFigures(report));
  return report;
}

async function claimYears(tx: OrgTx, settings: RdSettings, year: number): Promise<{ incomeYear: number; label: string }[]> {
  const dates = (
    await tx.query<{ day: string }>(
      `select distinct work_date::text as day from rd_tags where status = 'active'
       union select distinct work_date::text from rd_asset_usage where status = 'active'
       union select make_date(income_year, $1, 1)::text from rd_asset_tax_depreciation
       union select distinct effective_from::text from rd_overhead_rules
       union select distinct r.pay_date::text from payroll_pay_runs r
        where r.status = 'approved' and exists (
          select 1 from payroll_pay_run_employees e join payroll_cost_allocations a on a.employee_id = e.employee_id
            join payroll_cost_allocation_lines l on l.allocation_id = a.id
           where e.pay_run_id = r.id and l.rd_activity_id is not null
          union all
          select 1 from payroll_pay_run_shares s where s.pay_run_id = r.id and s.rd_activity_id is not null)`,
      [settings.yearEndMonth],
    )
  ).rows.map((row) => incomeYearOf(row.day, settings.yearEndMonth));
  return [...new Set([year, ...dates])].sort((a, b) => b - a).map((incomeYear) => ({ incomeYear, label: yearLabel(settings, incomeYear) }));
}

/** The figures an export keeps (decision 74): no employee's pay. */
export function summaryFigures(report: Pick<RdClaimReport, "figures">): Record<string, string> {
  const figures = report.figures;
  const result: Record<string, string> = {};
  for (const project of figures.projects) {
    for (const category of RD_CLAIM_CATEGORIES) result[`${RD_CATEGORY_LABELS[category]} (${project.projectName})`] = project.categories[category];
    result[`Overseas, counted (${project.projectName})`] = project.overseasCounted;
    result[`Core activities' share % (${project.projectName})`] = project.coreShare ?? "";
    result[`Total (${project.projectName})`] = project.total;
  }
  result["NZ eligible"] = figures.nzTotal;
  result["Overseas spent"] = figures.overseasSpent;
  result["Overseas limit"] = figures.overseasLimit;
  result["Total eligible R&D expenditure"] = figures.totalEligible;
  result["Claimed"] = figures.claimed;
  result["R&D tax credit"] = figures.credit;
  return result;
}

async function lastExport(tx: OrgTx, year: number, now: Record<string, string>): Promise<RdClaimExport | null> {
  const row = (
    await tx.query<{ snapshot: { figures?: Record<string, string> }; changed_by_email: string; created_at: Date }>(
      `select snapshot, changed_by_email, created_at from rd_history where record_type = 'claim_export' and record_id = $1 order by version desc limit 1`,
      [String(year)],
    )
  ).rows[0];
  if (!row) return null;
  const before = row.snapshot.figures ?? {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(now)])];
  return {
    exportedAt: iso(row.created_at),
    exportedByEmail: row.changed_by_email,
    differences: keys.filter((key) => before[key] !== now[key]).map((key) => ({ figure: key, before: before[key] ?? null, after: now[key] ?? null })),
  };
}


/** The report as CSV: one row per figure, then the lines behind them (RD27, RD42). */
export function claimCsv(report: RdClaimReport): string {
  const rows: Array<Array<string | number | null>> = [["Section", "Project", "Activity", "Category", "Date", "Description", "Employee", "Amount"]];
  const f = report.figures;
  for (const project of f.projects) {
    for (const category of RD_CLAIM_CATEGORIES) rows.push(["Return", project.projectName, null, RD_CATEGORY_LABELS[category], null, null, null, project.categories[category]]);
    rows.push(["Return", project.projectName, null, "Of which overseas (counted)", null, `spent ${project.overseasSpent}, over the limit ${project.overseasOverLimit}`, null, project.overseasCounted]);
    rows.push(["Return", project.projectName, null, "Of which internal software development", null, null, null, project.internalSoftware]);
    rows.push(["Return", project.projectName, null, "Of which commercial production", null, null, null, project.commercialProduction]);
    rows.push(["Return", project.projectName, null, "Of which supporting activity from the year before", null, null, null, project.carriedIn]);
    rows.push(["Return", project.projectName, null, "Core activities' share %", null, null, null, project.coreShare]);
    rows.push(["Return", project.projectName, null, "Total", null, null, null, project.total]);
  }
  rows.push(["Claim", null, null, "NZ eligible", null, null, null, f.nzTotal]);
  rows.push(["Claim", null, null, "Overseas spent", null, null, null, f.overseasSpent]);
  rows.push(["Claim", null, null, "Overseas limit", null, null, null, f.overseasLimit]);
  rows.push(["Claim", null, null, "Overseas over the limit", null, null, null, f.overseasOverLimit]);
  rows.push(["Claim", null, null, "Total eligible R&D expenditure", null, null, null, f.totalEligible]);
  rows.push(["Claim", null, null, "Over the $120 million maximum", null, null, null, f.overMaximum]);
  rows.push(["Claim", null, null, "Claimed", null, f.status, null, f.claimed]);
  rows.push(["Claim", null, null, "R&D tax credit", null, null, null, f.credit]);
  for (const activity of report.activities) {
    for (const item of activity.items) {
      rows.push(["Counted", activity.activity.projectName, activity.activity.code, RD_CATEGORY_LABELS[item.category], item.date, item.label, item.employeeName, item.amount]);
    }
  }
  for (const group of report.notCounted) {
    for (const item of group.items) rows.push([`Not counted: ${group.label}`, null, item.activityCode, RD_CATEGORY_LABELS[item.category], item.date, item.label, item.employeeName, item.amount]);
  }
  for (const group of report.ineligible) {
    for (const item of group.items) rows.push([`Ineligible: ${group.label}`, null, item.activityCode, null, item.date, item.label, null, item.amount]);
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/**
 * Exports the report as CSV and records the export's summary figures with
 * who and when in the R&D history (decision 74; RD42). Nothing is filed.
 */
export async function exportClaim(tx: OrgTx, incomeYearInput: unknown, options: ClaimOptions): Promise<{ fileName: string; csv: string }> {
  const report = await buildClaimReport(tx, incomeYearInput, options);
  await writeHistory(tx, "claim_export", String(report.incomeYear), "exported", {
    incomeYear: report.incomeYear,
    figures: summaryFigures(report),
  });
  await writeAuditEvent(tx, { eventType: "rd.claim_exported", entityType: "rd_claim", entityId: String(report.incomeYear), details: { credit: report.figures.credit } });
  return { fileName: `rd-claim-${report.incomeYearLabel}.csv`, csv: claimCsv(report) };
}

/**
 * Reminders due today for owners and admins (RD25, RD41; decision 48):
 * this income year's and last year's, for an organisation with R&D
 * activities in that year.
 */
export async function rdReminders(tx: OrgTx, today = todayIsoDate()): Promise<RdReminder[]> {
  const settings = await rdSettings(tx);
  const activities = await listActivities(tx, { includeArchived: true });
  if (activities.length === 0) return [];
  const current = incomeYearOf(today, settings.yearEndMonth);
  const reminders: RdReminder[] = [];
  for (const year of [current - 1, current]) {
    const inYear = activities.filter((activity) => activity.firstIncomeYear <= year && (activity.lastIncomeYear == null || activity.lastIncomeYear >= year));
    if (inYear.length === 0) continue;
    reminders.push(
      ...dueReminders({
        incomeYear: year,
        yearEndMonth: settings.yearEndMonth,
        today,
        approvalEntered: inYear.some((activity) => activity.approvedYears.includes(year)),
        materialChange: inYear.some((activity) => activity.changedSinceApproval && activity.approvedYears.includes(year)),
      }),
    );
  }
  return reminders.sort((a, b) => a.onTimeBy.localeCompare(b.onTimeBy));
}
