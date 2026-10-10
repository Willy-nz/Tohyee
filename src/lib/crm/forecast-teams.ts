import { writeAuditEvent } from "@/lib/audit";
import type { CrmScope } from "@/lib/crm/access";
import { type Forecast, forecast, type ForecastRow } from "@/lib/crm/forecast";
import { attainment, type ForecastFigures, FORECAST_PERIODS, type ForecastPeriodKind, periodContaining } from "@/lib/crm/forecast-figures";
import { requireCrm } from "@/lib/crm/switch";
import { listSalesTeams } from "@/lib/crm/teams";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, cmp, dec, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { listMembers } from "@/lib/organisations/members";
import { optionalId, optionalString, requireOneOf } from "@/lib/validation";

/**
 * Team forecasts (decision 499, #216 stage 3; Jess 10 Oct 2026), after
 * Salesforce's forecast hierarchy, adjustments and submitted forecasts:
 *
 * - **Teams:** each sales team's figures are its members' and its
 *   manager's added up, per period and per currency (never across
 *   currencies, decision 324), with their quotas added.
 * - **Adjustments:** a person's team manager, or an admin or owner, can
 *   set a different Commit or Best case figure for someone's period and
 *   currency, with a reason. The deals don't change. Every change is kept;
 *   the newest counts, and clearing it goes back to the deals' figure.
 * - **Snapshots:** someone submits a forecast for a period (their own, a
 *   team's they manage, or everyone's for an admin), and its figures are
 *   kept as they were then, to compare with now.
 */

export const ADJUSTABLE = ["commit", "bestCase"] as const;
export type AdjustableMeasure = (typeof ADJUSTABLE)[number];

export type Adjustment = { amount: string; reason: string; byEmail: string | null; at: string };

export type AdjustedRow = ForecastRow & {
  adjusted: Record<AdjustableMeasure, Adjustment | null>;
  /** Whether the person asking can adjust this row. */
  canAdjust: boolean;
};

export type TeamRow = ForecastFigures & {
  periodStart: string;
  teamId: string;
  teamName: string;
  managerUserId: string;
  currencyCode: string;
  /** The members' figures with their adjustments in place of their own. */
  adjustedCommit: string;
  adjustedBestCase: string;
  quota: string | null;
  attainment: string | null;
};

export type TeamForecast = Omit<Forecast, "rows"> & { rows: AdjustedRow[]; teams: TeamRow[] };

function parseKind(input: unknown): ForecastPeriodKind {
  if (input === undefined || input === null || input === "") return "month";
  return requireOneOf(input, "period", FORECAST_PERIODS);
}

async function yearEndMonth(tx: OrgTx): Promise<number> {
  const settings = await tx.query<{ financial_year_end_month: number }>("select financial_year_end_month from organisation_settings where id = true");
  return settings.rows[0]?.financial_year_end_month ?? 3;
}

/** The latest adjustment for each person, period, currency and figure in the forecast. */
async function latestAdjustments(tx: OrgTx, kind: ForecastPeriodKind, starts: string[]): Promise<Map<string, Adjustment>> {
  const rows = await tx.query<{ owner_user_id: string; period_start: string; currency_code: string; measure: AdjustableMeasure; amount: string | null; reason: string | null; adjusted_by_email: string | null; created_at: string }>(
    `select distinct on (a.owner_user_id, a.period_start, a.currency_code, a.measure)
            a.owner_user_id, a.period_start::text, a.currency_code, a.measure, a.amount::text, a.reason, a.adjusted_by_email, a.created_at::text
       from crm_forecast_adjustments a
      where a.period_kind = $1 and a.period_start = any($2::date[])
      order by a.owner_user_id, a.period_start, a.currency_code, a.measure, a.id desc`,
    [kind, starts],
  );
  const found = new Map<string, Adjustment>();
  for (const row of rows.rows) {
    if (row.amount === null) continue;
    found.set(`${row.period_start}|${row.owner_user_id}|${row.currency_code}|${row.measure}`, {
      amount: toFixedString(dec(row.amount), currencyMinorUnits(row.currency_code)),
      reason: row.reason ?? "",
      byEmail: row.adjusted_by_email,
      at: new Date(row.created_at).toISOString(),
    });
  }
  return found;
}

/** Whose figures the person asking may adjust: an admin anyone's, a team manager their members' (not their own). */
async function adjustableOwners(tx: OrgTx, scope?: CrmScope): Promise<"all" | Set<string>> {
  if (!scope || scope.canAdmin) return "all";
  const teams = await listSalesTeams(tx);
  return new Set(teams.filter((team) => team.managerUserId === scope.userId).flatMap((team) => team.memberUserIds.filter((id) => id !== scope.userId)));
}

/** The forecast with adjustments in and team roll-ups (decision 499). */
export async function teamForecast(
  tx: OrgTx,
  input: { period?: unknown; from?: unknown; periods?: unknown; ownerUserId?: unknown } = {},
  scope?: CrmScope,
): Promise<TeamForecast> {
  const base = await forecast(tx, input, scope);
  const adjustments = await latestAdjustments(tx, base.period, base.periods.map((period) => period.start));
  const adjustable = await adjustableOwners(tx, scope);
  const rows: AdjustedRow[] = base.rows.map((row) => ({
    ...row,
    adjusted: {
      commit: row.ownerUserId ? (adjustments.get(`${row.periodStart}|${row.ownerUserId}|${row.currencyCode}|commit`) ?? null) : null,
      bestCase: row.ownerUserId ? (adjustments.get(`${row.periodStart}|${row.ownerUserId}|${row.currencyCode}|bestCase`) ?? null) : null,
    },
    canAdjust: row.ownerUserId !== null && (adjustable === "all" || adjustable.has(row.ownerUserId)),
  }));

  // Teams the person asking can see: all of them, or a manager's own.
  const teams = (await listSalesTeams(tx)).filter((team) => !scope || scope.owners === null || team.managerUserId === scope.userId);
  const teamRows: TeamRow[] = [];
  for (const team of teams) {
    const people = new Set([team.managerUserId, ...team.memberUserIds]);
    const theirs = rows.filter((row) => row.ownerUserId !== null && people.has(row.ownerUserId));
    const groups = new Map<string, AdjustedRow[]>();
    for (const row of theirs) groups.set(`${row.periodStart}|${row.currencyCode}`, [...(groups.get(`${row.periodStart}|${row.currencyCode}`) ?? []), row]);
    for (const [k, members] of groups) {
      const [periodStart, currencyCode] = k.split("|");
      const minor = currencyMinorUnits(currencyCode);
      const sum = (pick: (row: AdjustedRow) => string) => toFixedString(members.reduce((total, row) => add(total, dec(pick(row))), ZERO_DECIMAL), minor);
      const quotas = members.filter((row) => row.quota !== null);
      const quota = currencyCode === base.baseCurrency && quotas.length > 0 ? sum((row) => row.quota ?? "0") : null;
      const closed = sum((row) => row.closed);
      teamRows.push({
        periodStart,
        teamId: team.id,
        teamName: team.name,
        managerUserId: team.managerUserId,
        currencyCode,
        closed,
        commit: sum((row) => row.commit),
        bestCase: sum((row) => row.bestCase),
        pipeline: sum((row) => row.pipeline),
        weighted: sum((row) => row.weighted),
        count: members.reduce((total, row) => total + row.count, 0),
        adjustedCommit: sum((row) => row.adjusted.commit?.amount ?? row.commit),
        adjustedBestCase: sum((row) => row.adjusted.bestCase?.amount ?? row.bestCase),
        quota,
        attainment: attainment(closed, quota),
      });
    }
  }
  teamRows.sort((a, b) => (a.periodStart === b.periodStart ? a.teamName.localeCompare(b.teamName) || a.currencyCode.localeCompare(b.currencyCode) : a.periodStart < b.periodStart ? -1 : 1));
  return { ...base, rows, teams: teamRows };
}

type AdjustInput = {
  ownerUserId?: unknown;
  period?: unknown;
  periodStart?: unknown;
  currencyCode?: unknown;
  measure?: unknown;
  amount?: unknown;
  reason?: unknown;
};

async function checkPeriod(tx: OrgTx, kindInput: unknown, startInput: unknown): Promise<{ kind: ForecastPeriodKind; start: string; label: string }> {
  const kind = parseKind(kindInput);
  const start = parseIsoDate(startInput, "periodStart");
  const period = periodContaining(start, kind, await yearEndMonth(tx));
  if (period.start !== start) throw new ValidationError(`${start} isn't the start of a ${kind}. Use ${period.start}.`);
  return { kind, start, label: period.label };
}

/** Sets (or, with no amount, clears) someone's Commit or Best case for a period and currency, with a reason (decision 499). */
export async function adjustForecast(tx: OrgTx, input: AdjustInput, scope?: CrmScope): Promise<{ adjusted: Adjustment | null }> {
  await requireCrm(tx);
  if (typeof input.ownerUserId !== "string" || input.ownerUserId === "") throw new ValidationError("Choose whose forecast to adjust.");
  const ownerUserId = input.ownerUserId;
  if (!(await listMembers(tx.organisationId)).some((member) => member.userId === ownerUserId)) throw new ValidationError("That person isn't a member of the organisation.");
  const allowed = await adjustableOwners(tx, scope);
  if (allowed !== "all" && !allowed.has(ownerUserId)) {
    throw new ForbiddenError("Only the person's sales team manager, or an admin or owner, can adjust their forecast.");
  }
  const { kind, start } = await checkPeriod(tx, input.period, input.periodStart);
  if (typeof input.currencyCode !== "string" || !/^[A-Z]{3}$/.test(input.currencyCode)) throw new ValidationError("Give the currency, like NZD.");
  const currencyCode = input.currencyCode;
  const measure = requireOneOf(input.measure, "measure", ADJUSTABLE);
  let amount: string | null = null;
  const minor = currencyMinorUnits(currencyCode);
  if (input.amount !== undefined && input.amount !== null && input.amount !== "") {
    const text = typeof input.amount === "number" ? String(input.amount) : typeof input.amount === "string" ? input.amount.trim().replace(/^\$/, "").replace(/,/g, "") : "";
    if (!/^\d{1,15}(\.\d{1,2})?$/.test(text)) throw new ValidationError("The figure must be an amount with at most 2 decimal places, like 12000.00.");
    if (cmp(dec(text), dec(toFixedString(dec(text), minor))) !== 0) throw new ValidationError(`${currencyCode} has no cents, so the figure must be a whole number.`);
    amount = toFixedString(dec(text), minor);
  }
  const reason = optionalString(input.reason, "reason", { maxLength: 500 });
  if (amount !== null && !reason) throw new ValidationError("Say why you're adjusting the forecast.");
  await tx.query(
    `insert into crm_forecast_adjustments (owner_user_id, period_kind, period_start, currency_code, measure, amount, reason, adjusted_by_user_id, adjusted_by_email)
     values ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9)`,
    [ownerUserId, kind, start, currencyCode, measure, amount, reason, tx.actor.userId, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: amount === null ? "crm.forecast_adjustment_cleared" : "crm.forecast_adjusted",
    entityType: "crm_forecast_adjustment",
    entityId: `${ownerUserId}:${kind}:${start}:${currencyCode}:${measure}`,
    details: { ownerUserId, period: kind, periodStart: start, currencyCode, measure, amount, reason },
  });
  return { adjusted: amount === null ? null : { amount, reason: reason!, byEmail: tx.actor.email, at: new Date().toISOString() } };
}

export type AdjustmentHistoryEntry = { amount: string | null; reason: string | null; byEmail: string | null; at: string; measure: AdjustableMeasure; currencyCode: string };

/** Every adjustment of someone's period, newest first (who, when, why). */
export async function adjustmentHistory(
  tx: OrgTx,
  input: { ownerUserId?: unknown; period?: unknown; periodStart?: unknown },
  scope?: CrmScope,
): Promise<AdjustmentHistoryEntry[]> {
  if (typeof input.ownerUserId !== "string" || input.ownerUserId === "") throw new ValidationError("Choose whose forecast.");
  if (scope?.owners && !scope.owners.includes(input.ownerUserId)) throw new NotFoundError("That person's forecast isn't yours to see.");
  const { kind, start } = await checkPeriod(tx, input.period, input.periodStart);
  const rows = await tx.query<{ amount: string | null; reason: string | null; adjusted_by_email: string | null; created_at: string; measure: AdjustableMeasure; currency_code: string }>(
    `select a.amount::text, a.reason, a.adjusted_by_email, a.created_at::text, a.measure, a.currency_code from crm_forecast_adjustments a
      where a.owner_user_id = $1 and a.period_kind = $2 and a.period_start = $3 order by a.id desc limit 200`,
    [input.ownerUserId, kind, start],
  );
  return rows.rows.map((row) => ({
    amount: row.amount === null ? null : toFixedString(dec(row.amount), currencyMinorUnits(row.currency_code)),
    reason: row.reason,
    byEmail: row.adjusted_by_email,
    at: new Date(row.created_at).toISOString(),
    measure: row.measure,
    currencyCode: row.currency_code,
  }));
}

export type SnapshotFigures = Array<
  Pick<ForecastFigures, "closed" | "commit" | "bestCase" | "pipeline" | "weighted" | "count"> & {
    currencyCode: string;
    adjustedCommit: string;
    adjustedBestCase: string;
    quota: string | null;
  }
>;

export type ForecastSnapshot = {
  id: string;
  scopeKind: "owner" | "team" | "all";
  ownerUserId: string | null;
  teamId: string | null;
  name: string;
  period: ForecastPeriodKind;
  periodStart: string;
  periodLabel: string;
  figures: SnapshotFigures;
  note: string | null;
  submittedByEmail: string | null;
  submittedAt: string;
};

/**
 * Submits a forecast for one period (decision 499): `ownerUserId` (your
 * own, or a member's for their manager or an admin), `teamId` (its manager
 * or an admin), or neither (everyone's; admins). Its figures are kept as
 * they are now.
 */
export async function submitForecast(
  tx: OrgTx,
  input: { period?: unknown; periodStart?: unknown; ownerUserId?: unknown; teamId?: unknown; note?: unknown },
  scope?: CrmScope,
): Promise<ForecastSnapshot> {
  await requireCrm(tx);
  const { kind, start, label } = await checkPeriod(tx, input.period, input.periodStart);
  const note = optionalString(input.note, "note", { maxLength: 500 });
  const teamId = optionalId(input.teamId, "teamId");
  const ownerUserId = typeof input.ownerUserId === "string" && input.ownerUserId !== "" ? input.ownerUserId : null;
  if (teamId && ownerUserId) throw new ValidationError("Submit one person's forecast or one team's, not both.");
  const current = await teamForecast(tx, { period: kind, from: start, periods: 1 }, scope);
  const names = new Map((await listMembers(tx.organisationId)).map((member) => [member.userId, member.displayName]));
  let scopeKind: ForecastSnapshot["scopeKind"];
  let name: string;
  let teamName: string | null = null;
  let figures: SnapshotFigures;
  if (ownerUserId) {
    if (scope?.owners && !scope.owners.includes(ownerUserId)) throw new NotFoundError("That person's forecast isn't yours to see.");
    if (scope && !scope.canAdmin && ownerUserId !== scope.userId) {
      const allowed = await adjustableOwners(tx, scope);
      if (allowed !== "all" && !allowed.has(ownerUserId)) throw new ForbiddenError("You can submit your own forecast, or your team members'.");
    }
    scopeKind = "owner";
    name = names.get(ownerUserId) ?? "Former member";
    figures = current.rows
      .filter((row) => row.ownerUserId === ownerUserId)
      .map((row) => ({
        currencyCode: row.currencyCode,
        closed: row.closed,
        commit: row.commit,
        bestCase: row.bestCase,
        pipeline: row.pipeline,
        weighted: row.weighted,
        count: row.count,
        adjustedCommit: row.adjusted.commit?.amount ?? row.commit,
        adjustedBestCase: row.adjusted.bestCase?.amount ?? row.bestCase,
        quota: row.quota,
      }));
  } else if (teamId) {
    const team = (await listSalesTeams(tx)).find((entry) => entry.id === teamId);
    if (!team) throw new NotFoundError("Sales team not found.");
    if (scope && !scope.canAdmin && team.managerUserId !== scope.userId) throw new ForbiddenError("Only the team's manager, or an admin or owner, can submit its forecast.");
    scopeKind = "team";
    name = team.name;
    teamName = team.name;
    figures = current.teams
      .filter((row) => row.teamId === teamId)
      .map((row) => ({
        currencyCode: row.currencyCode,
        closed: row.closed,
        commit: row.commit,
        bestCase: row.bestCase,
        pipeline: row.pipeline,
        weighted: row.weighted,
        count: row.count,
        adjustedCommit: row.adjustedCommit,
        adjustedBestCase: row.adjustedBestCase,
        quota: row.quota,
      }));
  } else {
    if (scope && !scope.canAdmin) throw new ForbiddenError("Submitting everyone's forecast needs the admin role or higher.");
    scopeKind = "all";
    name = "Everyone";
    const byCurrency = new Map<string, AdjustedRow[]>();
    for (const row of current.rows) byCurrency.set(row.currencyCode, [...(byCurrency.get(row.currencyCode) ?? []), row]);
    figures = [...byCurrency.entries()].map(([currencyCode, rows]) => {
      const minor = currencyMinorUnits(currencyCode);
      const sum = (pick: (row: AdjustedRow) => string) => toFixedString(rows.reduce((total, row) => add(total, dec(pick(row))), ZERO_DECIMAL), minor);
      const withQuota = rows.filter((row) => row.quota !== null);
      return {
        currencyCode,
        closed: sum((row) => row.closed),
        commit: sum((row) => row.commit),
        bestCase: sum((row) => row.bestCase),
        pipeline: sum((row) => row.pipeline),
        weighted: sum((row) => row.weighted),
        count: rows.reduce((total, row) => total + row.count, 0),
        adjustedCommit: sum((row) => row.adjusted.commit?.amount ?? row.commit),
        adjustedBestCase: sum((row) => row.adjusted.bestCase?.amount ?? row.bestCase),
        quota: withQuota.length > 0 ? sum((row) => row.quota ?? "0") : null,
      };
    });
  }
  const inserted = await tx.query<{ id: string; submitted_at: string }>(
    `insert into crm_forecast_snapshots (scope_kind, owner_user_id, team_id, team_name, period_kind, period_start, period_label, figures, note, submitted_by_user_id, submitted_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11) returning id::text, submitted_at::text`,
    [scopeKind, ownerUserId, teamId, teamName, kind, start, label, JSON.stringify(figures), note, tx.actor.userId, tx.actor.email],
  );
  const id = inserted.rows[0].id;
  await writeAuditEvent(tx, { eventType: "crm.forecast_submitted", entityType: "crm_forecast_snapshot", entityId: id, details: { scopeKind, ownerUserId, teamId, period: kind, periodStart: start } });
  return {
    id,
    scopeKind,
    ownerUserId,
    teamId,
    name,
    period: kind,
    periodStart: start,
    periodLabel: label,
    figures,
    note,
    submittedByEmail: tx.actor.email,
    submittedAt: new Date(inserted.rows[0].submitted_at).toISOString(),
  };
}

/** Submitted forecasts for a period, newest first, that the person asking can see. */
export async function listSnapshots(tx: OrgTx, input: { period?: unknown; periodStart?: unknown }, scope?: CrmScope): Promise<ForecastSnapshot[]> {
  const { kind, start } = await checkPeriod(tx, input.period, input.periodStart);
  const rows = await tx.query<{
    id: string;
    scope_kind: ForecastSnapshot["scopeKind"];
    owner_user_id: string | null;
    team_id: string | null;
    team_name: string | null;
    period_label: string;
    figures: SnapshotFigures;
    note: string | null;
    submitted_by_email: string | null;
    submitted_at: string;
  }>(
    `select s.id::text, s.scope_kind, s.owner_user_id, s.team_id::text, s.team_name, s.period_label, s.figures, s.note, s.submitted_by_email, s.submitted_at::text
       from crm_forecast_snapshots s where s.period_kind = $1 and s.period_start = $2 order by s.submitted_at desc, s.id desc limit 200`,
    [kind, start],
  );
  const managed = scope && scope.owners !== null ? new Set((await listSalesTeams(tx)).filter((team) => team.managerUserId === scope.userId).map((team) => team.id)) : null;
  const names = new Map((await listMembers(tx.organisationId)).map((member) => [member.userId, member.displayName]));
  return rows.rows
    .filter((row) => {
      if (!scope || scope.owners === null) return true;
      if (row.scope_kind === "owner") return row.owner_user_id !== null && scope.owners.includes(row.owner_user_id);
      if (row.scope_kind === "team") return row.team_id !== null && managed!.has(row.team_id);
      return false;
    })
    .map((row) => ({
      id: row.id,
      scopeKind: row.scope_kind,
      ownerUserId: row.owner_user_id,
      teamId: row.team_id,
      name: row.scope_kind === "owner" ? (names.get(row.owner_user_id!) ?? "Former member") : row.scope_kind === "team" ? (row.team_name ?? "Team") : "Everyone",
      period: kind,
      periodStart: start,
      periodLabel: row.period_label,
      figures: row.figures,
      note: row.note,
      submittedByEmail: row.submitted_by_email,
      submittedAt: new Date(row.submitted_at).toISOString(),
    }));
}
