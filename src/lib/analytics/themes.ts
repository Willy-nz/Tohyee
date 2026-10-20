import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { requireAnalytics } from "@/lib/analytics/sources";
import { checkTheme, CUSTOM_PREFIX, parseReportTheme, type ReportTheme } from "@/lib/charts/report-themes";
import type { ColourWarning } from "@/lib/charts/colour-check";

/** An organisation's own report themes (#376, decision 668). */

export type SavedTheme = {
  id: string;
  theme: ReportTheme;
  /** The colour checks, for the editor; never a reason to refuse. */
  warnings: ColourWarning[];
  /** How many reports use it. */
  reports: number;
  updatedByEmail: string;
  updatedAt: string;
};

type Row = { id: string; definition: ReportTheme; updated_by_email: string; updated_at: Date; reports: string };

function toSaved(row: Row): SavedTheme {
  return {
    id: row.id,
    theme: row.definition,
    warnings: checkTheme(row.definition),
    reports: Number(row.reports),
    updatedByEmail: row.updated_by_email,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const SELECT = `select t.id::text, t.definition, t.updated_by_email, t.updated_at,
  (select count(*) from analytics_dashboards d where d.settings->>'theme' = '${CUSTOM_PREFIX}' || t.id::text)::text as reports
  from analytics_themes t`;

function themeId(id: string): string {
  return /^\d{1,18}$/.test(id) ? id : "0";
}

export async function listThemes(tx: OrgTx): Promise<SavedTheme[]> {
  await requireAnalytics(tx);
  const result = await tx.query<Row>(`${SELECT} order by lower(t.name), t.id`);
  return result.rows.map(toSaved);
}

/** One theme's colours, for drawing a report (null when it's gone). */
export async function findTheme(tx: OrgTx, id: string): Promise<ReportTheme | null> {
  const result = await tx.query<{ definition: ReportTheme }>("select definition from analytics_themes where id = $1", [themeId(id)]);
  return result.rows[0]?.definition ?? null;
}

async function getTheme(tx: OrgTx, id: string): Promise<SavedTheme> {
  const result = await tx.query<Row>(`${SELECT} where t.id = $1`, [themeId(id)]);
  if (!result.rows[0]) throw new NotFoundError("That theme wasn't found.");
  return toSaved(result.rows[0]);
}

async function nameTaken(tx: OrgTx, name: string, except: string | null): Promise<void> {
  const result = await tx.query("select 1 from analytics_themes where lower(name) = lower($1) and ($2::bigint is null or id <> $2::bigint)", [name, except]);
  if (result.rows.length) throw new ValidationError(`There's already a theme called ${name}.`);
}

export async function createTheme(tx: OrgTx, input: unknown): Promise<SavedTheme> {
  await requireAnalytics(tx);
  const theme = parseReportTheme(input);
  await nameTaken(tx, theme.name, null);
  const result = await tx.query<{ id: string }>(
    `insert into analytics_themes (name, definition, created_by_email, updated_by_email) values ($1, $2::jsonb, $3, $3) returning id::text`,
    [theme.name, JSON.stringify(theme), tx.actor.email],
  );
  const id = result.rows[0].id;
  await writeAuditEvent(tx, { eventType: "analytics.theme_saved", entityType: "analytics_theme", entityId: id, details: { name: theme.name } });
  return getTheme(tx, id);
}

/** Changing a theme changes every report that uses it. */
export async function updateTheme(tx: OrgTx, id: string, input: unknown): Promise<SavedTheme> {
  await requireAnalytics(tx);
  const current = await getTheme(tx, id);
  const theme = parseReportTheme(input);
  await nameTaken(tx, theme.name, current.id);
  await tx.query("update analytics_themes set name = $2, definition = $3::jsonb, updated_by_email = $4, updated_at = now() where id = $1", [
    current.id,
    theme.name,
    JSON.stringify(theme),
    tx.actor.email,
  ]);
  await writeAuditEvent(tx, { eventType: "analytics.theme_saved", entityType: "analytics_theme", entityId: current.id, details: { name: theme.name, reports: current.reports } });
  return getTheme(tx, current.id);
}

/** A theme a report uses can't be removed: choose another theme for those reports first. */
export async function deleteTheme(tx: OrgTx, id: string): Promise<void> {
  await requireAnalytics(tx);
  const current = await getTheme(tx, id);
  if (current.reports > 0) {
    throw new ValidationError(`${current.theme.name} is used by ${current.reports} ${current.reports === 1 ? "report" : "reports"}. Choose another theme for ${current.reports === 1 ? "it" : "them"} first.`);
  }
  await tx.query("delete from analytics_themes where id = $1", [current.id]);
  await writeAuditEvent(tx, { eventType: "analytics.theme_deleted", entityType: "analytics_theme", entityId: current.id, details: { name: current.theme.name } });
}
