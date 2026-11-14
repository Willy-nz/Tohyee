import type { OrgTx } from "@/lib/db/org-transaction";
import { writeAuditEvent } from "@/lib/audit";
import { ValidationError } from "@/lib/errors";
import { parseIsoDate } from "@/lib/dates";
import { requireArray, requireId, requireString } from "@/lib/validation";

/**
 * The words of the annual financial statements around the figures (FS9-FS13,
 * decision 1576): the cover, the compilation report and each page's heading,
 * saved for each year end as a draft or as final. Until saved, Tohyee's
 * default wording is used and the statements are a draft. Nothing posts.
 */

export type CompilationSection = { heading: string; body: string };

export type AnnualTexts = {
  coverTitle: string;
  coverSubtitle: string;
  coverPeriod: string;
  /** The small line at the foot of the cover; blank leaves it off. */
  coverNote: string;
  /** False leaves the compilation report out. */
  compilation: boolean;
  compilationTitle: string;
  compilationSections: CompilationSection[];
  /** The signature block: firm, town, date. */
  compilationSignOff: string;
  /** Page headings by page key ("contents", "performance", "notes", ...); blank or missing is the default. */
  titles: Record<string, string>;
};

/** A note to the statements; a set's own notes replace the organisation's (FS18). */
export type AnnualNote = { title: string; body: string };

/**
 * One set of the year's words (FS16-FS19, decision 1631). `id` is null until
 * it's saved; `notes` is null when the set uses the organisation's notes.
 */
export type AnnualDocument = {
  saved: boolean;
  id: string | null;
  title: string;
  status: "draft" | "final";
  texts: AnnualTexts;
  notes: AnnualNote[] | null;
};

/** A saved set as Reports > Drafts and Published list it (FS17). */
export type AnnualDraftSummary = {
  id: string;
  yearEnd: string;
  title: string;
  status: "draft" | "final";
  updatedAt: string;
  updatedByEmail: string;
};

export const PAGE_KEYS = ["contents", "compilation", "performance", "position", "equity", "cash_flows", "notes", "depreciation"] as const;

function nzLong(iso: string): string {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const [year, month, day] = iso.split("-").map(Number);
  return `${day} ${months[month - 1]} ${year}`;
}

/**
 * Tohyee's default wording (FS10, FS11). The compilation report follows the
 * parts the NZ compilation standard's example report has (scope and purpose,
 * responsibilities, no audit or review, disclaimer, independence, sign-off),
 * written in Tohyee's own words and not yet reviewed by an accountant.
 * [Square brackets] are for the preparer to fill in or confirm.
 */
export function defaultAnnualTexts(name: string, yearEnd: string): AnnualTexts {
  const year = `the year ended ${nzLong(yearEnd)}`;
  return {
    coverTitle: name,
    coverSubtitle: "Financial statements",
    coverPeriod: `For ${year}`,
    coverNote: "Prepared with Tohyee",
    compilation: true,
    compilationTitle: `Compilation report to the [directors / owners / trustees] of ${name}`,
    compilationSections: [
      {
        heading: "Scope and purpose of engagement",
        body: `On the basis of information you gave us, we have compiled the financial statements of ${name} for ${year}, in accordance with Service Engagement Standard 2: Compilation of Financial Information (SES-2). They are prepared on the basis described in the notes, for [your own use and for income tax purposes].`,
      },
      {
        heading: "Responsibilities",
        body: "You are solely responsible for the information in the financial statements, and for deciding that the basis they are prepared on meets your needs. They were compiled for your use and for the purpose above. We accept no responsibility to anyone else who reads or relies on them.",
      },
      {
        heading: "No audit or review engagement undertaken",
        body: "We used our accounting skills to collect, classify and summarise the information you gave us. We have not audited or reviewed the financial statements, or checked the information they come from, so we give no assurance that they are accurate or complete.",
      },
      {
        heading: "Disclaimer of liability",
        body: "The financial statements are compiled from the records and explanations you gave us. To the extent the law allows, neither we nor any of our staff accept liability of any kind, whether in contract, in tort (including negligence) or otherwise, for any loss or damage arising from an error or omission in them, or from anyone relying on them.",
      },
      {
        heading: "Independence",
        body: `[We have no involvement with ${name} other than preparing its financial statements and tax returns. Edit this if we have any other connection, for example as a director, shareholder, trustee or lender.]`,
      },
    ],
    compilationSignOff: "[Firm name]\n[Town], New Zealand\n[Date]",
    titles: {},
  };
}

type DraftRow = {
  id: string;
  year_end: string;
  title: string;
  status: "draft" | "final";
  texts: Partial<AnnualTexts>;
  notes: AnnualNote[] | null;
  updated_at: string;
  updated_by_email: string;
};

const SELECT = "select id::text, year_end::text, title, status, texts, notes, updated_at::text, updated_by_email from annual_statement_drafts";

function documentOf(row: DraftRow, name: string): AnnualDocument {
  const defaults = defaultAnnualTexts(name, row.year_end);
  return {
    saved: true,
    id: row.id,
    title: row.title,
    status: row.status,
    texts: { ...defaults, ...row.texts, titles: { ...(row.texts.titles ?? {}) } },
    notes: row.notes,
  };
}

export function defaultSetTitle(yearEnd: string): string {
  return `Financial statements ${yearEnd.slice(0, 4)}`;
}

async function findDraft(tx: OrgTx, id: string): Promise<DraftRow> {
  const row = (await tx.query<DraftRow>(`${SELECT} where id = $1`, [id])).rows[0];
  if (!row) throw new ValidationError("That set of financial statements isn't there any more.");
  return row;
}

/** The year end a saved set is for, so a link with only the set opens the right year (FS17). */
export async function annualDraftYearEnd(tx: OrgTx, draftId: unknown): Promise<string> {
  return (await findDraft(tx, requireId(draftId, "draftId"))).year_end;
}

/**
 * The set to show for a year end (FS16): the one asked for; otherwise the
 * year's final set; otherwise its most recently changed draft; otherwise
 * Tohyee's default words, not yet saved.
 */
export async function getAnnualDocument(tx: OrgTx, input: { yearEnd: string; name: string; draftId?: unknown }): Promise<AnnualDocument> {
  if (input.draftId !== undefined && input.draftId !== null && input.draftId !== "") {
    const row = await findDraft(tx, requireId(input.draftId, "draftId"));
    if (row.year_end !== input.yearEnd) throw new ValidationError("That set of financial statements is for another year end.");
    return documentOf(row, input.name);
  }
  const row = (
    await tx.query<DraftRow>(`${SELECT} where year_end = $1 order by status = 'final' desc, updated_at desc, id desc limit 1`, [input.yearEnd])
  ).rows[0];
  if (row) return documentOf(row, input.name);
  return { saved: false, id: null, title: defaultSetTitle(input.yearEnd), status: "draft", texts: defaultAnnualTexts(input.name, input.yearEnd), notes: null };
}

/** The saved sets, newest change first (FS17): drafts, finals or both. */
export async function listAnnualDrafts(tx: OrgTx, input: { status?: "draft" | "final" } = {}): Promise<AnnualDraftSummary[]> {
  const rows = (
    await tx.query<DraftRow>(`${SELECT} where ($1::text is null or status = $1) order by updated_at desc, id desc`, [input.status ?? null])
  ).rows;
  return rows.map((row) => ({ id: row.id, yearEnd: row.year_end, title: row.title, status: row.status, updatedAt: row.updated_at, updatedByEmail: row.updated_by_email }));
}

const text = (value: unknown, label: string, max: number) => {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new ValidationError(`${label} must be text.`);
  if (value.length > max) throw new ValidationError(`${label} can be at most ${max} characters.`);
  return value;
};

function parseTexts(input: unknown): AnnualTexts {
  const raw = (input ?? {}) as Record<string, unknown>;
  const sections = requireArray(raw.compilationSections ?? [], "The compilation report's sections", 20).map((entry, index) => {
    const section = (entry ?? {}) as Record<string, unknown>;
    return {
      heading: text(section.heading, `Section ${index + 1}'s heading`, 200),
      body: requireString(section.body, `Section ${index + 1}'s text`, { maxLength: 5000 }),
    };
  });
  const titlesRaw = (raw.titles ?? {}) as Record<string, unknown>;
  const titles: Record<string, string> = {};
  for (const key of PAGE_KEYS) {
    const value = text(titlesRaw[key], `The ${key} heading`, 200).trim();
    if (value) titles[key] = value;
  }
  return {
    coverTitle: text(raw.coverTitle, "The cover title", 200),
    coverSubtitle: text(raw.coverSubtitle, "The cover subtitle", 200),
    coverPeriod: text(raw.coverPeriod, "The cover's period", 200),
    coverNote: text(raw.coverNote, "The cover note", 500),
    compilation: raw.compilation !== false,
    compilationTitle: text(raw.compilationTitle, "The compilation report's title", 300),
    compilationSections: sections,
    compilationSignOff: text(raw.compilationSignOff, "The sign-off", 500),
    titles,
  };
}

/** A title no other set for the year has: "Financial statements 2026", then "... (2)" and so on. */
async function freeTitle(tx: OrgTx, yearEnd: string, wanted: string): Promise<string> {
  const taken = new Set((await tx.query<{ title: string }>("select title from annual_statement_drafts where year_end = $1", [yearEnd])).rows.map((row) => row.title));
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n += 1) {
    const candidate = `${wanted} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Saves a set's words as a draft or as final (FS13, FS16). With `draftId` it
 * changes that set; without it, or with `asNew`, it starts another set for
 * the year (copying the notes of the set it came from). Only one set a year
 * can be final: saving a second as final is refused until the first is
 * saved as a draft.
 */
export async function saveAnnualDocument(
  tx: OrgTx,
  input: { yearEnd: unknown; status: unknown; texts: unknown; name: string; draftId?: unknown; asNew?: unknown; title?: unknown },
): Promise<AnnualDocument> {
  const yearEnd = parseIsoDate(input.yearEnd, "The year end");
  if (input.status !== "draft" && input.status !== "final") throw new ValidationError("Save it as a draft or as final.");
  const status = input.status;
  const texts = parseTexts(input.texts);
  const typedTitle = text(input.title, "The title", 200).trim();
  const fromId = input.draftId !== undefined && input.draftId !== null && input.draftId !== "" ? requireId(input.draftId, "draftId") : null;
  const from = fromId ? await findDraft(tx, fromId) : null;
  if (from && from.year_end !== yearEnd) throw new ValidationError("That set of financial statements is for another year end.");
  const updating = from !== null && input.asNew !== true;
  if (status === "final") {
    const other = (
      await tx.query<{ id: string; title: string }>("select id::text, title from annual_statement_drafts where year_end = $1 and status = 'final' and id <> coalesce($2::bigint, 0)", [
        yearEnd,
        updating ? from!.id : null,
      ])
    ).rows[0];
    if (other) throw new ValidationError(`"${other.title}" is already the final set for this year. Save this one as a draft, or save that one as a draft first.`);
  }
  let id: string;
  if (updating) {
    const title = typedTitle || from!.title;
    if (title !== from!.title) {
      const clash = await tx.query("select 1 from annual_statement_drafts where year_end = $1 and title = $2 and id <> $3", [yearEnd, title, from!.id]);
      if (clash.rows.length > 0) throw new ValidationError(`Another set for this year is already called "${title}".`);
    }
    await tx.query("update annual_statement_drafts set title = $2, status = $3, texts = $4, updated_by_email = $5, updated_at = now() where id = $1", [
      from!.id,
      title,
      status,
      JSON.stringify(texts),
      tx.actor.email,
    ]);
    id = from!.id;
  } else {
    const title = await freeTitle(tx, yearEnd, typedTitle || (from ? `Copy of ${from.title}` : defaultSetTitle(yearEnd)));
    id = (
      await tx.query<{ id: string }>(
        `insert into annual_statement_drafts (year_end, title, status, texts, notes, created_by_email, updated_by_email)
         values ($1, $2, $3, $4, $5, $6, $6) returning id::text`,
        [yearEnd, title, status, JSON.stringify(texts), from?.notes ? JSON.stringify(from.notes) : null, tx.actor.email],
      )
    ).rows[0].id;
  }
  await writeAuditEvent(tx, {
    eventType: "reports.annual_statements_saved",
    entityType: "organisation",
    entityId: tx.organisationId,
    details: { yearEnd, status, draftId: id, created: !updating },
  });
  return documentOf(await findDraft(tx, id), input.name);
}

/** Saves a set's own notes (FS18); an empty list goes back to the organisation's notes. */
export async function saveAnnualDraftNotes(tx: OrgTx, input: { draftId: unknown; notes: unknown }): Promise<{ saved: boolean; notes: AnnualNote[] | null }> {
  const row = await findDraft(tx, requireId(input.draftId, "draftId"));
  const notes = requireArray(input.notes, "notes", 100).map((raw, index): AnnualNote => {
    const note = (raw ?? {}) as Record<string, unknown>;
    return {
      title: requireString(note.title, `Note ${index + 1}'s title`, { maxLength: 150 }),
      body: requireString(note.body, `Note ${index + 1}'s text`, { maxLength: 10000 }),
    };
  });
  await tx.query("update annual_statement_drafts set notes = $2, updated_by_email = $3, updated_at = now() where id = $1", [
    row.id,
    notes.length > 0 ? JSON.stringify(notes) : null,
    tx.actor.email,
  ]);
  await writeAuditEvent(tx, { eventType: "reports.annual_statement_notes_saved", entityType: "organisation", entityId: tx.organisationId, details: { draftId: row.id, count: notes.length } });
  return { saved: notes.length > 0, notes: notes.length > 0 ? notes : null };
}

/** Deletes a draft set (FS17). A final set is saved as a draft first. */
export async function deleteAnnualDraft(tx: OrgTx, draftId: unknown): Promise<void> {
  const row = await findDraft(tx, requireId(draftId, "draftId"));
  if (row.status === "final") throw new ValidationError(`"${row.title}" is final. Save it as a draft first to delete it.`);
  await tx.query("delete from annual_statement_drafts where id = $1", [row.id]);
  await writeAuditEvent(tx, { eventType: "reports.annual_statements_deleted", entityType: "organisation", entityId: tx.organisationId, details: { draftId: row.id, yearEnd: row.year_end, title: row.title } });
}
