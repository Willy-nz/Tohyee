import { boundedLimit, firstRows } from "@/lib/ai/limits";
import { type AiTool, DATE, type JsonSchema, schema } from "@/lib/ai/tools";
import { addNotebookEntry, listNotebook, NOTEBOOK_CATEGORIES, updateNotebookEntry } from "@/lib/ai-workspace/notebook";
import { aiFileText, listAiFiles, READ_CHUNK } from "@/lib/ai-workspace/files";
import { addDatasetRows, AGGREGATES, COLUMN_TYPES, GRAINS, listDatasets, OPERATORS, queryDataset, saveDataset } from "@/lib/ai-workspace/datasets";
import { getAiDashboard, listAiDashboards, saveAiDashboard, TILE_KINDS } from "@/lib/ai-workspace/dashboards";
import { roleAtLeast } from "@/lib/auth/roles";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { farmBenchmarks } from "@/lib/farming/benchmarks";
import { listFarms, listPaddocks } from "@/lib/farming/paddocks";
import { financialYearEnd } from "@/lib/financial-year";
import { headCount, listMovements, MOVEMENT_TYPES, requireLivestock } from "@/lib/livestock/movements";
import { listLivestockSuggestions, suggestLivestockMovements } from "@/lib/livestock/suggestions";
import { listValuations } from "@/lib/livestock/valuation";
import { hasPayrollAccess, PAYROLL_MINIMUM_ROLE } from "@/lib/payroll/access";
import { listEmployees } from "@/lib/payroll/employees";

/*
 * The AI's farm tools (#259 follow-up; examples AIW1-AIW9, decision 533):
 * - the farm notebook (history, goals, people, how it's farmed), which the AI
 *   reads to answer questions and adds to when it learns something;
 * - files people drop in, however they're laid out, which the AI reads and
 *   organises into its own tables, then queries and lays out as dashboards;
 * - livestock (head counts, movements, valuations) and farms and paddocks,
 *   read only; movements the AI finds are suggestions a person accepts;
 * - the staff list, with pay only for someone who may see payroll.
 * The writing tools need a "Make drafts" key: they touch only the AI's own
 * workspace and suggestions, never the books or official livestock records.
 */

const LONG_TEXT = (what: string, max: number): JsonSchema => ({ type: "string", maxLength: max, description: what });

const FILTERS: JsonSchema = {
  type: "array",
  maxItems: 20,
  description: "Only rows matching every filter.",
  items: {
    type: "object",
    properties: {
      field: { type: "string" },
      op: { type: "string", enum: [...OPERATORS] },
      value: { description: "Compared as the column's type; null to test for empty. contains is a case-insensitive text match." },
    },
    required: ["field", "op"],
  },
};
const GROUP_BY: JsonSchema = {
  type: "array",
  maxItems: 3,
  description: "Columns to total by: a name, or { field, grain } for a date column by day, month or year.",
  items: { oneOf: [{ type: "string" }, { type: "object", properties: { field: { type: "string" }, grain: { type: "string", enum: [...GRAINS] } }, required: ["field"] }] },
};
const MEASURES: JsonSchema = {
  type: "array",
  maxItems: 10,
  description: "What to work out per group. Leave out to get the rows themselves.",
  items: {
    type: "object",
    properties: {
      aggregate: { type: "string", enum: [...AGGREGATES] },
      field: { type: "string", description: "Not needed for count." },
      label: { type: "string" },
    },
    required: ["aggregate"],
  },
};
const SORT: JsonSchema = {
  type: "object",
  properties: { by: { type: "string", description: "A groupBy column or measure label." }, direction: { type: "string", enum: ["asc", "desc"] } },
};
const MOVEMENT: JsonSchema = {
  type: "object",
  description: "As for a livestock movement: movementType, movementDate, kind, classCode, head, and where needed toClassCode, amount (excl. GST), heldFor, rationsFor, note.",
  properties: {
    movementType: { type: "string", enum: [...MOVEMENT_TYPES] },
    movementDate: DATE,
    kind: { type: "string", description: "e.g. dairy_cattle, beef_cattle, sheep, deer_red, deer_other, goats_angora, goats_cashmere, goats_dairy." },
    classCode: { type: "string", description: "The class, e.g. ma_cows, r1_heifers. livestock_overview shows the classes in use." },
    toClassCode: { type: "string" },
    head: { type: "integer", minimum: 1 },
    amount: { type: "string" },
    heldFor: { type: "string" },
    rationsFor: { type: "string", enum: ["owner", "staff"] },
    note: { type: "string" },
  },
  required: ["movementType", "movementDate", "kind", "classCode", "head"],
};

async function currentLivestockYearEnd(tx: OrgTx): Promise<string> {
  const settings = await requireLivestock(tx);
  return financialYearEnd(todayIsoDate(), settings.financialYearEndMonth);
}

/** The staff list for this person (AIW9): pay only with payroll access, never IRD or bank numbers or dates of birth. */
async function staffList(tx: OrgTx, role: Parameters<typeof roleAtLeast>[0], includeFormer: boolean) {
  if (roleAtLeast(role, PAYROLL_MINIMUM_ROLE) && (await hasPayrollAccess(tx))) {
    const employees = await listEmployees(tx, { includeArchived: includeFormer });
    return {
      includesPay: true,
      staff: employees.map((employee) => ({
        name: `${employee.firstName} ${employee.lastName}`,
        jobTitle: employee.jobTitle,
        email: employee.email,
        phone: employee.phone,
        startDate: employee.startDate,
        finishDate: employee.finishDate,
        reportsTo: employee.reportsToName,
        group: employee.employeeGroupName,
        department: employee.primaryDepartment?.name ?? null,
        payFrequency: employee.payFrequency,
        payBasis: employee.payBasis,
        annualSalary: employee.annualSalary,
        hourlyRate: employee.hourlyRate,
        ordinaryHoursPerWeek: employee.ordinaryHoursPerWeek,
        archived: employee.isArchived,
      })),
    };
  }
  const rows = await tx.query<{ name: string; job_title: string | null; start_date: string; finish_date: string | null; reports_to: string | null; group_name: string | null; is_archived: boolean }>(
    `select e.first_name || ' ' || e.last_name as name, e.job_title, e.start_date::text, e.finish_date::text, m.first_name || ' ' || m.last_name as reports_to,
            eg.name as group_name, e.is_archived
       from payroll_employees e
       left join payroll_employees m on m.id = e.reports_to_id
       left join payroll_employee_groups eg on eg.id = e.employee_group_id
      where ($1::boolean or not e.is_archived)
      order by lower(e.last_name), lower(e.first_name)`,
    [includeFormer],
  );
  return {
    includesPay: false,
    payNote: "Pay details are left out: the person using this AI doesn't have payroll access in Tohyee.",
    staff: rows.rows.map((row) => ({ name: row.name, jobTitle: row.job_title, startDate: row.start_date, finishDate: row.finish_date, reportsTo: row.reports_to, group: row.group_name, archived: row.is_archived })),
  };
}

export const FARM_READ_TOOLS: AiTool[] = [
  {
    name: "farm_notebook",
    title: "Read the farm notebook",
    description:
      "The farm's own notes: its history, goals, people, how it's farmed, places and paddocks. Read this before answering questions about the farm, and to understand files. Newest first; filter by category or words.",
    level: "read",
    inputSchema: schema({
      category: { type: "string", enum: [...NOTEBOOK_CATEGORIES] },
      search: { type: "string", description: "Words to look for in titles and text." },
      limit: { type: "integer", minimum: 1, maximum: 500 },
    }),
    run: async (tx, args) => ({ notes: await listNotebook(tx, { category: args.category, search: args.search, limit: boundedLimit(args.limit, 200, 500) }) }),
  },
  {
    name: "list_ai_uploads",
    title: "List files left for the AI",
    description: "Files people have dropped in for you to read and organise (spreadsheets, exports, notes), however they're laid out.",
    level: "read",
    inputSchema: schema(),
    run: async (tx) => ({ files: await listAiFiles(tx) }),
  },
  {
    name: "read_ai_upload",
    title: "Read a file left for the AI",
    description: `A file's content as text; Excel workbooks come as "## Sheet: name" then CSV. Long files come in parts of ${READ_CHUNK.toLocaleString("en-NZ")} characters: pass offset to read on.`,
    level: "read",
    inputSchema: schema({ fileId: { type: "string" }, offset: { type: "integer", minimum: 0 } }, ["fileId"]),
    run: async (tx, args) => {
      const { file, text } = await aiFileText(tx, args.fileId);
      const offset = Math.max(Number(args.offset ?? 0) || 0, 0);
      const part = text.slice(offset, offset + READ_CHUNK);
      const next = offset + part.length;
      return { file, offset, length: text.length, text: part, nextOffset: next < text.length ? next : null };
    },
  },
  {
    name: "list_datasets",
    title: "List your tables",
    description: "The tables you've made in your workspace, with their columns and row counts.",
    level: "read",
    inputSchema: schema(),
    run: async (tx) => ({ datasets: await listDatasets(tx) }),
  },
  {
    name: "query_dataset",
    title: "Query one of your tables",
    description: "Rows of one of your tables, or with measures, totals grouped by up to three columns. Numbers come back as exact text.",
    level: "read",
    inputSchema: schema({ name: { type: "string" }, groupBy: GROUP_BY, measures: MEASURES, filters: FILTERS, sort: SORT, limit: { type: "integer", minimum: 1, maximum: 1000 } }, ["name"]),
    run: (tx, args) => queryDataset(tx, { ...args, name: args.name }),
  },
  {
    name: "list_ai_dashboards",
    title: "List dashboards",
    description: "Dashboards over your tables.",
    level: "read",
    inputSchema: schema(),
    run: async (tx) => ({ dashboards: await listAiDashboards(tx) }),
  },
  {
    name: "get_ai_dashboard",
    title: "Get a dashboard with its figures",
    description: "A dashboard's tiles and each tile's figures.",
    level: "read",
    inputSchema: schema({ dashboardId: { type: "string" } }, ["dashboardId"]),
    run: (tx, args) => getAiDashboard(tx, args.dashboardId),
  },
  {
    name: "livestock_overview",
    title: "Livestock head count",
    description:
      "Livestock settings and the head count reconciliation for a year (opening, born, bought, sold, died, rations, missing, class changes, ageing, closing, counted), by class. Defaults to the current year. Includes the year-end valuations done so far.",
    level: "read",
    inputSchema: schema({ yearEnd: DATE }),
    run: async (tx, args) => {
      const yearEnd = typeof args.yearEnd === "string" ? args.yearEnd : await currentLivestockYearEnd(tx);
      return { headCount: await headCount(tx, { yearEnd }), valuations: await listValuations(tx) };
    },
  },
  {
    name: "list_livestock_movements",
    title: "List livestock movements",
    description: "Recorded livestock movements between two dates, newest first.",
    level: "read",
    inputSchema: schema({ from: DATE, to: DATE, includeVoided: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 2000 } }),
    run: async (tx, args) => {
      await requireLivestock(tx);
      return firstRows(await listMovements(tx, { from: args.from, to: args.to, includeVoided: args.includeVoided === true }), boundedLimit(args.limit, 500, 2000));
    },
  },
  {
    name: "list_livestock_suggestions",
    title: "List suggested livestock movements",
    description: "Movements you (or another AI) suggested, and whether a person accepted or declined them.",
    level: "read",
    inputSchema: schema({ open: { type: "boolean", description: "Only those waiting for a decision." } }),
    run: async (tx, args) => ({ suggestions: await listLivestockSuggestions(tx, { open: args.open === true }) }),
  },
  {
    name: "list_farms_and_paddocks",
    title: "List farms and paddocks",
    description: "Each farm with its current paddocks and effective areas.",
    level: "read",
    inputSchema: schema(),
    run: async (tx) => {
      const farms = await listFarms(tx);
      const result = [];
      for (const farm of farms) result.push({ ...farm, paddocks: (await listPaddocks(tx, { farmId: farm.id })).map((paddock) => ({ id: paddock.id, name: paddock.name, effectiveHa: paddock.effectiveHa })) });
      return { farms: result };
    },
  },
  {
    name: "farm_benchmarks",
    title: "Farm benchmarks",
    description: "A financial year's gross farm revenue, working expenses by group and operating surplus, per kgMS, ha, cow and stock unit.",
    level: "read",
    inputSchema: schema({ yearEnd: DATE }),
    run: (tx, args) => farmBenchmarks(tx, { yearEnd: args.yearEnd }),
  },
  {
    name: "list_staff",
    title: "List staff",
    description:
      "The people employed: names, job titles, start and finish dates, who they report to. Pay details are included only when the person using you has payroll access in Tohyee; IRD numbers, bank accounts and dates of birth never are. For more about people, read the notebook's people category.",
    level: "read",
    inputSchema: schema({ includeFormer: { type: "boolean" } }),
    run: (tx, args, context) => staffList(tx, context.role, args.includeFormer === true),
  },
];

export const FARM_WRITE_TOOLS: AiTool[] = [
  {
    name: "add_farm_note",
    title: "Add a note to the farm notebook",
    description: "Write down something worth keeping about the farm (history, goals, people, how it's farmed). People see it marked as written by the AI. Don't repeat a note that's already there: update it.",
    level: "draft",
    inputSchema: schema(
      { category: { type: "string", enum: [...NOTEBOOK_CATEGORIES] }, title: LONG_TEXT("A short title.", 200), body: LONG_TEXT("The note.", 20000), happenedOn: DATE },
      ["category", "title", "body"],
    ),
    run: (tx, args) => addNotebookEntry(tx, { category: args.category, title: args.title, body: args.body, happenedOn: args.happenedOn }, "ai"),
  },
  {
    name: "update_farm_note",
    title: "Update a farm note",
    description: "Replace a note's category, title, text and date.",
    level: "draft",
    inputSchema: schema(
      { noteId: { type: "string" }, category: { type: "string", enum: [...NOTEBOOK_CATEGORIES] }, title: LONG_TEXT("A short title.", 200), body: LONG_TEXT("The note.", 20000), happenedOn: DATE },
      ["noteId", "category", "title", "body"],
    ),
    run: (tx, args) => updateNotebookEntry(tx, args.noteId, { category: args.category, title: args.title, body: args.body, happenedOn: args.happenedOn }),
  },
  {
    name: "save_dataset",
    title: "Make or change one of your tables",
    description:
      "Make a table in your workspace, laid out however suits the data (e.g. calving, herd tests, milk production, sales by animal). Columns are text, number, date or boolean. Saving an existing name changes its description and columns; its rows must still fit.",
    level: "draft",
    inputSchema: schema(
      {
        name: { type: "string", pattern: "^[a-z][a-z0-9_]{0,62}$" },
        description: LONG_TEXT("What the table holds and where it came from.", 2000),
        columns: {
          type: "array",
          minItems: 1,
          maxItems: 60,
          items: { type: "object", properties: { name: { type: "string", pattern: "^[a-z][a-z0-9_]{0,62}$" }, type: { type: "string", enum: [...COLUMN_TYPES] }, description: { type: "string" } }, required: ["name", "type"] },
        },
        sourceNote: LONG_TEXT("Which files or notes it was built from.", 2000),
      },
      ["name", "description", "columns"],
    ),
    run: (tx, args) => saveDataset(tx, args as { name: unknown; description: unknown; columns: unknown; sourceNote?: unknown }),
  },
  {
    name: "add_dataset_rows",
    title: "Add rows to one of your tables",
    description: "Add up to 2,000 rows (objects of column -> value; numbers as text or numbers, dates as YYYY-MM-DD). replace: true clears the table's rows first, to rebuild it.",
    level: "draft",
    inputSchema: schema({ name: { type: "string" }, rows: { type: "array", maxItems: 2000, items: { type: "object" } }, replace: { type: "boolean" } }, ["name", "rows"]),
    run: (tx, args) => addDatasetRows(tx, { name: args.name, rows: args.rows, replace: args.replace }),
  },
  {
    name: "save_ai_dashboard",
    title: "Make or change a dashboard",
    description:
      "Lay out a dashboard of up to 12 tiles over your tables. Each tile: title, kind (column, bar, line, area, pie, donut, kpi, table), dataset, groupBy, measures, filters, sort, limit, width (1 half, 2 full), note. Charts need groupBy and a measure; a kpi needs a measure. Pass dashboardId to replace one. Every tile is checked by running it.",
    level: "draft",
    inputSchema: schema(
      {
        dashboardId: { type: "string" },
        name: { type: "string", maxLength: 120 },
        description: { type: "string", maxLength: 2000 },
        tiles: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              kind: { type: "string", enum: [...TILE_KINDS] },
              dataset: { type: "string" },
              groupBy: GROUP_BY,
              measures: MEASURES,
              filters: FILTERS,
              sort: SORT,
              limit: { type: "integer", minimum: 1, maximum: 500 },
              width: { type: "integer", enum: [1, 2] },
              note: { type: "string", maxLength: 500 },
            },
            required: ["title", "kind", "dataset"],
          },
        },
      },
      ["name", "tiles"],
    ),
    run: (tx, args) => saveAiDashboard(tx, { id: args.dashboardId, name: args.name, description: args.description, tiles: args.tiles }),
  },
  {
    name: "suggest_livestock_movements",
    title: "Suggest livestock movements",
    description:
      "Suggest up to 200 livestock movements you found (births, purchases, sales, deaths, rations, class changes...), each with the evidence: which file and rows, or what you were told. A person accepts or declines each one; accepting records it with every check. Check list_livestock_movements and list_livestock_suggestions first so you don't suggest one twice.",
    level: "draft",
    inputSchema: schema(
      {
        suggestions: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: { type: "object", properties: { movement: MOVEMENT, evidence: { type: "string", maxLength: 2000 } }, required: ["movement", "evidence"] },
        },
      },
      ["suggestions"],
    ),
    run: async (tx, args) => ({ suggestions: await suggestLivestockMovements(tx, { suggestions: args.suggestions }) }),
  },
];
