import { writeAdminAuditEvent, writeAuditEvent } from "@/lib/audit";
import { requireGroup, type GroupUser } from "@/lib/consolidation/groups";
import type { Actor, OrgTx } from "@/lib/db/org-transaction";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { NotFoundError } from "@/lib/errors";
import { requireId, requireOneOf, requireString } from "@/lib/validation";
import { COMMENTARY_REPORTS, type Commentary, type CommentaryReport } from "@/lib/commentary/types";

/**
 * Commentary on the cash flow forecast and consolidated reports (item 6
 * part 3, decision 446; Jess: AI commentary as a suggestion only). Tohyee
 * has no AI of its own: the organisation's connected AI (decisions 339-348)
 * can suggest a commentary, which shows as "Suggested by Jess's AI key
 * Claude, not checked" until a person accepts it (as it is, or edited). A
 * person can write one too; theirs is accepted. Removed ones are kept.
 * The forecast's live in the organisation's database, a group's in the core
 * database with the group.
 */

type Row = {
  id: string;
  report: CommentaryReport;
  period_label: string;
  body: string;
  status: "suggested" | "accepted";
  written_by_email: string;
  written_via: string | null;
  accepted_by_email: string | null;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
};

const COLUMNS = "id::text, report, period_label, body, status, written_by_email, written_via, accepted_by_email, accepted_at, created_at, updated_at";

function toCommentary(row: Row): Commentary {
  return {
    id: row.id,
    report: row.report,
    periodLabel: row.period_label,
    body: row.body,
    status: row.status,
    writtenByEmail: row.written_by_email,
    writtenVia: row.written_via,
    acceptedByEmail: row.accepted_by_email,
    acceptedAt: row.accepted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parse(input: { periodLabel?: unknown; body?: unknown }) {
  return {
    periodLabel: requireString(input.periodLabel, "The period", { maxLength: 200 }),
    body: requireString(input.body, "The commentary", { maxLength: 5000 }),
  };
}

/** Written by the connected AI: a suggestion. By a person: accepted. */
function statusFor(actor: Actor): "suggested" | "accepted" {
  return actor.via ? "suggested" : "accepted";
}

// ---------------------------------------------------------------- the cash flow forecast

export async function listForecastCommentary(tx: OrgTx): Promise<Commentary[]> {
  const found = await tx.query<Row>(`select ${COLUMNS} from report_commentaries where removed_at is null order by created_at desc, id desc limit 20`);
  return found.rows.map(toCommentary);
}

export async function addForecastCommentary(tx: OrgTx, input: { periodLabel?: unknown; body?: unknown }): Promise<Commentary> {
  const { periodLabel, body } = parse(input);
  const status = statusFor(tx.actor);
  const inserted = await tx.query<Row>(
    `insert into report_commentaries (report, period_label, body, status, written_by_email, written_via, accepted_by_email, accepted_at)
     values ('cash_flow_forecast', $1, $2, $3, $4, $5, $6, case when $3 = 'accepted' then now() end) returning ${COLUMNS}`,
    [periodLabel, body, status, tx.actor.email, tx.actor.via ?? null, status === "accepted" ? tx.actor.email : null],
  );
  const commentary = toCommentary(inserted.rows[0]);
  await writeAuditEvent(tx, { eventType: `commentary.${status}`, entityType: "report_commentary", entityId: commentary.id, details: { report: "cash_flow_forecast", periodLabel } });
  return commentary;
}

/** A person accepts a suggestion, as it is or with `body` edited (bookkeepers). */
export async function acceptForecastCommentary(tx: OrgTx, idInput: unknown, input: { body?: unknown }): Promise<Commentary> {
  const id = requireId(idInput, "commentaryId");
  const body = input.body == null || input.body === "" ? null : requireString(input.body, "The commentary", { maxLength: 5000 });
  const updated = await tx.query<Row>(
    `update report_commentaries set body = coalesce($2, body), status = 'accepted', accepted_by_email = $3, accepted_at = now(), updated_at = now()
      where id = $1 and removed_at is null returning ${COLUMNS}`,
    [id, body, tx.actor.email],
  );
  if (!updated.rows[0]) throw new NotFoundError("Commentary not found.");
  await writeAuditEvent(tx, { eventType: "commentary.accepted", entityType: "report_commentary", entityId: id, details: { edited: body !== null } });
  return toCommentary(updated.rows[0]);
}

export async function removeForecastCommentary(tx: OrgTx, idInput: unknown): Promise<void> {
  const id = requireId(idInput, "commentaryId");
  const updated = await tx.query("update report_commentaries set removed_at = now(), removed_by_email = $2, updated_at = now() where id = $1 and removed_at is null", [id, tx.actor.email]);
  if (updated.rowCount === 0) throw new NotFoundError("Commentary not found.");
  await writeAuditEvent(tx, { eventType: "commentary.removed", entityType: "report_commentary", entityId: id, details: {} });
}

// ---------------------------------------------------------------- consolidated reports

export async function listGroupCommentary(user: GroupUser, groupId: unknown): Promise<Commentary[]> {
  const group = await requireGroup(user, groupId);
  const found = await coreQuery<Row>(`select ${COLUMNS} from consolidation_commentaries where group_id = $1 and removed_at is null order by created_at desc, id desc limit 20`, [group.id]);
  return found.rows.map(toCommentary);
}

/** Adds a commentary on a group's report: bookkeepers or above of every organisation in the group, as for the forecast (the AI's is a suggestion). */
export async function addGroupCommentary(user: GroupUser & { via?: string }, groupId: unknown, input: { report?: unknown; periodLabel?: unknown; body?: unknown }): Promise<Commentary> {
  const group = await requireGroup(user, groupId, "bookkeeper");
  const report = requireOneOf(input.report, "report", COMMENTARY_REPORTS.filter((entry) => entry !== "cash_flow_forecast"));
  const { periodLabel, body } = parse(input);
  const status = statusFor({ userId: user.id, email: user.email, via: user.via });
  return withCoreTransaction(async (client) => {
    const inserted = await client.query<Row>(
      `insert into consolidation_commentaries (group_id, report, period_label, body, status, written_by_email, written_via, accepted_by_email, accepted_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, case when $5 = 'accepted' then now() end) returning ${COLUMNS}`,
      [group.id, report, periodLabel, body, status, user.email, user.via ?? null, status === "accepted" ? user.email : null],
    );
    await writeAdminAuditEvent(client, { userId: user.id, email: user.email }, {
      eventType: `consolidation_commentary.${status}`,
      entityType: "consolidation_group",
      entityId: group.id,
      details: { commentaryId: inserted.rows[0].id, report, periodLabel, via: user.via ?? null },
    });
    return toCommentary(inserted.rows[0]);
  });
}

/** Accepts or edits a suggestion, or removes one: bookkeepers or above of every organisation in the group. */
export async function changeGroupCommentary(user: GroupUser, groupId: unknown, idInput: unknown, change: { remove?: boolean; body?: unknown }): Promise<Commentary | null> {
  const group = await requireGroup(user, groupId, "bookkeeper");
  const id = requireId(idInput, "commentaryId");
  const body = change.remove || change.body == null || change.body === "" ? null : requireString(change.body, "The commentary", { maxLength: 5000 });
  return withCoreTransaction(async (client) => {
    const updated = change.remove
      ? await client.query<Row>(
          `update consolidation_commentaries set removed_at = now(), removed_by_email = $3, updated_at = now() where id = $1 and group_id = $2 and removed_at is null returning ${COLUMNS}`,
          [id, group.id, user.email],
        )
      : await client.query<Row>(
          `update consolidation_commentaries set body = coalesce($3, body), status = 'accepted', accepted_by_email = $4, accepted_at = now(), updated_at = now()
            where id = $1 and group_id = $2 and removed_at is null returning ${COLUMNS}`,
          [id, group.id, body, user.email],
        );
    if (!updated.rows[0]) throw new NotFoundError("Commentary not found.");
    await writeAdminAuditEvent(client, { userId: user.id, email: user.email }, {
      eventType: change.remove ? "consolidation_commentary.removed" : "consolidation_commentary.accepted",
      entityType: "consolidation_group",
      entityId: group.id,
      details: { commentaryId: id, edited: body !== null },
    });
    return change.remove ? null : toCommentary(updated.rows[0]);
  });
}
