import { writeAuditEvent } from "@/lib/audit";
import { parseOptionalIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { requireId, requireOneOf, requireString } from "@/lib/validation";

/*
 * The farm notebook (examples AIW1, AIW2): what the people on the farm, and
 * the AI, know about it, kept as short notes by category, so questions can be
 * answered with the farm's own history, goals, people and ways of farming.
 * Notes are archived, never deleted.
 */

import { NOTEBOOK_CATEGORIES, type NotebookCategory, type NotebookEntry } from "./notebook-labels";

export { NOTEBOOK_CATEGORIES, NOTEBOOK_CATEGORY_LABELS, type NotebookCategory, type NotebookEntry } from "./notebook-labels";

type Row = {
  id: string;
  category: NotebookCategory;
  title: string;
  body: string;
  happened_on: string | null;
  written_by: "person" | "ai";
  created_by_email: string;
  created_at: string;
  updated_by_email: string;
  updated_at: string;
};

const COLUMNS = `id::text, category, title, body, happened_on::text, written_by, created_by_email,
  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at, updated_by_email,
  to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at`;

const toEntry = (row: Row): NotebookEntry => ({
  id: row.id,
  category: row.category,
  title: row.title,
  body: row.body,
  happenedOn: row.happened_on,
  writtenBy: row.written_by,
  createdByEmail: row.created_by_email,
  createdAt: row.created_at,
  updatedByEmail: row.updated_by_email,
  updatedAt: row.updated_at,
});

/** Notes, newest first; optionally one category and words to look for in the title or text. */
export async function listNotebook(tx: OrgTx, input: { category?: unknown; search?: unknown; limit?: number } = {}): Promise<NotebookEntry[]> {
  const category = input.category === undefined || input.category === null || input.category === "" ? null : requireOneOf(input.category, "category", NOTEBOOK_CATEGORIES);
  const search = typeof input.search === "string" && input.search.trim() !== "" ? `%${input.search.trim().replace(/[\\%_]/g, (match) => `\\${match}`)}%` : null;
  const rows = await tx.query<Row>(
    `select ${COLUMNS} from farm_notebook
      where archived_at is null and ($1::text is null or category = $1) and ($2::text is null or title ilike $2 or body ilike $2)
      order by coalesce(happened_on, created_at::date) desc, id desc limit $3`,
    [category, search, Math.min(Math.max(input.limit ?? 500, 1), 500)],
  );
  return rows.rows.map(toEntry);
}

export async function getNotebookEntry(tx: OrgTx, idInput: unknown): Promise<NotebookEntry> {
  const id = requireId(idInput, "noteId");
  const row = (await tx.query<Row>(`select ${COLUMNS} from farm_notebook where id = $1 and archived_at is null`, [id])).rows[0];
  if (!row) throw new NotFoundError("Note not found.");
  return toEntry(row);
}

function parseNote(input: { category: unknown; title: unknown; body: unknown; happenedOn?: unknown }) {
  return {
    category: requireOneOf(input.category, "category", NOTEBOOK_CATEGORIES),
    title: requireString(input.title, "The title", { maxLength: 200 }),
    body: requireString(input.body, "The note", { maxLength: 20000 }),
    happenedOn: parseOptionalIsoDate(input.happenedOn ?? null, "The date"),
  };
}

/** Adds a note (AIW1). `writtenBy` is "ai" when the AI writes it, so people can tell. */
export async function addNotebookEntry(
  tx: OrgTx,
  input: { category: unknown; title: unknown; body: unknown; happenedOn?: unknown },
  writtenBy: "person" | "ai" = "person",
): Promise<NotebookEntry> {
  const note = parseNote(input);
  const count = await tx.query<{ n: number }>("select count(*)::int as n from farm_notebook where archived_at is null");
  if (count.rows[0].n >= 5000) throw new ValidationError("The notebook is full (5,000 notes). Archive some first.");
  const row = await tx.query<{ id: string }>(
    `insert into farm_notebook (category, title, body, happened_on, written_by, created_by_email, updated_by_email)
     values ($1, $2, $3, $4, $5, $6, $6) returning id::text`,
    [note.category, note.title, note.body, note.happenedOn, writtenBy, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "farm_notebook.added", entityType: "farm_notebook", entityId: row.rows[0].id, details: { category: note.category, title: note.title, writtenBy } });
  return getNotebookEntry(tx, row.rows[0].id);
}

/** Replaces a note's category, title, text and date (AIW2). */
export async function updateNotebookEntry(
  tx: OrgTx,
  idInput: unknown,
  input: { category: unknown; title: unknown; body: unknown; happenedOn?: unknown },
): Promise<NotebookEntry> {
  const existing = await getNotebookEntry(tx, idInput);
  const note = parseNote(input);
  await tx.query(
    "update farm_notebook set category = $2, title = $3, body = $4, happened_on = $5, updated_by_email = $6, updated_at = now() where id = $1",
    [existing.id, note.category, note.title, note.body, note.happenedOn, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "farm_notebook.updated", entityType: "farm_notebook", entityId: existing.id, details: { category: note.category, title: note.title } });
  return getNotebookEntry(tx, existing.id);
}

/** Archives a note (people only: the AI never removes anything). */
export async function archiveNotebookEntry(tx: OrgTx, idInput: unknown): Promise<void> {
  const existing = await getNotebookEntry(tx, idInput);
  await tx.query("update farm_notebook set archived_at = now(), updated_by_email = $2, updated_at = now() where id = $1", [existing.id, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "farm_notebook.archived", entityType: "farm_notebook", entityId: existing.id, details: { title: existing.title } });
}
