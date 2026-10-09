import { writeAuditEvent } from "@/lib/audit";
import {
  attainment,
  type ForecastCategory,
  type ForecastFigures,
  forecastFigures,
  type ForecastPeriod,
  type ForecastPeriodKind,
  forecastPeriods,
  FORECAST_PERIODS,
  type StageType,
  weightedAmount,
} from "@/lib/crm/forecast-figures";
import type { CrmScope } from "@/lib/crm/access";
import { requireCrm } from "@/lib/crm/switch";
import { parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, cmp, dec, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { listMembers } from "@/lib/organisations/members";

/**
 * Forecasts (examples CRMS8-CRMS10, decisions 85-90), after Salesforce's
 * Collaborative Forecasts by opportunity close date: per month or quarter
 * of the financial year, per owner and per currency (never added across
 * currencies), with the cumulative Closed, Commit, Best case and Open
 * pipeline totals and the weighted pipeline, and quotas per owner per
 * month in the base currency. Read-only: it's worked out from the
 * opportunities each time.
 */

export const MAX_FORECAST_PERIODS = 12;

/** One opportunity as the forecast sees it, for drilling down. */
export type ForecastOpportunity = {
  id: string;
  name: string;
  contactName: string;
  ownerUserId: string | null;
  periodStart: string;
  closeDate: string;
  currencyCode: string;
  amount: string;
  stage: string;
  stageName: string;
  stageType: StageType;
  probability: number;
  forecastCategory: ForecastCategory;
  weightedAmount: string;
};

export type ForecastRow = ForecastFigures & {
  periodStart: string;
  /** null: opportunities with no owner ("No owner"). */
  ownerUserId: string | null;
  ownerName: string;
  currencyCode: string;
  /** In the base currency, for base-currency rows of an owner with a quota; null otherwise. */
  quota: string | null;
  /** Closed ÷ quota, a percentage to 2 places; null without a quota. */
  attainment: string | null;
};

export type Forecast = {
  period: ForecastPeriodKind;
  baseCurrency: string;
  financialYearEndMonth: number;
  periods: ForecastPeriod[];
  /** Per period, owner and currency, in period order, then owner name, base currency first. */
  rows: ForecastRow[];
  /** Per period and currency, every owner together. */
  totals: Array<ForecastFigures & { periodStart: string; currencyCode: string }>;
  /** Quotas per owner per period (base currency), including owners with nothing closing then. */
  quotas: Array<{ periodStart: string; ownerUserId: string; amount: string }>;
  opportunities: ForecastOpportunity[];
  /** Open opportunities (of the owner asked for) with no expected close date, which no forecast includes. */
  noCloseDate: number;
};

function parsePeriodKind(input: unknown): ForecastPeriodKind {
  if (input === undefined || input === null || input === "") return "month";
  if (typeof input !== "string" || !(FORECAST_PERIODS as readonly string[]).includes(input)) throw new ValidationError('The period must be "month" or "quarter".');
  return input as ForecastPeriodKind;
}

function parseCount(input: unknown, kind: ForecastPeriodKind): number {
  if (input === undefined || input === null || input === "") return kind === "month" ? 3 : 4;
  const text = typeof input === "number" ? String(input) : typeof input === "string" ? input.trim() : "";
  if (!/^\d{1,2}$/.test(text) || Number(text) < 1 || Number(text) > MAX_FORECAST_PERIODS) {
    throw new ValidationError(`Show from 1 to ${MAX_FORECAST_PERIODS} periods.`);
  }
  return Number(text);
}

/**
 * The forecast from the period containing `from` (today when not given)
 * for `periods` months or quarters (CRMS8, CRMS9), for every owner or the
 * one asked for ("none" for opportunities with no owner).
 */
export async function forecast(
  tx: OrgTx,
  input: { period?: unknown; from?: unknown; periods?: unknown; ownerUserId?: unknown } = {},
  scope?: CrmScope,
): Promise<Forecast> {
  const kind = parsePeriodKind(input.period);
  const from = input.from === undefined || input.from === null || input.from === "" ? todayIsoDate() : parseIsoDate(input.from, "from");
  const count = parseCount(input.periods, kind);
  const owner = typeof input.ownerUserId === "string" && input.ownerUserId !== "" ? input.ownerUserId : null;
  // A sales rep's forecast is their own; a manager's, their teams' (decision 491).
  if (owner !== null && scope?.owners && !scope.owners.includes(owner)) throw new NotFoundError("That person's forecast isn't yours to see.");
  const owners = scope?.owners ?? null;
  const settings = await tx.query<{ financial_year_end_month: number }>("select financial_year_end_month from organisation_settings where id = true");
  const yearEndMonth = settings.rows[0]?.financial_year_end_month ?? 3;
  const periods = forecastPeriods(from, kind, count, yearEndMonth);
  const start = periods[0].start;
  const end = periods.at(-1)!.end;
  const periodOf = (date: string) => periods.find((period) => date >= period.start && date <= period.end)!.start;

  const result = await tx.query<{
    id: string;
    name: string;
    contact_name: string;
    owner_user_id: string | null;
    close_date: string;
    currency_code: string;
    amount: string;
    stage: string;
    stage_name: string;
    stage_type: StageType;
    probability: number;
    forecast_category: ForecastCategory;
  }>(
    `select o.id::text, o.name, c.name as contact_name, o.owner_user_id, o.close_date::text, o.currency_code, o.amount::text, o.stage,
            s.name as stage_name, s.stage_type, o.probability, o.forecast_category
       from crm_opportunities o
       join crm_opportunity_stages s on s.key = o.stage
       join contacts c on c.id = o.contact_id
      where o.close_date between $1::date and $2::date
        and ($3::text is null or ($3 = 'none' and o.owner_user_id is null) or o.owner_user_id = $3)
        and ($4::text[] is null or o.owner_user_id = any($4::text[]))
      order by o.close_date, s.sort_order, o.id`,
    [start, end, owner, owners],
  );
  const opportunities: ForecastOpportunity[] = result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    contactName: row.contact_name,
    ownerUserId: row.owner_user_id,
    periodStart: periodOf(row.close_date),
    closeDate: row.close_date,
    currencyCode: row.currency_code,
    amount: toFixedString(dec(row.amount), currencyMinorUnits(row.currency_code)),
    stage: row.stage,
    stageName: row.stage_name,
    stageType: row.stage_type,
    probability: row.probability,
    forecastCategory: row.forecast_category,
    weightedAmount: weightedAmount(row.amount, row.probability, currencyMinorUnits(row.currency_code)),
  }));
  const noCloseDate = await tx.query<{ count: number }>(
    `select count(*)::int as count from crm_opportunities o join crm_opportunity_stages s on s.key = o.stage
      where o.close_date is null and s.stage_type = 'open'
        and ($1::text is null or ($1 = 'none' and o.owner_user_id is null) or o.owner_user_id = $1)
        and ($2::text[] is null or o.owner_user_id = any($2::text[]))`,
    [owner, owners],
  );

  // Quotas per owner per period: a quarter's are its months' added (decision 89).
  const quotaRows = await tx.query<{ owner_user_id: string; month: string; amount: string }>(
    `select owner_user_id, month::text, amount::text from crm_forecast_quotas
      where month between $1::date and $2::date and ($3::text is null or owner_user_id = $3)
        and ($4::text[] is null or owner_user_id = any($4::text[]))`,
    [start, end, owner, owners],
  );
  const quotaSums = new Map<string, ReturnType<typeof dec>>();
  for (const row of quotaRows.rows) {
    const k = `${periodOf(row.month)}|${row.owner_user_id}`;
    quotaSums.set(k, add(quotaSums.get(k) ?? ZERO_DECIMAL, dec(row.amount)));
  }
  const baseMinor = currencyMinorUnits(tx.baseCurrency);
  const quotas = [...quotaSums.entries()]
    .map(([k, amount]) => {
      const [periodStart, ownerUserId] = k.split("|");
      return { periodStart, ownerUserId, amount: toFixedString(amount, baseMinor) };
    })
    .sort((a, b) => (a.periodStart === b.periodStart ? a.ownerUserId.localeCompare(b.ownerUserId) : a.periodStart < b.periodStart ? -1 : 1));

  const names = new Map((await listMembers(tx.organisationId)).map((member) => [member.userId, member.displayName]));
  const ownerName = (id: string | null) => (id === null ? "No owner" : (names.get(id) ?? "Former member"));
  const currencyOrder = (a: string, b: string) => (a === b ? 0 : a === tx.baseCurrency ? -1 : b === tx.baseCurrency ? 1 : a.localeCompare(b));

  const groups = new Map<string, ForecastOpportunity[]>();
  for (const opportunity of opportunities) {
    const k = `${opportunity.periodStart}|${opportunity.ownerUserId ?? ""}|${opportunity.currencyCode}`;
    groups.set(k, [...(groups.get(k) ?? []), opportunity]);
  }
  // Owners with a quota but nothing closing still get a base-currency row.
  for (const quota of quotas) {
    const k = `${quota.periodStart}|${quota.ownerUserId}|${tx.baseCurrency}`;
    if (!groups.has(k)) groups.set(k, []);
  }
  const rows: ForecastRow[] = [...groups.entries()].map(([k, items]) => {
    const [periodStart, ownerId, currencyCode] = k.split("|");
    const ownerUserId = ownerId === "" ? null : ownerId;
    const figures = forecastFigures(items, currencyMinorUnits(currencyCode));
    const quota = currencyCode === tx.baseCurrency && ownerUserId !== null ? (quotaSums.has(`${periodStart}|${ownerUserId}`) ? toFixedString(quotaSums.get(`${periodStart}|${ownerUserId}`)!, baseMinor) : null) : null;
    return { periodStart, ownerUserId, ownerName: ownerName(ownerUserId), currencyCode, ...figures, quota, attainment: attainment(figures.closed, quota) };
  });
  rows.sort(
    (a, b) =>
      (a.periodStart < b.periodStart ? -1 : a.periodStart > b.periodStart ? 1 : 0) ||
      (a.ownerUserId === null ? 1 : 0) - (b.ownerUserId === null ? 1 : 0) ||
      a.ownerName.localeCompare(b.ownerName) ||
      currencyOrder(a.currencyCode, b.currencyCode),
  );

  const totalGroups = new Map<string, ForecastOpportunity[]>();
  for (const opportunity of opportunities) {
    const k = `${opportunity.periodStart}|${opportunity.currencyCode}`;
    totalGroups.set(k, [...(totalGroups.get(k) ?? []), opportunity]);
  }
  const totals = [...totalGroups.entries()]
    .map(([k, items]) => {
      const [periodStart, currencyCode] = k.split("|");
      return { periodStart, currencyCode, ...forecastFigures(items, currencyMinorUnits(currencyCode)) };
    })
    .sort((a, b) => (a.periodStart < b.periodStart ? -1 : a.periodStart > b.periodStart ? 1 : currencyOrder(a.currencyCode, b.currencyCode)));

  return {
    period: kind,
    baseCurrency: tx.baseCurrency,
    financialYearEndMonth: yearEndMonth,
    periods,
    rows,
    totals,
    quotas,
    opportunities,
    noCloseDate: noCloseDate.rows[0].count,
  };
}

/**
 * Sets, changes or (with no amount) clears an owner's quota for a month
 * (CRMS10), in the base currency. Admins only (the route checks).
 */
export async function setQuota(tx: OrgTx, input: { ownerUserId?: unknown; month?: unknown; amount?: unknown }): Promise<{ ownerUserId: string; month: string; amount: string | null }> {
  await requireCrm(tx);
  if (typeof input.ownerUserId !== "string" || input.ownerUserId === "") throw new ValidationError("Choose whose quota this is.");
  const members = await listMembers(tx.organisationId);
  if (!members.some((member) => member.userId === input.ownerUserId && member.isActive)) throw new ValidationError("A quota's owner must be a member of the organisation.");
  const ownerUserId = input.ownerUserId;
  const month = parseIsoDate(input.month, "month");
  if (!month.endsWith("-01")) throw new ValidationError("A quota is for a month: give its first day, like 2026-10-01.");
  const minor = currencyMinorUnits(tx.baseCurrency);
  let amount: string | null = null;
  if (input.amount !== undefined && input.amount !== null && input.amount !== "") {
    const text = typeof input.amount === "number" ? String(input.amount) : typeof input.amount === "string" ? input.amount.trim().replace(/^\$/, "").replace(/,/g, "") : "";
    if (!/^-?\d{1,15}(\.\d{1,2})?$/.test(text)) throw new ValidationError("The quota must be an amount with at most 2 decimal places, like 5000.00.");
    if (cmp(dec(text), ZERO_DECIMAL) < 0) throw new ValidationError("A quota can't be negative.");
    if (cmp(dec(text), dec(toFixedString(dec(text), minor))) !== 0) throw new ValidationError(`Quotas are in ${tx.baseCurrency}, which has no cents, so it must be a whole number.`);
    amount = toFixedString(dec(text), minor);
  }
  const before = await tx.query<{ amount: string }>("select amount::text from crm_forecast_quotas where owner_user_id = $1 and month = $2::date", [ownerUserId, month]);
  const from = before.rows[0] ? toFixedString(dec(before.rows[0].amount), minor) : null;
  if (amount === null) {
    await tx.query("delete from crm_forecast_quotas where owner_user_id = $1 and month = $2::date", [ownerUserId, month]);
  } else {
    await tx.query(
      `insert into crm_forecast_quotas (owner_user_id, month, amount) values ($1, $2::date, $3::numeric)
       on conflict (owner_user_id, month) do update set amount = excluded.amount, updated_at = now()`,
      [ownerUserId, month, amount],
    );
  }
  if (from !== amount) {
    await writeAuditEvent(tx, {
      eventType: "crm.quota_set",
      entityType: "crm_forecast_quota",
      entityId: `${ownerUserId}:${month}`,
      details: { ownerUserId, month, amount, amountFrom: from, currencyCode: tx.baseCurrency },
    });
  }
  return { ownerUserId, month, amount };
}
