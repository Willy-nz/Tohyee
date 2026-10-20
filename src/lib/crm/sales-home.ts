import type { CrmScope } from "@/lib/crm/access";
import { type CurrencyAmount, salesDashboard } from "@/lib/crm/dashboard";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, dec, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/*
 * The CRM Home's sales cards (decision 662, SD1-SD6; #360 item 20, Codex,
 * delegated by owner, 20 October 2026): the pipeline, conversion and the
 * person's next actions, each a way into the records behind it. Worked out
 * from the records when it's opened, as the sales dashboard is (decision
 * 500), and only from what the person may see (decision 491): a rep's own
 * deals, a manager's teams'. Next actions are always the person's own.
 * Nothing is stored and nothing posts.
 */

/** How many of each next action are listed; the counts are of all of them. */
export const NEXT_ACTION_LIMIT = 5;

export type SalesHomeStage = { stage: string; stageName: string; count: number; amounts: CurrencyAmount[]; oldestDays: number | null };

export type SalesHomeQuarter = {
  periodStart: string;
  periodEnd: string;
  leadsAdded: number;
  leadsConverted: number;
  /** Percent, one decimal place; null with no leads. */
  leadRate: string | null;
  won: number;
  lost: number;
  winRate: string | null;
  wonAmounts: CurrencyAmount[];
};

export type SalesHomeTask = { id: string; title: string; dueDate: string; overdue: boolean; href: string | null; about: string | null };
export type SalesHomeDeal = { id: string; name: string; stageName: string; closeDate: string | null; contactName: string };

export type SalesHome = {
  today: string;
  baseCurrency: string;
  /** Figures are only the person's own (or their teams'). */
  scoped: boolean;
  pipeline: { count: number; totals: CurrencyAmount[]; stages: SalesHomeStage[] };
  /** Last quarter and this one, of the financial year. */
  conversion: SalesHomeQuarter[];
  nextActions: {
    /** The person's tasks not done and due today or before, oldest first. */
    tasks: { count: number; items: SalesHomeTask[] };
    /** The person's open deals whose expected close date has passed. */
    pastClose: { count: number; items: SalesHomeDeal[] };
    /** The person's open deals with no task still to do on them. */
    noNextStep: { count: number; items: SalesHomeDeal[] };
  };
};

function totalsOf(amounts: CurrencyAmount[]): CurrencyAmount[] {
  const totals = new Map<string, ReturnType<typeof dec>>();
  for (const item of amounts) totals.set(item.currencyCode, add(totals.get(item.currencyCode) ?? ZERO_DECIMAL, dec(item.amount)));
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currencyCode, amount]) => ({ currencyCode, amount: toFixedString(amount, currencyMinorUnits(currencyCode)) }));
}

export async function salesHome(tx: OrgTx, scope: CrmScope, input: { today?: string } = {}): Promise<SalesHome> {
  const today = input.today ?? todayIsoDate();
  const me = tx.actor.userId;
  const dashboard = await salesDashboard(tx, { period: "quarter", periods: 2 }, scope);
  const stages = dashboard.ageing.map((row) => ({ stage: row.stage, stageName: row.stageName, count: row.count, amounts: row.amounts, oldestDays: row.oldestDays }));
  const conversion = dashboard.periods.map((period) => {
    const leads = dashboard.leads.find((row) => row.periodStart === period.start);
    const closed = dashboard.winLoss.find((row) => row.periodStart === period.start);
    return {
      periodStart: period.start,
      periodEnd: period.end,
      leadsAdded: leads?.added ?? 0,
      leadsConverted: leads?.converted ?? 0,
      leadRate: leads?.rate ?? null,
      won: closed?.won ?? 0,
      lost: closed?.lost ?? 0,
      winRate: closed?.winRate ?? null,
      wonAmounts: closed?.wonAmounts ?? [],
    };
  });

  const tasks = me
    ? await tx.query<{ id: string; title: string; due_date: string; opportunity_id: string | null; opportunity_name: string | null; contact_id: string | null; contact_name: string | null; lead_id: string | null; total: number }>(
        `select x.id::text, x.title, x.due_date::text, x.opportunity_id::text, o.name as opportunity_name, x.contact_id::text, c.name as contact_name, x.lead_id::text,
                count(*) over ()::int as total
           from crm_tasks x
           left join crm_opportunities o on o.id = x.opportunity_id
           left join contacts c on c.id = x.contact_id
          where x.assignee_user_id = $1 and x.status <> 'done' and x.due_date <= $2::date
          order by x.due_date, x.id limit $3`,
        [me, today, NEXT_ACTION_LIMIT],
      )
    : { rows: [] };
  const deals = (where: string) =>
    me
      ? tx.query<{ id: string; name: string; stage_name: string; close_date: string | null; contact_name: string; total: number }>(
          `select o.id::text, o.name, s.name as stage_name, o.close_date::text, c.name as contact_name, count(*) over ()::int as total
             from crm_opportunities o join crm_opportunity_stages s on s.key = o.stage join contacts c on c.id = o.contact_id
            where o.owner_user_id = $1 and s.stage_type = 'open' and ${where}
            order by o.close_date nulls last, o.id limit $3`,
          [me, today, NEXT_ACTION_LIMIT],
        )
      : Promise.resolve({ rows: [] as Array<{ id: string; name: string; stage_name: string; close_date: string | null; contact_name: string; total: number }> });
  const pastClose = await deals("o.close_date < $2::date");
  const noNextStep = await deals("($2::date is not null) and not exists (select 1 from crm_tasks t where t.opportunity_id = o.id and t.status <> 'done')");
  const toDeal = (row: { id: string; name: string; stage_name: string; close_date: string | null; contact_name: string }): SalesHomeDeal => ({
    id: row.id,
    name: row.name,
    stageName: row.stage_name,
    closeDate: row.close_date,
    contactName: row.contact_name,
  });

  return {
    today,
    baseCurrency: tx.baseCurrency,
    scoped: dashboard.scoped,
    pipeline: { count: stages.reduce((total, stage) => total + stage.count, 0), totals: totalsOf(stages.flatMap((stage) => stage.amounts)), stages },
    conversion,
    nextActions: {
      tasks: {
        count: tasks.rows[0]?.total ?? 0,
        items: tasks.rows.map((row) => ({
          id: row.id,
          title: row.title,
          dueDate: row.due_date,
          overdue: row.due_date < today,
          href: row.opportunity_id ? `/crm/opportunities/${row.opportunity_id}` : row.lead_id ? `/crm/leads/${row.lead_id}` : row.contact_id ? `/crm/companies/${row.contact_id}` : null,
          about: row.opportunity_name ?? row.contact_name,
        })),
      },
      pastClose: { count: pastClose.rows[0]?.total ?? 0, items: pastClose.rows.map(toDeal) },
      noNextStep: { count: noNextStep.rows[0]?.total ?? 0, items: noNextStep.rows.map(toDeal) },
    },
  };
}
