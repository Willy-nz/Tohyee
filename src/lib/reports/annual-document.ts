import type { OrgTx } from "@/lib/db/org-transaction";
import { writeAuditEvent } from "@/lib/audit";
import { ValidationError } from "@/lib/errors";
import { parseIsoDate } from "@/lib/dates";
import { requireArray, requireString } from "@/lib/validation";

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

export type AnnualDocument = { saved: boolean; status: "draft" | "final"; texts: AnnualTexts };

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

export async function getAnnualDocument(tx: OrgTx, input: { yearEnd: string; name: string }): Promise<AnnualDocument> {
  const defaults = defaultAnnualTexts(input.name, input.yearEnd);
  const row = await tx.query<{ status: "draft" | "final"; texts: Partial<AnnualTexts> }>("select status, texts from annual_statement_documents where year_end = $1", [input.yearEnd]);
  if (row.rows.length === 0) return { saved: false, status: "draft", texts: defaults };
  return { saved: true, status: row.rows[0].status, texts: { ...defaults, ...row.rows[0].texts, titles: { ...(row.rows[0].texts.titles ?? {}) } } };
}

const text = (value: unknown, label: string, max: number) => {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new ValidationError(`${label} must be text.`);
  if (value.length > max) throw new ValidationError(`${label} can be at most ${max} characters.`);
  return value;
};

/** Saves the year's words as a draft or as final (FS13), replacing what was saved before. */
export async function saveAnnualDocument(tx: OrgTx, input: { yearEnd: unknown; status: unknown; texts: unknown; name: string }): Promise<AnnualDocument> {
  const yearEnd = parseIsoDate(input.yearEnd, "The year end");
  if (input.status !== "draft" && input.status !== "final") throw new ValidationError("Save it as a draft or as final.");
  const raw = (input.texts ?? {}) as Record<string, unknown>;
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
  const texts: AnnualTexts = {
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
  await tx.query(
    `insert into annual_statement_documents (year_end, status, texts, updated_by_email) values ($1, $2, $3, $4)
     on conflict (year_end) do update set status = excluded.status, texts = excluded.texts, updated_by_email = excluded.updated_by_email, updated_at = now()`,
    [yearEnd, input.status, JSON.stringify(texts), tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "reports.annual_statements_saved", entityType: "organisation", entityId: tx.organisationId, details: { yearEnd, status: input.status } });
  return getAnnualDocument(tx, { yearEnd, name: input.name });
}
