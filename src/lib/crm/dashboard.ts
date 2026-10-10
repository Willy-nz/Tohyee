import type { CrmScope } from "@/lib/crm/access";
import { forecast } from "@/lib/crm/forecast";
import { FORECAST_PERIODS, type ForecastPeriod, type ForecastPeriodKind, forecastPeriods, type StageType } from "@/lib/crm/forecast-figures";
import { LEAD_SOURCES, type LeadSource } from "@/lib/crm/lead-types";
import { businessTimeZone, isoDateAt, parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, dec, divide, mul, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { listMembers } from "@/lib/organisations/members";
import { requireOneOf } from "@/lib/validation";

/**
 * The CRM's standard sales dashboard (decision 500, #216 stage 3; Jess
 * 10 Oct 2026). Every figure is worked out from the records each time, for
 * months or quarters of the financial year, and for a sales rep or manager
 * only from their own (or their teams') leads and deals (decision 491).
 * Amounts are never added across currencies (decision 324).
 *
 * Definitions:
 * - **Lead conversion:** of the leads added in a period, how many have been
 *   converted so far.
 * - **Closed on:** the day a deal moved into the Closed won or Closed lost
 *   stage it's in now (from its stage history), not its expected close date.
 * - **Win rate:** won ÷ (won + lost), for deals closed in the period.
 * - **Sales cycle:** days from a deal being added to its closed-on day, for
 *   deals won in the period: the average and the median.
 * - **Stage ageing:** open deals now, by stage, with days since they got to
 *   the stage they're in.
 * - **Activity:** calls, meetings and notes logged, tasks done and sales
 *   emails sent, per person, per period.
 * - **Quota attainment:** the forecast's (CRMS10): Closed in the base
 *   currency by expected close date ÷ quota.
 * - **Campaigns:** leads added in the range with each campaign as their
 *   source, and deals won in the range with it as theirs (decision 498).
 */

export const MAX_DASHBOARD_PERIODS = 12;

export type CurrencyAmount = { currencyCode: string; amount: string };

export type DashboardDeal = {
  id: string;
  name: string;
  ownerUserId: string | null;
  stageName: string;
  stageType: StageType;
  currencyCode: string;
  amount: string;
  addedOn: string;
  closedOn: string | null;
  /** For a won or lost deal: closed on − added. */
  days: number | null;
  /** For an open deal: days in its stage. */
  daysInStage: number | null;
};

export type Dashboard = {
  period: ForecastPeriodKind;
  periods: ForecastPeriod[];
  baseCurrency: string;
  scoped: boolean;
  leads: Array<{ periodStart: string; added: number; converted: number; rate: string | null }>;
  leadSources: Array<{ source: LeadSource; added: number; converted: number; rate: string | null }>;
  winLoss: Array<{ periodStart: string; won: number; lost: number; winRate: string | null; wonAmounts: CurrencyAmount[] }>;
  cycle: Array<{ periodStart: string; won: number; averageDays: string | null; medianDays: string | null }>;
  ageing: Array<{ stage: string; stageName: string; count: number; amounts: CurrencyAmount[]; averageDays: string | null; oldestDays: number | null }>;
  activity: Array<{ periodStart: string; userId: string | null; name: string; calls: number; meetings: number; notes: number; tasksDone: number; emailsSent: number }>;
  quotas: Array<{ periodStart: string; ownerUserId: string; name: string; closed: string; quota: string; attainment: string | null }>;
  campaigns: Array<{ campaignId: string; name: string; leads: number; won: number; wonAmounts: CurrencyAmount[]; actualCost: string | null }>;
  /** The deals behind the win rate, sales cycle and ageing figures, to drill into. */
  deals: DashboardDeal[];
};

function percent(part: number, whole: number): string | null {
  if (whole === 0) return null;
  return toFixedString(divide(mul(dec(String(part)), dec("100")), dec(String(whole)), 1), 1);
}

function days(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function average(values: number[]): string | null {
  if (values.length === 0) return null;
  return toFixedString(divide(dec(String(values.reduce((sum, value) => sum + value, 0))), dec(String(values.length)), 1), 1);
}

function median(values: number[]): string | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? toFixedString(dec(String(sorted[middle])), 1) : average([sorted[middle - 1], sorted[middle]]);
}

function sumByCurrency(items: Array<{ currencyCode: string; amount: string }>): CurrencyAmount[] {
  const totals = new Map<string, ReturnType<typeof dec>>();
  for (const item of items) totals.set(item.currencyCode, add(totals.get(item.currencyCode) ?? ZERO_DECIMAL, dec(item.amount)));
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currencyCode, amount]) => ({ currencyCode, amount: toFixedString(amount, currencyMinorUnits(currencyCode)) }));
}

/** When each deal got to the stage it's in now: the stage history's last change into it (or when it was added). */
async function stageSince(tx: OrgTx, ids: string[]): Promise<Map<string, string>> {
  const since = new Map<string, string>();
  if (ids.length === 0) return since;
  const events = await tx.query<{ entity_id: string; stage: string | null; created_at: string }>(
    `select a.entity_id, a.details->>'stage' as stage, a.created_at::text from audit_events a
      where a.entity_type = 'crm_opportunity' and a.event_type in ('crm.opportunity_created', 'crm.opportunity_updated') and a.entity_id = any($1::text[])
      order by a.entity_id, a.id`,
    [ids],
  );
  const last = new Map<string, string>();
  for (const event of events.rows) {
    const previous = last.get(event.entity_id);
    const stage = event.stage ?? previous;
    if (!stage) continue;
    if (stage !== previous) since.set(`${event.entity_id}|${stage}`, isoDateAt(new Date(event.created_at)));
    last.set(event.entity_id, stage);
  }
  return since;
}

export async function salesDashboard(tx: OrgTx, input: { period?: unknown; from?: unknown; periods?: unknown } = {}, scope?: CrmScope): Promise<Dashboard> {
  const kind: ForecastPeriodKind = input.period === undefined || input.period === null || input.period === "" ? "month" : requireOneOf(input.period, "period", FORECAST_PERIODS);
  const count = input.periods === undefined || input.periods === null || input.periods === "" ? (kind === "month" ? 6 : 4) : Number(input.periods);
  if (!Number.isInteger(count) || count < 1 || count > MAX_DASHBOARD_PERIODS) throw new ValidationError(`Show from 1 to ${MAX_DASHBOARD_PERIODS} periods.`);
  const today = todayIsoDate();
  const settings = await tx.query<{ financial_year_end_month: number }>("select financial_year_end_month from organisation_settings where id = true");
  const yearEnd = settings.rows[0]?.financial_year_end_month ?? 3;
  // By default the periods end with the one today is in.
  let from: string;
  if (input.from === undefined || input.from === null || input.from === "") {
    const back = new Date(`${today}T00:00:00Z`);
    back.setUTCMonth(back.getUTCMonth() - (kind === "month" ? count - 1 : 3 * (count - 1)));
    from = back.toISOString().slice(0, 10);
  } else {
    from = parseIsoDate(input.from, "from");
  }
  const periods = forecastPeriods(from, kind, count, yearEnd);
  const start = periods[0].start;
  const end = periods.at(-1)!.end;
  const periodOf = (date: string) => periods.find((period) => date >= period.start && date <= period.end)?.start ?? null;
  const owners = scope?.owners ?? null;
  const members = await listMembers(tx.organisationId);
  const nameOf = (id: string | null) => (id === null ? "No one" : (members.find((member) => member.userId === id)?.displayName ?? "Former member"));

  // Leads added in the range, and whether they've been converted since.
  const leadRows = await tx.query<{ day: string; source: LeadSource; status: string }>(
    `select (l.created_at at time zone $3)::date::text as day, l.source, l.status from crm_leads l
      where (l.created_at at time zone $3)::date between $1::date and $2::date
        and ($4::text[] is null or l.owner_user_id = any($4::text[]))`,
    [start, end, businessTimeZone(), owners],
  );
  const leads = periods.map((period) => {
    const inPeriod = leadRows.rows.filter((row) => periodOf(row.day) === period.start);
    const converted = inPeriod.filter((row) => row.status === "converted").length;
    return { periodStart: period.start, added: inPeriod.length, converted, rate: percent(converted, inPeriod.length) };
  });
  const leadSources = LEAD_SOURCES.map((source) => {
    const rows = leadRows.rows.filter((row) => row.source === source);
    const converted = rows.filter((row) => row.status === "converted").length;
    return { source, added: rows.length, converted, rate: percent(converted, rows.length) };
  }).filter((entry) => entry.added > 0);

  // Every deal in scope: closed ones get their closed-on day, open ones their days in stage.
  const dealRows = await tx.query<{
    id: string;
    name: string;
    owner_user_id: string | null;
    stage: string;
    stage_name: string;
    stage_type: StageType;
    sort_order: number;
    currency_code: string;
    amount: string;
    added_on: string;
    source_campaign_id: string | null;
  }>(
    `select o.id::text, o.name, o.owner_user_id, o.stage, s.name as stage_name, s.stage_type, s.sort_order, o.currency_code, o.amount::text,
            (o.created_at at time zone $1)::date::text as added_on, o.source_campaign_id::text
       from crm_opportunities o join crm_opportunity_stages s on s.key = o.stage
      where ($2::text[] is null or o.owner_user_id = any($2::text[]))
      order by o.id`,
    [businessTimeZone(), owners],
  );
  const since = await stageSince(tx, dealRows.rows.map((row) => row.id));
  const allDeals: Array<DashboardDeal & { sortOrder: number; stage: string; sourceCampaignId: string | null }> = dealRows.rows.map((row) => {
    const reached = since.get(`${row.id}|${row.stage}`) ?? row.added_on;
    const closed = row.stage_type !== "open";
    return {
      id: row.id,
      name: row.name,
      ownerUserId: row.owner_user_id,
      stage: row.stage,
      stageName: row.stage_name,
      stageType: row.stage_type,
      sortOrder: row.sort_order,
      currencyCode: row.currency_code,
      amount: toFixedString(dec(row.amount), currencyMinorUnits(row.currency_code)),
      addedOn: row.added_on,
      closedOn: closed ? reached : null,
      days: closed ? Math.max(0, days(row.added_on, reached)) : null,
      daysInStage: closed ? null : Math.max(0, days(reached, today)),
      sourceCampaignId: row.source_campaign_id,
    };
  });
  const closedInRange = allDeals.filter((deal) => deal.closedOn !== null && deal.closedOn >= start && deal.closedOn <= end);
  const winLoss = periods.map((period) => {
    const inPeriod = closedInRange.filter((deal) => periodOf(deal.closedOn!) === period.start);
    const won = inPeriod.filter((deal) => deal.stageType === "won");
    const lost = inPeriod.filter((deal) => deal.stageType === "lost").length;
    return { periodStart: period.start, won: won.length, lost, winRate: percent(won.length, won.length + lost), wonAmounts: sumByCurrency(won) };
  });
  const cycle = periods.map((period) => {
    const won = closedInRange.filter((deal) => deal.stageType === "won" && periodOf(deal.closedOn!) === period.start).map((deal) => deal.days!);
    return { periodStart: period.start, won: won.length, averageDays: average(won), medianDays: median(won) };
  });
  const open = allDeals.filter((deal) => deal.stageType === "open");
  const stages = [...new Map(open.sort((a, b) => a.sortOrder - b.sortOrder).map((deal) => [deal.stage, deal.stageName])).entries()];
  const ageing = stages.map(([stage, stageName]) => {
    const inStage = open.filter((deal) => deal.stage === stage);
    const ages = inStage.map((deal) => deal.daysInStage!);
    return { stage, stageName, count: inStage.length, amounts: sumByCurrency(inStage), averageDays: average(ages), oldestDays: ages.length ? Math.max(...ages) : null };
  });

  // Activity per person: who logged it (by their email), who finished the task, who sent the email.
  const zone = businessTimeZone();
  const byEmail = new Map(members.map((member) => [member.email.toLowerCase(), member.userId]));
  const activityRows = await tx.query<{ day: string; kind: string; created_by_email: string | null }>(
    `select (a.created_at at time zone $3)::date::text as day, a.kind, a.created_by_email from crm_activities a
      where (a.created_at at time zone $3)::date between $1::date and $2::date and a.created_by_email not like '%@tohyee'`,
    [start, end, zone],
  );
  const taskRows = await tx.query<{ day: string; assignee_user_id: string | null }>(
    `select (t.completed_at at time zone $3)::date::text as day, t.assignee_user_id from crm_tasks t
      where t.status = 'done' and t.completed_at is not null and (t.completed_at at time zone $3)::date between $1::date and $2::date`,
    [start, end, zone],
  );
  const emailRows = await tx.query<{ day: string; sent_by_user_id: string }>(
    `select (e.sent_at at time zone $3)::date::text as day, e.sent_by_user_id from crm_sent_emails e
      where e.status = 'sent' and (e.sent_at at time zone $3)::date between $1::date and $2::date`,
    [start, end, zone],
  );
  const activityMap = new Map<string, { calls: number; meetings: number; notes: number; tasksDone: number; emailsSent: number }>();
  const bump = (periodStart: string | null, userId: string | null, field: "calls" | "meetings" | "notes" | "tasksDone" | "emailsSent") => {
    if (!periodStart) return;
    if (owners && (userId === null || !owners.includes(userId))) return;
    const key = `${periodStart}|${userId ?? ""}`;
    const entry = activityMap.get(key) ?? { calls: 0, meetings: 0, notes: 0, tasksDone: 0, emailsSent: 0 };
    entry[field] += 1;
    activityMap.set(key, entry);
  };
  for (const row of activityRows.rows) {
    bump(periodOf(row.day), row.created_by_email ? (byEmail.get(row.created_by_email.toLowerCase()) ?? null) : null, row.kind === "call" ? "calls" : row.kind === "meeting" ? "meetings" : "notes");
  }
  for (const row of taskRows.rows) bump(periodOf(row.day), row.assignee_user_id, "tasksDone");
  for (const row of emailRows.rows) bump(periodOf(row.day), row.sent_by_user_id, "emailsSent");
  const activity = [...activityMap.entries()]
    .map(([key, figures]) => {
      const [periodStart, userId] = key.split("|");
      return { periodStart, userId: userId || null, name: nameOf(userId || null), ...figures };
    })
    .sort((a, b) => (a.periodStart === b.periodStart ? a.name.localeCompare(b.name) : a.periodStart < b.periodStart ? -1 : 1));

  // Quota attainment, as the forecast works it out.
  const forecastResult = await forecast(tx, { period: kind, from: start, periods: count }, scope);
  const quotas = forecastResult.rows
    .filter((row) => row.quota !== null && row.ownerUserId !== null)
    .map((row) => ({ periodStart: row.periodStart, ownerUserId: row.ownerUserId!, name: row.ownerName, closed: row.closed, quota: row.quota!, attainment: row.attainment }));

  // Campaigns: leads added in the range and deals won in it, by source campaign.
  const campaignRows = await tx.query<{ id: string; name: string; actual_cost: string | null; leads: number }>(
    `select c.id::text, c.name, c.actual_cost::text,
            (select count(*)::int from crm_leads l where l.source_campaign_id = c.id
               and (l.created_at at time zone $3)::date between $1::date and $2::date
               and ($4::text[] is null or l.owner_user_id = any($4::text[]))) as leads
       from crm_campaigns c order by lower(c.name), c.id`,
    [start, end, zone, owners],
  );
  const campaigns = campaignRows.rows
    .map((row) => {
      const won = closedInRange.filter((deal) => deal.stageType === "won" && deal.sourceCampaignId === row.id);
      return {
        campaignId: row.id,
        name: row.name,
        leads: row.leads,
        won: won.length,
        wonAmounts: sumByCurrency(won),
        actualCost: row.actual_cost === null ? null : toFixedString(dec(row.actual_cost), 2),
      };
    })
    .filter((entry) => entry.leads > 0 || entry.won > 0);

  const strip = (deal: (typeof allDeals)[number]): DashboardDeal => ({
    id: deal.id,
    name: deal.name,
    ownerUserId: deal.ownerUserId,
    stageName: deal.stageName,
    stageType: deal.stageType,
    currencyCode: deal.currencyCode,
    amount: deal.amount,
    addedOn: deal.addedOn,
    closedOn: deal.closedOn,
    days: deal.days,
    daysInStage: deal.daysInStage,
  });
  return {
    period: kind,
    periods,
    baseCurrency: tx.baseCurrency,
    scoped: owners !== null,
    leads,
    leadSources,
    winLoss,
    cycle,
    ageing,
    activity,
    quotas,
    campaigns,
    deals: [...closedInRange, ...open].slice(0, 1000).map(strip),
  };
}
