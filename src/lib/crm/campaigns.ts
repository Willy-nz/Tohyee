import { writeAuditEvent } from "@/lib/audit";
import { type CrmScope, seesLead } from "@/lib/crm/access";
import { getLead, optionalCampaign } from "@/lib/crm/leads";
import { getOpportunity, getPerson } from "@/lib/crm/service";
import { requireCrm } from "@/lib/crm/switch";
import { parseOptionalIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { cmp, dec, divide, toFixedString } from "@/lib/money/decimal";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { optionalId, optionalString, requireId, requireOneOf, requireString } from "@/lib/validation";

/**
 * Campaigns (decision 498, #216 stage 2; Jess 10 Oct 2026).
 *
 * - **Source:** each lead and deal has at most one source campaign, so a won
 *   deal's amount is credited to one campaign only. A deal made from a lead
 *   keeps the lead's. Set by hand, by the web form or lead mailbox it came
 *   in through, or by a spreadsheet import.
 * - **Members:** leads and people in a campaign, each "added", "sent" or
 *   "responded". Sent when a sales email (decision 496) goes to them after
 *   they were added; responded when they reply (a synced email from them, or
 *   for a lead, one into a lead mailbox), when they came in through the
 *   campaign's form or mailbox, or by hand.
 * - **Costs:** a budget and an actual cost in the base currency, typed in,
 *   for cost per lead and per won deal. Report figures only: nothing is
 *   posted to the books.
 * - **Report:** won and open deal amounts are shown per currency, never
 *   added across currencies (as forecasts, CRMS11).
 */

export const CAMPAIGN_KINDS = ["email", "event", "advert", "social", "referral", "other"] as const;
export type CampaignKind = (typeof CAMPAIGN_KINDS)[number];
export const CAMPAIGN_STATUSES = ["planned", "active", "finished"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export const MEMBER_STATUSES = ["added", "sent", "responded"] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export type Campaign = {
  id: string;
  name: string;
  kind: CampaignKind;
  status: CampaignStatus;
  startDate: string | null;
  endDate: string | null;
  /** In the base currency, typed in; not in the books. */
  budget: string | null;
  actualCost: string | null;
  /** The actual cost is more than the budget. */
  overBudget: boolean;
  description: string | null;
  members: number;
  responded: number;
  updatedAt: string;
};

type CampaignRow = {
  id: string;
  name: string;
  kind: CampaignKind;
  status: CampaignStatus;
  start_date: string | null;
  end_date: string | null;
  budget: string | null;
  actual_cost: string | null;
  description: string | null;
  members: number;
  responded: number;
  updated_at: string;
};

const CAMPAIGN_SELECT = `select c.id::text, c.name, c.kind, c.status, c.start_date::text, c.end_date::text, c.budget::text, c.actual_cost::text, c.description,
    (select count(*)::int from crm_campaign_members m where m.campaign_id = c.id) as members,
    (select count(*)::int from crm_campaign_members m where m.campaign_id = c.id and m.status = 'responded') as responded,
    c.updated_at::text
  from crm_campaigns c`;

function toCampaign(row: CampaignRow): Campaign {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    startDate: row.start_date,
    endDate: row.end_date,
    budget: row.budget === null ? null : toFixedString(dec(row.budget), 2),
    actualCost: row.actual_cost === null ? null : toFixedString(dec(row.actual_cost), 2),
    overBudget: row.budget !== null && row.actual_cost !== null && cmp(dec(row.actual_cost), dec(row.budget)) > 0,
    description: row.description,
    members: row.members,
    responded: row.responded,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function listCampaigns(tx: OrgTx): Promise<Campaign[]> {
  const result = await tx.query<CampaignRow>(`${CAMPAIGN_SELECT} order by c.status = 'finished', c.start_date desc nulls last, lower(c.name), c.id`);
  return result.rows.map(toCampaign);
}

export async function getCampaign(tx: OrgTx, idInput: unknown): Promise<Campaign> {
  const result = await tx.query<CampaignRow>(`${CAMPAIGN_SELECT} where c.id = $1`, [requireId(idInput, "campaignId")]);
  if (!result.rows[0]) throw new NotFoundError("Campaign not found.");
  return toCampaign(result.rows[0]);
}

function money(input: unknown, what: string): string | null {
  if (input === null || input === undefined || input === "") return null;
  const text = typeof input === "number" ? String(input) : typeof input === "string" ? input.trim().replace(/^\$/, "").replace(/,/g, "") : "";
  if (!/^\d{1,15}(\.\d{1,2})?$/.test(text)) throw new ValidationError(`The ${what} must be an amount with at most 2 decimal places, like 1500.00.`);
  return toFixedString(dec(text), 2);
}

type CampaignInput = {
  name?: unknown;
  kind?: unknown;
  status?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  budget?: unknown;
  actualCost?: unknown;
  description?: unknown;
};

function campaignValues(input: CampaignInput, current: Campaign | null) {
  const pick = <T>(value: unknown, now: T | undefined, parse: (raw: unknown) => T): T => (value === undefined && current ? (now as T) : parse(value));
  const values = {
    name: pick(input.name, current?.name, (raw) => requireString(raw, "name", { maxLength: 100 })),
    kind: pick(input.kind, current?.kind, (raw) => (raw === undefined || raw === null || raw === "" ? "other" : requireOneOf(raw, "kind", CAMPAIGN_KINDS))),
    status: pick(input.status, current?.status, (raw) => (raw === undefined || raw === null || raw === "" ? "planned" : requireOneOf(raw, "status", CAMPAIGN_STATUSES))),
    startDate: pick(input.startDate, current?.startDate, (raw) => parseOptionalIsoDate(raw, "start date")),
    endDate: pick(input.endDate, current?.endDate, (raw) => parseOptionalIsoDate(raw, "end date")),
    budget: pick(input.budget, current?.budget, (raw) => money(raw, "budget")),
    actualCost: pick(input.actualCost, current?.actualCost, (raw) => money(raw, "actual cost")),
    description: pick(input.description, current?.description, (raw) => optionalString(raw, "description", { maxLength: 1000 })),
  };
  if (values.startDate && values.endDate && values.endDate < values.startDate) throw new ValidationError("The end date can't be before the start date.");
  return values;
}

async function assertNameFree(tx: OrgTx, name: string, id: string | null): Promise<void> {
  const taken = await tx.query("select 1 from crm_campaigns where lower(name) = lower($1) and ($2::bigint is null or id <> $2)", [name, id]);
  if ((taken.rowCount ?? 0) > 0) throw new ConflictError(`There's already a campaign called ${name}.`);
}

export async function createCampaign(tx: OrgTx, input: CampaignInput): Promise<Campaign> {
  await requireCrm(tx);
  const v = campaignValues(input, null);
  await assertNameFree(tx, v.name, null);
  const id = (
    await tx.query<{ id: string }>(
      `insert into crm_campaigns (name, kind, status, start_date, end_date, budget, actual_cost, description, created_by_email)
       values ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8, $9) returning id::text`,
      [v.name, v.kind, v.status, v.startDate, v.endDate, v.budget, v.actualCost, v.description, tx.actor.email],
    )
  ).rows[0].id;
  await writeAuditEvent(tx, { eventType: "crm.campaign_created", entityType: "crm_campaign", entityId: id, details: v });
  return getCampaign(tx, id);
}

export async function updateCampaign(tx: OrgTx, idInput: unknown, input: CampaignInput): Promise<Campaign> {
  await requireCrm(tx);
  const current = await getCampaign(tx, idInput);
  const v = campaignValues(input, current);
  await assertNameFree(tx, v.name, current.id);
  await tx.query(
    `update crm_campaigns set name = $2, kind = $3, status = $4, start_date = $5, end_date = $6, budget = $7::numeric, actual_cost = $8::numeric,
            description = $9, updated_at = now() where id = $1`,
    [current.id, v.name, v.kind, v.status, v.startDate, v.endDate, v.budget, v.actualCost, v.description],
  );
  await writeAuditEvent(tx, { eventType: "crm.campaign_updated", entityType: "crm_campaign", entityId: current.id, details: v });
  return getCampaign(tx, current.id);
}

// ---------------------------------------------------------------------------
// Members

export type CampaignMember = {
  id: string;
  campaignId: string;
  campaignName: string;
  leadId: string | null;
  personId: string | null;
  name: string;
  email: string | null;
  company: string | null;
  status: MemberStatus;
  respondedAt: string | null;
  addedAt: string;
};

type MemberRow = {
  id: string;
  campaign_id: string;
  campaign_name: string;
  lead_id: string | null;
  person_id: string | null;
  name: string;
  email: string | null;
  company: string | null;
  status: MemberStatus;
  responded_at: string | null;
  added_at: string;
  lead_owner: string | null;
};

const MEMBER_SELECT = `select m.id::text, m.campaign_id::text, c.name as campaign_name, m.lead_id::text, m.person_id::text,
    coalesce(nullif(concat_ws(' ', l.first_name, l.last_name), ''), nullif(concat_ws(' ', p.first_name, p.last_name), ''), l.company_name, l.email, 'Member') as name,
    coalesce(l.email, p.email) as email, coalesce(l.company_name, pc.name) as company,
    m.status, m.responded_at::text, m.added_at::text, l.owner_user_id as lead_owner
  from crm_campaign_members m
  join crm_campaigns c on c.id = m.campaign_id
  left join crm_leads l on l.id = m.lead_id
  left join crm_people p on p.id = m.person_id
  left join contacts pc on pc.id = p.contact_id`;

function toMember(row: MemberRow): CampaignMember {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    leadId: row.lead_id,
    personId: row.person_id,
    name: row.name,
    email: row.email,
    company: row.company,
    status: row.status,
    respondedAt: row.responded_at ? new Date(row.responded_at).toISOString() : null,
    addedAt: new Date(row.added_at).toISOString(),
  };
}

/** A campaign's members, or the campaigns a lead or person is in. A sales rep sees only the leads they can (decision 491). */
export async function listMembers(
  tx: OrgTx,
  input: { campaignId?: unknown; leadId?: unknown; personId?: unknown },
  scope?: CrmScope,
): Promise<CampaignMember[]> {
  const campaignId = optionalId(input.campaignId, "campaignId");
  const leadId = optionalId(input.leadId, "leadId");
  const personId = optionalId(input.personId, "personId");
  if (!campaignId && !leadId && !personId) throw new ValidationError("Choose a campaign, a lead or a person.");
  const result = await tx.query<MemberRow>(
    `${MEMBER_SELECT}
      where ($1::bigint is null or m.campaign_id = $1) and ($2::bigint is null or m.lead_id = $2) and ($3::bigint is null or m.person_id = $3)
      order by m.added_at desc, m.id desc
      limit 1000`,
    [campaignId, leadId, personId],
  );
  return result.rows.filter((row) => row.lead_id === null || seesLead(scope, row.lead_owner)).map(toMember);
}

/** Adds leads and people to a campaign (by hand or several at once); ones already in it are left as they are. */
export async function addMembers(
  tx: OrgTx,
  input: { campaignId?: unknown; leadIds?: unknown; personIds?: unknown },
  scope?: CrmScope,
): Promise<{ added: number; alreadyIn: number }> {
  await requireCrm(tx);
  const campaign = await getCampaign(tx, input.campaignId);
  const ids = (value: unknown, what: string): string[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new ValidationError(`${what} must be a list.`);
    return [...new Set(value.map((entry) => requireId(entry, what)))];
  };
  const leadIds = ids(input.leadIds, "leadIds");
  const personIds = ids(input.personIds, "personIds");
  if (leadIds.length + personIds.length === 0) throw new ValidationError("Choose at least one lead or person.");
  if (leadIds.length + personIds.length > 500) throw new ValidationError("Add at most 500 at a time.");
  let added = 0;
  for (const leadId of leadIds) {
    await getLead(tx, leadId, scope);
    const inserted = await tx.query(
      `insert into crm_campaign_members (campaign_id, lead_id, added_by_email) values ($1, $2, $3)
       on conflict (campaign_id, lead_id) where lead_id is not null do nothing`,
      [campaign.id, leadId, tx.actor.email],
    );
    added += inserted.rowCount ?? 0;
  }
  for (const personId of personIds) {
    await getPerson(tx, personId);
    const inserted = await tx.query(
      `insert into crm_campaign_members (campaign_id, person_id, added_by_email) values ($1, $2, $3)
       on conflict (campaign_id, person_id) where person_id is not null do nothing`,
      [campaign.id, personId, tx.actor.email],
    );
    added += inserted.rowCount ?? 0;
  }
  await writeAuditEvent(tx, { eventType: "crm.campaign_members_added", entityType: "crm_campaign", entityId: campaign.id, details: { leadIds, personIds, added } });
  return { added, alreadyIn: leadIds.length + personIds.length - added };
}

/** Sets a member's status by hand: added, sent or responded. */
export async function setMemberStatus(tx: OrgTx, idInput: unknown, statusInput: unknown, scope?: CrmScope): Promise<CampaignMember> {
  await requireCrm(tx);
  const id = requireId(idInput, "memberId");
  const status = requireOneOf(statusInput, "status", MEMBER_STATUSES);
  const row = (await tx.query<MemberRow>(`${MEMBER_SELECT} where m.id = $1`, [id])).rows[0];
  if (!row || (row.lead_id !== null && !seesLead(scope, row.lead_owner))) throw new NotFoundError("Campaign member not found.");
  await tx.query(
    `update crm_campaign_members set status = $2, responded_at = case when $2 = 'responded' then coalesce(responded_at, now()) end, updated_at = now() where id = $1`,
    [id, status],
  );
  await writeAuditEvent(tx, { eventType: "crm.campaign_member_status", entityType: "crm_campaign_member", entityId: id, details: { status, from: row.status } });
  return toMember((await tx.query<MemberRow>(`${MEMBER_SELECT} where m.id = $1`, [id])).rows[0]);
}

/** A lead's or deal's source campaign, set or cleared by hand (one each, decision 498). */
export async function setSourceCampaign(tx: OrgTx, input: { leadId?: unknown; opportunityId?: unknown; campaignId?: unknown }, scope?: CrmScope): Promise<void> {
  await requireCrm(tx);
  const leadId = optionalId(input.leadId, "leadId");
  const opportunityId = optionalId(input.opportunityId, "opportunityId");
  if (Boolean(leadId) === Boolean(opportunityId)) throw new ValidationError("Choose a lead or a deal.");
  const campaignId = await optionalCampaign(tx, input.campaignId);
  if (leadId) {
    const lead = await getLead(tx, leadId, scope);
    if (lead.status === "converted") throw new ConflictError("This lead was converted: set the deal's source campaign instead.");
    await tx.query("update crm_leads set source_campaign_id = $2, updated_at = now() where id = $1", [leadId, campaignId]);
    if (campaignId) {
      await tx.query(
        `insert into crm_campaign_members (campaign_id, lead_id, added_by_email) values ($1, $2, $3)
         on conflict (campaign_id, lead_id) where lead_id is not null do nothing`,
        [campaignId, leadId, tx.actor.email],
      );
    }
  } else {
    await getOpportunity(tx, opportunityId, scope);
    await tx.query("update crm_opportunities set source_campaign_id = $2, updated_at = now() where id = $1", [opportunityId, campaignId]);
  }
  await writeAuditEvent(tx, {
    eventType: "crm.source_campaign_set",
    entityType: leadId ? "crm_lead" : "crm_opportunity",
    entityId: (leadId ?? opportunityId)!,
    details: { campaignId },
  });
}

/**
 * Moves members on by themselves (run with the follow-up rules, every 15
 * minutes): "sent" once a sales email went to them after they were added,
 * "responded" once they replied.
 */
export async function refreshCampaignMembers(tx: OrgTx): Promise<{ sent: number; responded: number }> {
  const responded = await tx.query(
    `update crm_campaign_members m set status = 'responded', responded_at = coalesce(
         (select min(x.sent_at) from crm_messages x
            where x.direction = 'received' and x.sent_at > m.added_at
              and lower(x.from_email) = lower(coalesce((select l.email from crm_leads l where l.id = m.lead_id), (select p.email from crm_people p where p.id = m.person_id)))),
         now()),
       updated_at = now()
      where m.status <> 'responded'
        and (
          exists (select 1 from crm_messages x
                   where x.direction = 'received' and x.sent_at > m.added_at
                     and lower(x.from_email) = lower(coalesce((select l.email from crm_leads l where l.id = m.lead_id), (select p.email from crm_people p where p.id = m.person_id))))
          or (m.lead_id is not null and exists (select 1 from crm_activities a
                   where a.lead_id = m.lead_id and a.created_by_email = 'lead-mailbox@tohyee' and a.created_at > m.added_at))
        )`,
  );
  const sent = await tx.query(
    `update crm_campaign_members m set status = 'sent', updated_at = now()
      where m.status = 'added'
        and exists (select 1 from crm_sent_emails e
                     where e.status = 'sent' and e.sent_at > m.added_at
                       and ((m.lead_id is not null and e.lead_id = m.lead_id) or (m.person_id is not null and e.person_id = m.person_id)))`,
  );
  return { sent: sent.rowCount ?? 0, responded: responded.rowCount ?? 0 };
}

// ---------------------------------------------------------------------------
// Report

export type CurrencyAmount = { currencyCode: string; amount: string };

export type CampaignReport = {
  campaign: Campaign;
  baseCurrency: string;
  members: Record<MemberStatus, number>;
  leads: { sourced: number; converted: number; open: number; unqualified: number };
  deals: { sourced: number; won: number; lost: number; open: number; wonAmounts: CurrencyAmount[]; openAmounts: CurrencyAmount[] };
  /** Actual cost (or the budget when no cost yet) divided by sourced leads or won deals; null when there are none. */
  costPerLead: string | null;
  costPerWonDeal: string | null;
  /** Whether the per-lead and per-deal figures use the budget because no actual cost is entered. */
  costIsBudget: boolean;
  /** For a sales rep or manager, only their leads and deals are counted (decision 491). */
  scoped: boolean;
};

export async function campaignReport(tx: OrgTx, idInput: unknown, scope?: CrmScope): Promise<CampaignReport> {
  const campaign = await getCampaign(tx, idInput);
  const owners = scope?.owners ?? null;
  const members = await tx.query<{ status: MemberStatus; count: number }>(
    `select m.status, count(*)::int as count from crm_campaign_members m left join crm_leads l on l.id = m.lead_id
      where m.campaign_id = $1 and ($2::text[] is null or m.lead_id is null or l.owner_user_id = any($2))
      group by m.status`,
    [campaign.id, owners],
  );
  const leads = await tx.query<{ status: string; count: number }>(
    `select l.status, count(*)::int as count from crm_leads l
      where l.source_campaign_id = $1 and ($2::text[] is null or l.owner_user_id = any($2)) group by l.status`,
    [campaign.id, owners],
  );
  const deals = await tx.query<{ stage_type: string; currency_code: string; count: number; amount: string }>(
    `select s.stage_type, o.currency_code, count(*)::int as count, sum(o.amount)::text as amount
       from crm_opportunities o join crm_opportunity_stages s on s.key = o.stage
      where o.source_campaign_id = $1 and ($2::text[] is null or o.owner_user_id = any($2))
      group by s.stage_type, o.currency_code
      order by s.stage_type, o.currency_code`,
    [campaign.id, owners],
  );
  const memberCounts: Record<MemberStatus, number> = { added: 0, sent: 0, responded: 0 };
  for (const row of members.rows) memberCounts[row.status] = row.count;
  const leadCount = (status: string) => leads.rows.filter((row) => row.status === status).reduce((sum, row) => sum + row.count, 0);
  const sourcedLeads = leads.rows.reduce((sum, row) => sum + row.count, 0);
  const dealCount = (type: string) => deals.rows.filter((row) => row.stage_type === type).reduce((sum, row) => sum + row.count, 0);
  const amounts = (type: string): CurrencyAmount[] =>
    deals.rows.filter((row) => row.stage_type === type).map((row) => ({ currencyCode: row.currency_code, amount: toFixedString(dec(row.amount), 2) }));
  const won = dealCount("won");
  const costText = campaign.actualCost ?? campaign.budget;
  const cost = costText === null ? null : dec(costText);
  const per = (count: number) => (cost === null || count === 0 ? null : toFixedString(divide(cost, dec(String(count)), 2), 2));
  return {
    campaign,
    baseCurrency: (await getOrganisationSettings(tx)).baseCurrency,
    members: memberCounts,
    leads: { sourced: sourcedLeads, converted: leadCount("converted"), open: leadCount("new") + leadCount("working"), unqualified: leadCount("unqualified") },
    deals: {
      sourced: deals.rows.reduce((sum, row) => sum + row.count, 0),
      won,
      lost: dealCount("lost"),
      open: dealCount("open"),
      wonAmounts: amounts("won"),
      openAmounts: amounts("open"),
    },
    costPerLead: per(sourcedLeads),
    costPerWonDeal: per(won),
    costIsBudget: campaign.actualCost === null && campaign.budget !== null,
    scoped: owners !== null,
  };
}

/** Every campaign with what it brought in, for the list (counts only; amounts are on each campaign's report). */
export async function campaignTotals(tx: OrgTx, scope?: CrmScope): Promise<Record<string, { leads: number; deals: number; won: number }>> {
  const owners = scope?.owners ?? null;
  const rows = await tx.query<{ id: string; leads: number; deals: number; won: number }>(
    `select c.id::text,
            (select count(*)::int from crm_leads l where l.source_campaign_id = c.id and ($1::text[] is null or l.owner_user_id = any($1))) as leads,
            (select count(*)::int from crm_opportunities o where o.source_campaign_id = c.id and ($1::text[] is null or o.owner_user_id = any($1))) as deals,
            (select count(*)::int from crm_opportunities o join crm_opportunity_stages s on s.key = o.stage
              where o.source_campaign_id = c.id and s.stage_type = 'won' and ($1::text[] is null or o.owner_user_id = any($1))) as won
       from crm_campaigns c order by c.id`,
    [owners],
  );
  return Object.fromEntries(rows.rows.map((row) => [row.id, { leads: row.leads, deals: row.deals, won: row.won }]));
}
