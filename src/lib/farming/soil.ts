import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  checkXlsxArchive,
  defaultSheet,
  writeXlsxSheetCsv,
  XLSX_LOAD_LIMITS,
  xlsxStructure,
} from "@/lib/analytics/xlsx";
import { writeAuditEvent } from "@/lib/audit";
import { parseBankDate } from "@/lib/bank/formats/common";
import { parseDelimited } from "@/lib/bank/formats/table";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { dec, toFixedString } from "@/lib/money/decimal";
import {
  optionalString,
  requireArray,
  requireId,
  requireString,
} from "@/lib/validation";

/*
 * Soil tests (#249 stage 2). A test is one sample on a paddock on a date,
 * with its results as the lab reported them: the text is kept beside the
 * number (so "<0.5" isn't lost) and units are the lab's, never converted.
 * Nothing here judges whether a level is low or a test is too old: no
 * agronomic advice. The lab's report is attached to the test as a file.
 */

/** Common NZ soil test measures, for recognising column headings and ordering results. Units come from the file. */
export const SOIL_MEASURES: ReadonlyArray<{ name: string; aliases: string[] }> =
  [
    { name: "pH", aliases: ["ph", "soil ph", "ph water", "ph h2o"] },
    {
      name: "Olsen P",
      aliases: [
        "olsen p",
        "olsen phosphorus",
        "olsen-p",
        "p olsen",
        "phosphorus olsen",
      ],
    },
    {
      name: "Potassium",
      aliases: [
        "k",
        "potassium",
        "exchangeable potassium",
        "potassium k",
        "qtu k",
        "k qtu",
      ],
    },
    {
      name: "Calcium",
      aliases: [
        "ca",
        "calcium",
        "exchangeable calcium",
        "calcium ca",
        "qtu ca",
        "ca qtu",
      ],
    },
    {
      name: "Magnesium",
      aliases: [
        "mg",
        "magnesium",
        "exchangeable magnesium",
        "magnesium mg",
        "qtu mg",
        "mg qtu",
      ],
    },
    {
      name: "Sodium",
      aliases: [
        "na",
        "sodium",
        "exchangeable sodium",
        "sodium na",
        "qtu na",
        "na qtu",
      ],
    },
    {
      name: "Sulphate sulphur",
      aliases: [
        "sulphate s",
        "sulphate sulphur",
        "sulfate sulfur",
        "so4 s",
        "so4-s",
        "sulphate-s",
      ],
    },
    {
      name: "Organic sulphur",
      aliases: [
        "organic s",
        "organic sulphur",
        "extractable organic sulphur",
        "eos",
      ],
    },
    {
      name: "Anion storage capacity",
      aliases: [
        "asc",
        "anion storage capacity",
        "p retention",
        "phosphate retention",
      ],
    },
    { name: "CEC", aliases: ["cec", "cation exchange capacity"] },
    {
      name: "Base saturation",
      aliases: ["base saturation", "total base saturation"],
    },
    { name: "Organic matter", aliases: ["organic matter", "om"] },
    {
      name: "Total carbon",
      aliases: ["total carbon", "total c", "organic carbon"],
    },
    { name: "Total nitrogen", aliases: ["total nitrogen", "total n"] },
    { name: "Volume weight", aliases: ["volume weight", "bulk density"] },
  ];

type Role =
  | "paddock"
  | "date"
  | "sample"
  | "labReference"
  | "depth"
  | "measure"
  | "ignore";
const ROLES: Role[] = [
  "paddock",
  "date",
  "sample",
  "labReference",
  "depth",
  "measure",
  "ignore",
];

const ROLE_ALIASES: Record<Exclude<Role, "measure" | "ignore">, string[]> = {
  paddock: [
    "paddock",
    "paddock name",
    "paddock id",
    "block",
    "paddock no",
    "paddock number",
  ],
  date: [
    "date",
    "date sampled",
    "sampled",
    "sample date",
    "sampling date",
    "sampled on",
    "date received",
  ],
  sample: [
    "sample",
    "sample name",
    "sample id",
    "client sample id",
    "client sample name",
    "sample no",
    "sample number",
    "client reference",
  ],
  labReference: [
    "lab number",
    "lab no",
    "lab reference",
    "lab ref",
    "lab id",
    "laboratory number",
    "lab sample number",
    "report number",
  ],
  depth: ["depth", "sample depth", "sampling depth", "depth mm", "depth cm"],
};

const MAX_FILE_CHARS = 5 * 1024 * 1024;
const MAX_ROWS = 2000;
const MAX_RESULTS = 60;

function norm(text: string): string {
  return text.toLowerCase().replace(/[_.:]/g, " ").replace(/\s+/g, " ").trim();
}

/** A heading split into its name and the unit in brackets after it: "Olsen P (mg/L)" → ["Olsen P", "mg/L"]. */
export function splitHeading(heading: string): {
  name: string;
  unit: string | null;
} {
  const match = /^(.*?)\s*[([]\s*([^()[\]]{1,40})\s*[)\]]\s*$/.exec(
    heading.trim(),
  );
  return match && match[1]
    ? { name: match[1].trim(), unit: match[2].trim() }
    : { name: heading.trim(), unit: null };
}

/** The common measure a heading names, or null. */
export function knownMeasure(name: string): string | null {
  const key = norm(name);
  return (
    SOIL_MEASURES.find(
      (measure) => norm(measure.name) === key || measure.aliases.includes(key),
    )?.name ?? null
  );
}

/** A result as reported: the text, and the number when it is one ("<0.5" has none). */
export function readResult(
  text: string,
): { value: string | null; valueText: string } | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed === "-" || /^n\/?a$/i.test(trimmed)) return null;
  if (trimmed.length > 50)
    throw new ValidationError(
      `"${trimmed.slice(0, 20)}…" is too long for a result.`,
    );
  // Numbers with up to 4 decimal places are kept as numbers too (the analytics column is DECIMAL(18,4)); anything else stays text only.
  return {
    value: /^-?\d{1,14}(\.\d{1,4})?$/.test(trimmed) ? trimmed : null,
    valueText: trimmed,
  };
}

async function requireFarming(tx: OrgTx): Promise<void> {
  const row = await tx.query<{ enabled: boolean }>(
    "select enabled from farming_settings where id = true",
  );
  if (row.rows[0]?.enabled !== true)
    throw new ValidationError(
      "Farming is off. An admin can turn it on under Settings, Modules.",
    );
}

async function requireFarm(tx: OrgTx, farmIdInput: unknown): Promise<string> {
  await requireFarming(tx);
  const farmId = requireId(farmIdInput, "farmId");
  const farm = await tx.query("select 1 from farms where id = $1", [farmId]);
  if (!farm.rowCount) throw new NotFoundError("Farm not found.");
  return farmId;
}

// Reading ------------------------------------------------------------------------------------------

export type SoilResult = {
  measure: string;
  value: string | null;
  valueText: string;
  unit: string | null;
};

export type SoilTest = {
  id: string;
  farmId: string;
  paddockId: string;
  paddockName: string;
  sampledOn: string;
  sampleName: string | null;
  lab: string | null;
  labReference: string | null;
  depth: string | null;
  source: string;
  createdByEmail: string;
  results: SoilResult[];
};

const ORDER = new Map(
  SOIL_MEASURES.map((measure, index) => [measure.name, index]),
);

async function loadTests(
  tx: OrgTx,
  where: string,
  params: unknown[],
): Promise<SoilTest[]> {
  const tests = await tx.query<{
    id: string;
    farm_id: string;
    paddock_id: string;
    paddock_name: string;
    sampled_on: string;
    sample_name: string | null;
    lab: string | null;
    lab_reference: string | null;
    depth: string | null;
    source: string;
    created_by_email: string;
  }>(
    `select t.id::text, t.farm_id::text, t.paddock_id::text, p.name as paddock_name, t.sampled_on::text, t.sample_name, t.lab, t.lab_reference, t.depth, t.source, t.created_by_email
       from soil_tests t join paddocks p on p.id = t.paddock_id
      where t.status = 'active' and ${where}
      order by t.sampled_on desc, t.id desc`,
    params,
  );
  if (tests.rows.length === 0) return [];
  const results = await tx.query<{
    soil_test_id: string;
    measure: string;
    value: string | null;
    value_text: string;
    unit: string | null;
  }>(
    "select soil_test_id::text, measure, value::text, value_text, unit from soil_test_results where soil_test_id = any($1::bigint[]) order by soil_test_id, line_order, soil_test_results.id",
    [tests.rows.map((row) => row.id)],
  );
  const byTest = new Map<string, SoilResult[]>();
  for (const row of results.rows) {
    byTest.set(row.soil_test_id, [
      ...(byTest.get(row.soil_test_id) ?? []),
      {
        measure: row.measure,
        value: row.value,
        valueText: row.value_text,
        unit: row.unit,
      },
    ]);
  }
  return tests.rows.map((row) => ({
    id: row.id,
    farmId: row.farm_id,
    paddockId: row.paddock_id,
    paddockName: row.paddock_name,
    sampledOn: row.sampled_on,
    sampleName: row.sample_name,
    lab: row.lab,
    labReference: row.lab_reference,
    depth: row.depth,
    source: row.source,
    createdByEmail: row.created_by_email,
    results: byTest.get(row.id) ?? [],
  }));
}

export async function listSoilTests(
  tx: OrgTx,
  input: { farmId: unknown; paddockId?: unknown },
): Promise<SoilTest[]> {
  const farmId = await requireFarm(tx, input.farmId);
  if (input.paddockId)
    return loadTests(tx, "t.farm_id = $1 and t.paddock_id = $2", [
      farmId,
      requireId(input.paddockId, "paddockId"),
    ]);
  return loadTests(tx, "t.farm_id = $1", [farmId]);
}

export type SoilSummaryRow = {
  paddockId: string;
  paddockName: string;
  effectiveHa: string | null;
  lastSampledOn: string | null;
  tests: number;
  latest: Record<string, SoilResult>;
};
export type SoilSummary = { measures: string[]; paddocks: SoilSummaryRow[] };

/**
 * Each current paddock with its latest test and that test's results, so
 * paddocks never tested, or tested long ago, stand out. No thresholds:
 * whether a level or an age matters is the farmer's and adviser's call.
 */
export async function soilSummary(
  tx: OrgTx,
  input: { farmId: unknown },
): Promise<SoilSummary> {
  const farmId = await requireFarm(tx, input.farmId);
  const paddocks = await tx.query<{
    id: string;
    name: string;
    effective_ha: string | null;
  }>(
    "select id::text, name, effective_ha::text from paddocks where farm_id = $1 and status = 'active'",
    [farmId],
  );
  const tests = await loadTests(tx, "t.farm_id = $1", [farmId]);
  const seen = new Set<string>();
  const rows: SoilSummaryRow[] = paddocks.rows.map((paddock) => {
    const mine = tests.filter((test) => test.paddockId === paddock.id);
    const latest = mine[0];
    const results: Record<string, SoilResult> = {};
    for (const result of latest?.results ?? []) {
      results[result.measure] = result;
      seen.add(result.measure);
    }
    return {
      paddockId: paddock.id,
      paddockName: paddock.name,
      effectiveHa: paddock.effective_ha,
      lastSampledOn: latest?.sampledOn ?? null,
      tests: mine.length,
      latest: results,
    };
  });
  rows.sort((a, b) =>
    a.paddockName.localeCompare(b.paddockName, "en-NZ", { numeric: true }),
  );
  const measures = [...seen].sort(
    (a, b) =>
      (ORDER.get(a) ?? 999) - (ORDER.get(b) ?? 999) || a.localeCompare(b),
  );
  return { measures, paddocks: rows };
}

// Entering and removing --------------------------------------------------------------------------

type NewTest = {
  paddockId: string;
  sampledOn: string;
  sampleName: string | null;
  lab: string | null;
  labReference: string | null;
  depth: string | null;
  source: string;
  results: SoilResult[];
};

async function insertTest(
  tx: OrgTx,
  farmId: string,
  test: NewTest,
): Promise<string> {
  const row = await tx.query<{ id: string }>(
    `insert into soil_tests (farm_id, paddock_id, sampled_on, sample_name, lab, lab_reference, depth, source, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id::text`,
    [
      farmId,
      test.paddockId,
      test.sampledOn,
      test.sampleName,
      test.lab,
      test.labReference,
      test.depth,
      test.source,
      tx.actor.email,
    ],
  );
  for (const [index, result] of test.results.entries()) {
    await tx.query(
      "insert into soil_test_results (soil_test_id, line_order, measure, value, value_text, unit) values ($1, $2, $3, $4, $5, $6)",
      [
        row.rows[0].id,
        index + 1,
        result.measure,
        result.value,
        result.valueText,
        result.unit,
      ],
    );
  }
  return row.rows[0].id;
}

function checkResults(results: SoilResult[], label = ""): void {
  if (results.length === 0)
    throw new ValidationError(`${label}A soil test needs at least one result.`);
  if (results.length > MAX_RESULTS)
    throw new ValidationError(
      `${label}A soil test can have at most ${MAX_RESULTS} results.`,
    );
  const names = new Set<string>();
  for (const result of results) {
    const key = result.measure.toLowerCase();
    if (names.has(key))
      throw new ValidationError(`${label}${result.measure} appears twice.`);
    names.add(key);
  }
}

/** Enters one test by hand: the paddock, date, lab details and results (measure, result as reported, unit). */
export async function addSoilTest(
  tx: OrgTx,
  input: {
    paddockId: unknown;
    sampledOn: unknown;
    sampleName?: unknown;
    lab?: unknown;
    labReference?: unknown;
    depth?: unknown;
    results: unknown;
  },
): Promise<SoilTest> {
  await requireFarming(tx);
  const paddockId = requireId(input.paddockId, "paddockId");
  const paddock = (
    await tx.query<{ farm_id: string; name: string; status: string }>(
      "select farm_id::text, name, status from paddocks where id = $1",
      [paddockId],
    )
  ).rows[0];
  if (!paddock) throw new NotFoundError("Paddock not found.");
  if (paddock.status !== "active")
    throw new ValidationError(`${paddock.name} is retired.`);
  const results: SoilResult[] = [];
  for (const [index, entry] of requireArray(
    input.results,
    "results",
    MAX_RESULTS,
  ).entries()) {
    const raw = (entry ?? {}) as Record<string, unknown>;
    const name = requireString(raw.measure, `Result ${index + 1} measure`, {
      maxLength: 100,
    });
    const read = readResult(
      typeof raw.value === "string"
        ? raw.value
        : raw.value === undefined || raw.value === null
          ? ""
          : String(raw.value),
    );
    if (!read) throw new ValidationError(`Enter a result for ${name}.`);
    results.push({
      measure: knownMeasure(name) ?? name,
      ...read,
      unit: optionalString(raw.unit, `${name} unit`, { maxLength: 40 }),
    });
  }
  checkResults(results);
  const id = await insertTest(tx, paddock.farm_id, {
    paddockId,
    sampledOn: parseIsoDate(input.sampledOn, "Sampled on"),
    sampleName: optionalString(input.sampleName, "Sample name", {
      maxLength: 100,
    }),
    lab: optionalString(input.lab, "Lab", { maxLength: 100 }),
    labReference: optionalString(input.labReference, "Lab reference", {
      maxLength: 100,
    }),
    depth: optionalString(input.depth, "Depth", { maxLength: 40 }),
    source: "Entered in Tohyee",
    results,
  });
  await writeAuditEvent(tx, {
    eventType: "farming.soil_test_added",
    entityType: "soil_test",
    entityId: id,
    details: { paddockId },
  });
  return (await loadTests(tx, "t.id = $1", [id]))[0];
}

/** Removes a test entered or imported by mistake. Its row and results are kept for the history. */
export async function removeSoilTest(
  tx: OrgTx,
  idInput: unknown,
): Promise<void> {
  await requireFarming(tx);
  const id = requireId(idInput, "soilTestId");
  const row = await tx.query(
    "update soil_tests set status = 'removed' where id = $1 and status = 'active'",
    [id],
  );
  if (!row.rowCount) throw new NotFoundError("That soil test wasn't found.");
  await writeAuditEvent(tx, {
    eventType: "farming.soil_test_removed",
    entityType: "soil_test",
    entityId: id,
    details: {},
  });
}

// Importing ----------------------------------------------------------------------------------------

/** Where an import came from: filed by an Owner from their private mail (decision 721), or not. */
export type ImportOrigin = { filedFromPrivateMail?: boolean };

/** The source others see on each imported row; a filed file says so, and nothing of the email. */
export function importSource(fileName: string, origin: ImportOrigin = {}): string {
  const suffix = origin.filedFromPrivateMail ? ", filed from a private email" : "";
  return `Imported from ${fileName.slice(0, 200 - 14 - suffix.length)}${suffix}`;
}

export type SoilImportColumn = {
  index: number;
  heading: string;
  role: Role;
  measure: string | null;
  unit: string | null;
};
export type SoilImportRow = {
  line: number;
  paddock: string | null;
  sampledOn: string | null;
  sampleName: string | null;
  results: number;
  error: string | null;
};
export type SoilImportPreview = {
  fileName: string;
  sha256: string;
  alreadyImportedOn: string | null;
  columns: SoilImportColumn[];
  rows: SoilImportRow[];
  counts: { tests: number; errors: number };
};

type ImportInput = {
  fileName: unknown;
  content?: unknown;
  contentBase64?: unknown;
  columns?: unknown;
  sampledOn?: unknown;
  lab?: unknown;
};

/** The file's rows: CSV text, or the first visible sheet of an Excel workbook (base64). */
export async function fileRows(
  fileName: string,
  input: ImportInput,
): Promise<{ rows: string[][]; sha256: string }> {
  if (typeof input.contentBase64 === "string" && input.contentBase64) {
    if (!/\.xlsx$/i.test(fileName))
      throw new ValidationError(
        "Only .xlsx workbooks can be read. Save older .xls files as .xlsx or CSV first.",
      );
    const bytes = Buffer.from(input.contentBase64, "base64");
    if (bytes.length === 0 || bytes.length > MAX_FILE_CHARS)
      throw new ValidationError("The workbook is empty or larger than 5 MB.");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tohyee-soil-"));
    try {
      const source = path.join(dir, "upload.xlsx");
      const csv = path.join(dir, "sheet.csv");
      await fs.writeFile(source, bytes, { mode: 0o600 });
      const checked = await checkXlsxArchive(source, XLSX_LOAD_LIMITS);
      const structure = await xlsxStructure(checked);
      await writeXlsxSheetCsv(
        source,
        checked,
        structure,
        defaultSheet(structure),
        csv,
        { maxBytes: MAX_FILE_CHARS, maxRows: MAX_ROWS + 1 },
      );
      return {
        rows: parseDelimited(await fs.readFile(csv, "utf8")),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
  if (typeof input.content !== "string" || !input.content.trim())
    throw new ValidationError("Choose a CSV or Excel file.");
  if (input.content.length > MAX_FILE_CHARS)
    throw new ValidationError("The file is larger than 5 MB.");
  return {
    rows: parseDelimited(input.content),
    sha256: createHash("sha256").update(input.content).digest("hex"),
  };
}

function guessColumns(headings: string[]): SoilImportColumn[] {
  const columns = headings.map((heading, index): SoilImportColumn => {
    const { name, unit } = splitHeading(heading);
    const key = norm(name);
    for (const role of Object.keys(ROLE_ALIASES) as Array<
      keyof typeof ROLE_ALIASES
    >) {
      if (
        ROLE_ALIASES[role].includes(key) ||
        ROLE_ALIASES[role].includes(norm(heading))
      )
        return { index, heading, role, measure: null, unit: null };
    }
    if (!heading.trim())
      return { index, heading, role: "ignore", measure: null, unit: null };
    return {
      index,
      heading,
      role: "measure",
      measure: knownMeasure(name) ?? name,
      unit,
    };
  });
  // One column per role: a second match is a result, not another paddock column.
  const taken = new Set<Role>();
  for (const column of columns) {
    if (column.role === "measure" || column.role === "ignore") continue;
    if (taken.has(column.role)) column.role = "ignore";
    taken.add(column.role);
  }
  return columns;
}

function chosenColumns(
  input: unknown,
  headings: string[],
): SoilImportColumn[] | null {
  if (input === undefined || input === null) return null;
  const raw = requireArray(input, "columns", 500);
  if (raw.length !== headings.length)
    throw new ValidationError(
      "The column choices don't match the file. Check the file again.",
    );
  const taken = new Set<Role>();
  return raw.map((entry, index) => {
    const column = (entry ?? {}) as Record<string, unknown>;
    const role = column.role as Role;
    if (!ROLES.includes(role))
      throw new ValidationError(`Column ${index + 1} needs a choice.`);
    if (role !== "measure" && role !== "ignore") {
      if (taken.has(role))
        throw new ValidationError(
          `Only one column can be the ${role === "labReference" ? "lab reference" : role}.`,
        );
      taken.add(role);
    }
    const measure =
      role === "measure"
        ? requireString(column.measure, `Column ${index + 1} measure`, {
            maxLength: 100,
          })
        : null;
    const unit =
      role === "measure"
        ? optionalString(column.unit, `Column ${index + 1} unit`, {
            maxLength: 40,
          })
        : null;
    return {
      index,
      heading: headings[index],
      role,
      measure: measure ? (knownMeasure(measure) ?? measure) : null,
      unit,
    };
  });
}

async function readImport(tx: OrgTx, farmId: string, input: ImportInput) {
  const fileName = requireString(input.fileName, "File name", {
    maxLength: 200,
  });
  const { rows: table, sha256 } = await fileRows(fileName, input);
  // Labs often put a title above the headings: use the first row with at least two cells.
  const start = table.findIndex(
    (cells) => cells.filter((cell) => cell.trim()).length >= 2,
  );
  if (start < 0 || table.length < start + 2)
    throw new ValidationError(
      "The file needs a heading row and at least one sample.",
    );
  if (table.length - start - 1 > MAX_ROWS)
    throw new ValidationError(`The file has more than ${MAX_ROWS} samples.`);
  const headings = table[start].map((cell) => cell.trim());
  const columns =
    chosenColumns(input.columns, headings) ?? guessColumns(headings);
  const fallbackDate = input.sampledOn
    ? parseIsoDate(input.sampledOn, "Sampled on")
    : null;
  const lab = optionalString(input.lab, "Lab", { maxLength: 100 });
  const paddockColumn =
    columns.find((column) => column.role === "paddock") ?? null;
  const sampleColumn =
    columns.find((column) => column.role === "sample") ?? null;
  const dateColumn = columns.find((column) => column.role === "date") ?? null;
  const measures = columns.filter((column) => column.role === "measure");
  const paddocks = await tx.query<{ id: string; name: string }>(
    "select id::text, name from paddocks where farm_id = $1 and status = 'active'",
    [farmId],
  );
  const earlier = await tx.query<{ created_at: string }>(
    "select created_at::text from farm_imports where farm_id = $1 and kind = 'soil_tests' and sha256 = $2",
    [farmId, sha256],
  );

  const rows = table
    .slice(start + 1)
    .map((cells, offset) => ({ cells, line: start + offset + 2 }))
    .filter(({ cells }) => cells.some((cell) => cell.trim()))
    .map(({ cells, line }) => {
      const cell = (column: SoilImportColumn | null) =>
        column ? (cells[column.index] ?? "").trim() : "";
      // With no paddock column, the sample name is matched to a paddock (labs often put it there).
      const paddockText =
        cell(paddockColumn) || (paddockColumn ? "" : cell(sampleColumn));
      const paddock =
        paddocks.rows.find(
          (row) => row.name.toLowerCase() === paddockText.toLowerCase(),
        ) ?? null;
      let error: string | null = null;
      let sampledOn: string | null = null;
      const results: SoilResult[] = [];
      try {
        const dateText = cell(dateColumn);
        sampledOn = dateText ? parseBankDate(dateText) : fallbackDate;
        if (dateText && !sampledOn)
          throw new ValidationError(`"${dateText}" isn't a date.`);
        for (const column of measures) {
          const read = readResult(cell(column));
          if (read)
            results.push({
              measure: column.measure!,
              ...read,
              unit: column.unit,
            });
        }
      } catch (caught) {
        error =
          caught instanceof Error ? caught.message : "That row can't be read.";
      }
      if (!error && !paddockText)
        error = paddockColumn
          ? "There's no paddock."
          : "Choose which column holds the paddock.";
      if (!error && !paddock)
        error = `There's no current paddock ${paddockText} on this farm.`;
      if (!error && !sampledOn)
        error =
          "There's no date sampled. Choose the date column, or enter the date for the whole file.";
      if (!error && results.length === 0) error = "There are no results.";
      if (!error) {
        try {
          checkResults(results);
        } catch (caught) {
          error =
            caught instanceof Error
              ? caught.message
              : "The results can't be read.";
        }
      }
      return {
        line,
        paddock: paddockText || null,
        sampledOn,
        sampleName: cell(sampleColumn) || null,
        labReference:
          cell(
            columns.find((column) => column.role === "labReference") ?? null,
          ) || null,
        depth:
          cell(columns.find((column) => column.role === "depth") ?? null) ||
          null,
        results,
        paddockId: paddock?.id ?? null,
        error,
      };
    });
  return {
    fileName,
    sha256,
    alreadyImportedOn: earlier.rows[0]?.created_at ?? null,
    columns,
    rows,
    lab,
  };
}

/** What importing a lab's file would do, before anything is saved: the column choices and each sample. */
export async function previewSoilImport(
  tx: OrgTx,
  farmIdInput: unknown,
  input: ImportInput,
): Promise<SoilImportPreview> {
  const farmId = await requireFarm(tx, farmIdInput);
  const read = await readImport(tx, farmId, input);
  const rows = read.rows.map((row) => ({
    line: row.line,
    paddock: row.paddock,
    sampledOn: row.sampledOn,
    sampleName: row.sampleName,
    results: row.results.length,
    error: row.error,
  }));
  return {
    fileName: read.fileName,
    sha256: read.sha256,
    alreadyImportedOn: read.alreadyImportedOn,
    columns: read.columns,
    rows,
    counts: {
      tests: rows.filter((row) => !row.error).length,
      errors: rows.filter((row) => row.error).length,
    },
  };
}

/** Imports the samples without errors as soil tests. The same file twice adds nothing. */
export async function importSoilTests(
  tx: OrgTx,
  farmIdInput: unknown,
  input: ImportInput,
  options: ImportOrigin = {},
): Promise<SoilTest[]> {
  const farmId = await requireFarm(tx, farmIdInput);
  await tx.query("select 1 from farms where id = $1 for update", [farmId]);
  const read = await readImport(tx, farmId, input);
  if (read.alreadyImportedOn)
    throw new ConflictError(
      `This file was already imported on ${read.alreadyImportedOn.slice(0, 10)}.`,
    );
  const good = read.rows.filter((row) => !row.error);
  if (good.length === 0)
    throw new ValidationError("There are no samples without errors to import.");
  const ids: string[] = [];
  for (const row of good) {
    ids.push(
      await insertTest(tx, farmId, {
        paddockId: row.paddockId!,
        sampledOn: row.sampledOn!,
        sampleName: row.sampleName,
        lab: read.lab,
        labReference: row.labReference,
        depth: row.depth,
        source: importSource(read.fileName, options),
        results: row.results,
      }),
    );
  }
  await tx.query(
    "insert into farm_imports (farm_id, kind, file_name, sha256, summary, created_by_email) values ($1, 'soil_tests', $2, $3, $4::jsonb, $5)",
    [
      farmId,
      read.fileName,
      read.sha256,
      JSON.stringify({
        imported: good.length,
        skipped: read.rows.length - good.length,
        ...(options.filedFromPrivateMail ? { filedFromPrivateMail: true } : {}),
      }),
      tx.actor.email,
    ],
  );
  await writeAuditEvent(tx, {
    eventType: "farming.soil_tests_imported",
    entityType: "farm",
    entityId: farmId,
    details: { fileName: read.fileName, imported: good.length, ...(options.filedFromPrivateMail ? { filedFromPrivateMail: true } : {}) },
  });
  return loadTests(tx, "t.id = any($1::bigint[])", [ids]);
}

// A paddock's history --------------------------------------------------------------------------------

export type PaddockHistory = {
  soilTests: SoilTest[];
  applications: Array<{
    id: string;
    planId: string;
    planName: string;
    productName: string;
    appliedOn: string;
    tonnes: string;
    treatedHa: string;
  }>;
};

/** What's been recorded on a paddock: its soil tests and fertiliser applications, newest first. Costs stay on the plan. */
export async function paddockHistory(
  tx: OrgTx,
  paddockIdInput: unknown,
): Promise<PaddockHistory> {
  await requireFarming(tx);
  const paddockId = requireId(paddockIdInput, "paddockId");
  const found = await tx.query("select 1 from paddocks where id = $1", [
    paddockId,
  ]);
  if (!found.rowCount) throw new NotFoundError("Paddock not found.");
  const applications = await tx.query<{
    id: string;
    plan_id: string;
    plan_name: string;
    product_name: string;
    applied_on: string;
    tonnes: string;
    treated_ha: string;
  }>(
    `select a.id::text, a.plan_id::text, p.name as plan_name, pr.name as product_name, a.applied_on::text, a.tonnes::text, a.treated_ha::text
       from fertiliser_applications a join fertiliser_plans p on p.id = a.plan_id join fertiliser_products pr on pr.id = a.product_id
      where a.paddock_id = $1 and a.status = 'active'
      order by a.applied_on desc, a.id desc`,
    [paddockId],
  );
  return {
    soilTests: await loadTests(tx, "t.paddock_id = $1", [paddockId]),
    applications: applications.rows.map((row) => ({
      id: row.id,
      planId: row.plan_id,
      planName: row.plan_name,
      productName: row.product_name,
      appliedOn: row.applied_on,
      tonnes: toFixedString(dec(row.tonnes), 3),
      treatedHa: toFixedString(dec(row.treated_ha), 2),
    })),
  };
}
