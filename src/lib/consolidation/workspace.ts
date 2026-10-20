import { type GroupCustomerLink, readGroupCustomers } from "@/lib/consolidation/customers";
import { type GroupUser, listRateOverrides } from "@/lib/consolidation/groups";
import { coreQuery } from "@/lib/db/transactions";
import { consolidatedProfitAndLoss, groupOn } from "@/lib/consolidation/report";
import { readMemberStages, readStageMappings } from "@/lib/consolidation/stage-mappings";
import { memberRecord } from "@/lib/consolidation/steward";
import type { ConsolidationGroup, ConsolidationMember } from "@/lib/consolidation/types";
import { readWorkspaceCache, workspaceCacheKey, writeWorkspaceCache } from "@/lib/consolidation/workspace-cache";
import {
  type CurrencyAmount,
  type MemberStage,
  mergeCurrencyTotals,
  resolveStages,
  totalsByCurrency,
  type TranslatedTotal,
  type TranslationRate,
  translateTotals,
} from "@/lib/consolidation/workspace-figures";
import { listOpportunities } from "@/lib/crm/service";
import { crmEnabled } from "@/lib/crm/switch";
import { RECEIVABLES_SQL } from "@/lib/customers/service";
import { parseOptionalIsoDate, todayIsoDate } from "@/lib/dates";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { formatDate } from "@/lib/format";
import { listedRateOn } from "@/lib/fx/rates";
import { accountingEnabled } from "@/lib/organisations/accounting-switch";
import { toFixedString, dec } from "@/lib/money/decimal";
import { requireOneOf } from "@/lib/validation";

/**
 * The group workspace (#200 stage 1, decisions 640-645; Codex, delegated by
 * owner, 20 October 2026), after NetSuite OneWorld's group views: one page
 * for the whole group on a date, without switching organisation.
 *
 * - Accounting is the existing consolidated profit and loss (same rules,
 *   nothing new worked out), so it agrees with the Profit and loss tab.
 * - CRM pipeline is added up per currency, never across currencies, unless
 *   the person picks a labelled translation basis.
 * - Customers are only combined where a person linked them.
 * - Each member's part is read from its own database as the signed-in
 *   person; anyone who can't see every member can't see the group. A
 *   member whose module is off, or whose database can't be read, is named
 *   and the figures say they're incomplete.
 * - The result is a short-lived copy per person (workspace-cache.ts).
 */

export const TAX_NOTE =
  "Being in a group here doesn't make the organisations a tax group. Consolidation for income tax or a GST group is a separate election with Inland Revenue, and Tohyee doesn't combine anyone's tax.";

export type TranslationBasis = "none" | "consolidation_current";

export type WorkspaceMember = ConsolidationMember & {
  isParent: boolean;
  isSteward: boolean;
  accountingOn: boolean;
  crmOn: boolean;
  /** Open opportunities now, per currency; null with the CRM off. */
  pipeline: CurrencyAmount[] | null;
  /** What customers owe on the date, in the member's own currency; null with Accounting off. */
  receivables: string | null;
  /** Why this member's figures couldn't be read; its parts are left out and the page says so. */
  error: string | null;
};

export type WorkspaceCustomerLink = GroupCustomerLink & { pipeline: CurrencyAmount[] | null; owed: string | null; owedCurrency: string };

export type WorkspaceCustomer = {
  id: string;
  name: string;
  links: WorkspaceCustomerLink[];
  /** Per currency, over the links still in the group. */
  pipeline: CurrencyAmount[];
  owed: Array<{ currencyCode: string; amount: string }>;
};

export type GroupWorkspace = {
  group: ConsolidationGroup;
  asAt: string;
  computedAt: string;
  taxNote: string;
  members: WorkspaceMember[];
  /** False when any member's part is missing; `gaps` says which and why. */
  complete: boolean;
  gaps: string[];
  accounting: {
    from: string | null;
    to: string;
    currencyCode: string;
    perMember: Array<{ organisationId: string; revenue: string; netProfit: string }>;
    revenue: string | null;
    eliminations: string | null;
    netProfit: string | null;
    notices: string[];
    /** Why the consolidated profit and loss couldn't be made (a missing rate, a member joining part-way). */
    error: string | null;
  };
  pipeline: {
    byCurrency: CurrencyAmount[];
    basis: TranslationBasis;
    translated: TranslatedTotal | null;
    /** Combined by group stage, per currency; null while any stage in use is unmapped. */
    byStage: Array<{ groupStage: string; totals: CurrencyAmount[] }> | null;
    unmappedStages: MemberStage[];
  };
  customers: { items: WorkspaceCustomer[]; hiddenLinks: number };
};

type OpenDeal = { contactId: string; stage: string; currencyCode: string; amount: string; weighted: string };

type MemberRead = { accountingOn: boolean; crmOn: boolean; deals: OpenDeal[]; receivables: string | null; owedByContact: Map<string, string> };

async function readMember(user: GroupUser, member: ConsolidationMember, asAt: string, contactIds: string[]): Promise<MemberRead> {
  const record = await memberRecord(member.organisationId);
  return withOrganisationTransaction(
    record,
    { userId: user.id, email: user.email },
    async (tx) => {
      const accountingOn = await accountingEnabled(tx);
      const crmOn = await crmEnabled(tx);
      const deals = crmOn
        ? (await listOpportunities(tx))
            // Open now: the CRM keeps no amounts as at a past date.
            .filter((deal) => deal.stageType === "open")
            .map((deal) => ({ contactId: deal.contactId, stage: deal.stage, currencyCode: deal.currencyCode, amount: deal.amount, weighted: deal.weightedAmount }))
        : [];
      let receivables: string | null = null;
      const owedByContact = new Map<string, string>();
      if (accountingOn) {
        const total = await tx.query<{ due: string }>(`${RECEIVABLES_SQL} select coalesce(sum(amount_due_base), 0)::text as due from invoices`, [asAt]);
        receivables = toFixedString(dec(total.rows[0].due), 2);
        if (contactIds.length > 0) {
          const owed = await tx.query<{ contact_id: string; due: string }>(
            `${RECEIVABLES_SQL} select contact_id::text, coalesce(sum(amount_due_base), 0)::text as due from invoices where contact_id = any($2::bigint[]) group by contact_id`,
            [asAt, contactIds],
          );
          for (const row of owed.rows) owedByContact.set(row.contact_id, toFixedString(dec(row.due), 2));
        }
      }
      return { accountingOn, crmOn, deals, receivables, owedByContact };
    },
    { readOnly: true },
  );
}

/** The parent's current rate on the date for each currency (decision 439's current rate, with a month's changed rate). */
async function currentRates(user: GroupUser, group: ConsolidationGroup, currencies: string[], asAt: string): Promise<Map<string, TranslationRate>> {
  const wanted = currencies.filter((code) => code !== group.currencyCode);
  const rates = new Map<string, TranslationRate>();
  if (wanted.length === 0) return rates;
  const month = `${asAt.slice(0, 7)}-01`;
  const overrides = (await listRateOverrides(group.id)).filter((entry) => entry.kind === "current" && entry.month === month);
  const parent = await memberRecord(group.parentOrganisationId);
  await withOrganisationTransaction(
    parent,
    { userId: user.id, email: user.email },
    async (tx) => {
      for (const code of wanted) {
        const changed = overrides.find((entry) => entry.currencyCode === code);
        if (changed) {
          rates.set(code, { currencyCode: code, rate: changed.rate, date: null, changed: true });
          continue;
        }
        const listed = await listedRateOn(tx, code, asAt);
        if (listed) rates.set(code, { currencyCode: code, rate: listed.rate, date: listed.date, changed: false });
      }
    },
    { readOnly: true },
  );
  return rates;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "It couldn't be read.";
}

/**
 * The workspace on a date (`asAt`, today by default), with `basis`
 * "consolidation_current" to translate the pipeline into the group's
 * currency.
 */
export async function groupWorkspace(user: GroupUser, groupIdInput: unknown, input: { asAt?: unknown; basis?: unknown } = {}): Promise<GroupWorkspace & { fromCopy: boolean }> {
  const asAt = parseOptionalIsoDate(input.asAt, "asAt") ?? todayIsoDate();
  const basis: TranslationBasis = input.basis == null || input.basis === "" ? "none" : requireOneOf(input.basis, "basis", ["none", "consolidation_current"] as const);
  // Checked every time, before any copy is used: revoked access is refused at once.
  const { group, periods, current } = await groupOn(user, groupIdInput, asAt);
  // The person's memberships, with when each was made: taken away and given back is a new copy too.
  const held = await coreQuery<{ organisation_id: string; role: string; since: string }>(
    "select organisation_id, role, created_at::text as since from organisation_members where user_id = $1 and organisation_id = any($2::text[])",
    [user.id, periods.map((period) => period.organisationId)],
  );
  const memberships = new Map(held.rows.map((row) => [row.organisation_id, `${row.role}@${row.since}`]));
  const key = workspaceCacheKey({
    userId: user.id,
    groupId: group.id,
    version: group.version,
    periods,
    roles: periods.map((period) => [period.organisationId, memberships.get(period.organisationId)]),
    extra: `${asAt}|${basis}`,
  });
  const cached = readWorkspaceCache<GroupWorkspace>(key);
  if (cached) return { ...cached.value, fromCopy: true };
  const built = await buildWorkspace(user, group, current, asAt, basis);
  writeWorkspaceCache(key, group.id, built);
  return { ...built, fromCopy: false };
}

async function buildWorkspace(user: GroupUser, group: ConsolidationGroup, current: ConsolidationGroup, asAt: string, basis: TranslationBasis): Promise<GroupWorkspace> {
  const gaps: string[] = [];
  const customers = await readGroupCustomers(user, current);
  if (customers.hiddenLinks > 0) gaps.push(`${customers.hiddenLinks} customer link${customers.hiddenLinks === 1 ? " is" : "s are"} to organisations that have left the group and that you can't see.`);
  const inGroup = new Set(group.members.map((member) => member.organisationId));
  const contactsByOrganisation = new Map<string, string[]>();
  for (const customer of customers.customers) {
    for (const link of customer.links) {
      if (!inGroup.has(link.organisationId)) continue;
      contactsByOrganisation.set(link.organisationId, [...(contactsByOrganisation.get(link.organisationId) ?? []), link.contactId]);
    }
  }

  const reads = await Promise.all(
    group.members.map(async (member) => {
      try {
        return { member, read: await readMember(user, member, asAt, contactsByOrganisation.get(member.organisationId) ?? []), error: null as string | null };
      } catch (error) {
        return { member, read: null, error: errorText(error) };
      }
    }),
  );

  const members: WorkspaceMember[] = reads.map(({ member, read, error }) => {
    if (error) gaps.push(`${member.name} couldn't be read: ${error}`);
    else if (read && !read.crmOn) gaps.push(`The CRM is off in ${member.name}, so its pipeline isn't included.`);
    if (read && !read.accountingOn) gaps.push(`Accounting is off in ${member.name}, so what its customers owe isn't included.`);
    return {
      ...member,
      isParent: member.organisationId === group.parentOrganisationId,
      isSteward: member.organisationId === group.stewardOrganisationId,
      accountingOn: read?.accountingOn ?? false,
      crmOn: read?.crmOn ?? false,
      pipeline: read?.crmOn ? totalsByCurrency(read.deals, group.currencyCode) : null,
      receivables: read?.receivables ?? null,
      error,
    };
  });

  // Accounting: the consolidated profit and loss for the group's year to date, exactly as the report makes it.
  const accounting: GroupWorkspace["accounting"] = { from: null, to: asAt, currencyCode: group.currencyCode, perMember: [], revenue: null, eliminations: null, netProfit: null, notices: [], error: null };
  try {
    const report = await consolidatedProfitAndLoss(user, group.id, { to: asAt });
    const revenue = report.sections.find((section) => section.key === "revenue")?.total;
    const net = report.totals.find((line) => line.name === "Net profit");
    accounting.from = report.from;
    accounting.perMember = report.group.members.map((member) => ({
      organisationId: member.organisationId,
      revenue: revenue?.amounts[member.organisationId] ?? "0.00",
      netProfit: net?.amounts[member.organisationId] ?? "0.00",
    }));
    accounting.revenue = revenue?.consolidated ?? "0.00";
    accounting.eliminations = net?.eliminations ?? "0.00";
    accounting.netProfit = net?.consolidated ?? "0.00";
    accounting.notices = report.notices;
  } catch (error) {
    accounting.error = errorText(error);
    gaps.push(`The consolidated profit and loss couldn't be made: ${accounting.error}`);
  }

  // Pipeline: per currency; by group stage only where every stage in use is mapped or the same everywhere.
  const readable = reads.filter((entry) => entry.read?.crmOn);
  const deals = readable.flatMap((entry) => entry.read!.deals.map((deal) => ({ ...deal, organisationId: entry.member.organisationId })));
  const byCurrency = mergeCurrencyTotals(
    members.map((member) => member.pipeline ?? []),
    group.currencyCode,
  );
  let translated: TranslatedTotal | null = null;
  if (basis === "consolidation_current") {
    const rates = await currentRates(user, group, byCurrency.map((entry) => entry.currencyCode), asAt);
    translated = translateTotals(byCurrency, group.currencyCode, rates, `Translated into ${group.currencyCode} at the consolidation's current rates on ${formatDate(asAt)} (the parent's exchange rates list, or a month's changed rate). Not an accounting figure.`);
    if (translated.untranslated.length > 0) gaps.push(`There's no rate for ${translated.untranslated.map((entry) => entry.currencyCode).join(", ")} on ${formatDate(asAt)}, so ${translated.untranslated.length === 1 ? "it isn't" : "they aren't"} in the translated total.`);
  }
  let byStage: GroupWorkspace["pipeline"]["byStage"] = null;
  let unmappedStages: MemberStage[] = [];
  if (readable.length > 0) {
    const { stages, crmOn } = await readMemberStages(user, group);
    const mappings = await readStageMappings(user, group);
    const resolution = resolveStages(stages, mappings, crmOn);
    const inUse = new Set(deals.map((deal) => `${deal.organisationId}|${deal.stage}`));
    unmappedStages = resolution.unmapped.filter((stage) => inUse.has(`${stage.organisationId}|${stage.key}`));
    if (unmappedStages.length === 0) {
      const grouped = new Map<string, typeof deals>();
      for (const deal of deals) {
        const name = resolution.resolved.get(`${deal.organisationId}|${deal.stage}`)!;
        grouped.set(name, [...(grouped.get(name) ?? []), deal]);
      }
      byStage = [...grouped.entries()].map(([groupStage, list]) => ({ groupStage, totals: totalsByCurrency(list, group.currencyCode) }));
    }
  }

  // Customers: only the links a person made; figures from each member's own records.
  const readOf = new Map(reads.map((entry) => [entry.member.organisationId, entry]));
  const items: WorkspaceCustomer[] = customers.customers.map((customer) => {
    const links: WorkspaceCustomerLink[] = customer.links.map((link) => {
      const entry = readOf.get(link.organisationId);
      const read = link.inGroup ? entry?.read : null;
      const own = read?.crmOn ? totalsByCurrency(read.deals.filter((deal) => deal.contactId === link.contactId), group.currencyCode) : null;
      return {
        ...link,
        pipeline: own,
        owed: read?.accountingOn ? (read.owedByContact.get(link.contactId) ?? "0.00") : null,
        owedCurrency: entry?.member.currencyCode ?? group.members.concat(group.formerMembers).find((member) => member.organisationId === link.organisationId)?.currencyCode ?? "",
      };
    });
    const live = links.filter((link) => link.inGroup);
    const owed = totalsByCurrency(
      live.filter((link) => link.owed !== null).map((link) => ({ currencyCode: link.owedCurrency, amount: link.owed!, weighted: "0" })),
      group.currencyCode,
    ).map((entry) => ({ currencyCode: entry.currencyCode, amount: entry.amount }));
    return { id: customer.id, name: customer.name, links, pipeline: mergeCurrencyTotals(live.map((link) => link.pipeline ?? []), group.currencyCode), owed };
  });

  return {
    group,
    asAt,
    computedAt: new Date().toISOString(),
    taxNote: TAX_NOTE,
    members,
    complete: gaps.length === 0,
    gaps,
    accounting,
    pipeline: { byCurrency, basis, translated, byStage, unmappedStages },
    customers: { items, hiddenLinks: customers.hiddenLinks },
  };
}
