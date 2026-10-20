import { writeAdminAuditEvent } from "@/lib/audit";
import { sees } from "@/lib/consolidation/customers";
import { type GroupUser, requireGroup, rolesOf } from "@/lib/consolidation/groups";
import { consolidatedBalanceSheet, consolidatedProfitAndLoss } from "@/lib/consolidation/report";
import { withSteward } from "@/lib/consolidation/steward";
import type { ConsolidatedReport, ConsolidationMember } from "@/lib/consolidation/types";
import { withCoreTransaction } from "@/lib/db/transactions";
import { NotFoundError } from "@/lib/errors";
import { requireId, requireOneOf } from "@/lib/validation";

/**
 * Saved consolidated reports (decisions 640 and 645; Codex, delegated by
 * owner, 20 October 2026). Saving runs the report on the server and keeps
 * its figures, the members it used with their dates, the group's version
 * and who saved it, in the steward's database, never changed afterwards.
 * Later membership changes don't alter a saved report: it keeps the member
 * set it used. It's shown only to someone who can see the group now and
 * every organisation in it, so leaving the group or losing access to a
 * member hides it from them.
 */

export type ReportSnapshotSummary = {
  id: string;
  report: "profit_and_loss" | "balance_sheet";
  from: string | null;
  to: string;
  currencyCode: string;
  members: ConsolidationMember[];
  groupName: string;
  groupVersion: number;
  savedByEmail: string;
  savedAt: string;
};

export type ReportSnapshot = ReportSnapshotSummary & { body: ConsolidatedReport };

export type ReportSnapshotList = {
  snapshots: ReportSnapshotSummary[];
  /** Saved reports that include an organisation the person can't see: not shown, only counted. */
  hidden: number;
};

type Row = {
  id: string;
  report: "profit_and_loss" | "balance_sheet";
  period_from: string | null;
  period_to: string;
  currency_code: string;
  member_ids: string[];
  members: ConsolidationMember[];
  group_name: string;
  group_version: number;
  saved_by_email: string;
  saved_at: string;
};

const COLUMNS = "id::text, report, period_from::text, period_to::text, currency_code, member_ids, members, group_name, group_version, saved_by_email, saved_at";

function summary(row: Row): ReportSnapshotSummary {
  return {
    id: row.id,
    report: row.report,
    from: row.period_from,
    to: row.period_to,
    currencyCode: row.currency_code,
    members: row.members,
    groupName: row.group_name,
    groupVersion: row.group_version,
    savedByEmail: row.saved_by_email,
    savedAt: row.saved_at,
  };
}

/** Saves a copy of a consolidated profit and loss or balance sheet. Bookkeepers or above of every organisation. */
export async function saveReportSnapshot(user: GroupUser, groupIdInput: unknown, input: Record<string, unknown>): Promise<ReportSnapshotSummary> {
  const group = await requireGroup(user, groupIdInput, "bookkeeper");
  const kind = requireOneOf(input.report, "report", ["profit_and_loss", "balance_sheet"] as const);
  const report = kind === "profit_and_loss" ? await consolidatedProfitAndLoss(user, group.id, { from: input.from, to: input.to }) : await consolidatedBalanceSheet(user, group.id, { asAt: input.asAt ?? input.to });
  const members = report.group.members;
  const saved = await withSteward(user, group, (tx) =>
    tx.query<Row>(
      `insert into group_report_snapshots (group_id, group_name, report, period_from, period_to, currency_code, member_ids, members, group_version, body, saved_by_user_id, saved_by_email)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11, $12) returning ${COLUMNS}`,
      [
        group.id,
        group.name,
        kind,
        kind === "profit_and_loss" ? report.from : null,
        report.to,
        report.currencyCode,
        members.map((member) => member.organisationId),
        JSON.stringify(members),
        group.version,
        JSON.stringify(report),
        user.id,
        user.email,
      ],
    ),
  );
  await withCoreTransaction((client) =>
    writeAdminAuditEvent(client, { userId: user.id, email: user.email }, {
      eventType: "consolidation_group.report_saved",
      entityType: "consolidation_group",
      entityId: group.id,
      details: { snapshotId: saved.rows[0].id, report: kind, from: report.from, to: report.to, members: members.map((member) => member.organisationId) },
    }),
  );
  return summary(saved.rows[0]);
}

/** The group's saved reports the person may see, newest first. */
export async function listReportSnapshots(user: GroupUser, groupIdInput: unknown): Promise<ReportSnapshotList> {
  const group = await requireGroup(user, groupIdInput);
  const found = await withSteward(user, group, (tx) => tx.query<Row>(`select ${COLUMNS} from group_report_snapshots where group_id = $1 order by saved_at desc, group_report_snapshots.id desc`, [group.id]), {
    readOnly: true,
  });
  const roles = await rolesOf(user.id);
  const visible = found.rows.filter((row) => row.member_ids.every((id) => sees(roles, id)));
  return { snapshots: visible.map(summary), hidden: found.rows.length - visible.length };
}

/** One saved report with its figures; "not found" unless the person can see every organisation in it. */
export async function getReportSnapshot(user: GroupUser, groupIdInput: unknown, idInput: unknown): Promise<ReportSnapshot> {
  const group = await requireGroup(user, groupIdInput);
  const id = requireId(idInput, "snapshotId");
  const found = await withSteward(user, group, (tx) => tx.query<Row & { body: ConsolidatedReport }>(`select ${COLUMNS}, body from group_report_snapshots where id = $1 and group_id = $2`, [id, group.id]), {
    readOnly: true,
  });
  const row = found.rows[0];
  const roles = await rolesOf(user.id);
  if (!row || !row.member_ids.every((member) => sees(roles, member))) throw new NotFoundError("Saved report not found.");
  return { ...summary(row), body: row.body };
}
