import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateRawSync, crc32 } from "node:zlib";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeAnalytics,
  inspectSourceFile,
  inspectXlsx,
  listSourceFiles,
  loadSourceFile,
  loadXlsx,
  queryAnalytics,
  type LoadColumn,
} from "@/lib/analytics/engine";
import { excelCellText, excelNumberText } from "@/lib/analytics/xlsx";

// Decision 376: Excel workbooks load through the same path as CSV files.

const ORG = "xlsxtest";
let root: string;
let sources: string;
let previousDir: string | undefined;

// ---------------------------------------------------------------------------
// A tiny ZIP writer, so tests control the order of parts and can build
// hostile files (hidden entries, understated sizes, encryption flags).

type RawEntry = { name: string; bytes: Buffer; compress?: boolean; hidden?: boolean; declaredSize?: number; flags?: number };

function zip(entries: RawEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let listed = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = entry.compress === false ? entry.bytes : deflateRawSync(entry.bytes);
    const method = entry.compress === false ? 0 : 8;
    const size = entry.declaredSize ?? entry.bytes.length;
    const crc = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    if (!entry.hidden) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(entry.flags ?? 0, 8);
      header.writeUInt16LE(method, 10);
      header.writeUInt32LE(crc, 16);
      header.writeUInt32LE(data.length, 20);
      header.writeUInt32LE(size, 24);
      header.writeUInt16LE(name.length, 28);
      header.writeUInt32LE(offset, 42);
      central.push(header, name);
      listed += 1;
    }
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(listed, 8);
  end.writeUInt16LE(listed, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

type Cell = string | number | boolean | null | { v: number; style?: number } | { f: string; v?: number | string; t?: "str" | "e" | "b"; style?: number };

function escape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function column(index: number): string {
  return String.fromCharCode(65 + index);
}

function sheetXml(rows: Array<Cell[] | { r: number; cells: Cell[] }>): string {
  const body = rows.map((row, rowIndex) => {
    const r = Array.isArray(row) ? rowIndex + 1 : row.r;
    const cells = (Array.isArray(row) ? row : row.cells).map((cell, index) => {
      const ref = `${column(index)}${r}`;
      if (cell === null) return "";
      if (typeof cell === "string") return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escape(cell)}</t></is></c>`;
      if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`;
      if (typeof cell === "boolean") return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`;
      const style = cell.style ? ` s="${cell.style}"` : "";
      if ("f" in cell) {
        const type = cell.t ? ` t="${cell.t}"` : "";
        return `<c r="${ref}"${style}${type}><f>${escape(cell.f)}</f>${cell.v === undefined ? "" : `<v>${escape(String(cell.v))}</v>`}</c>`;
      }
      return `<c r="${ref}"${style}><v>${cell.v}</v></c>`;
    }).join("");
    return `<row r="${r}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${MAIN}"><sheetData>${body}</sheetData></worksheet>`;
}

// Styles: 1 = yyyy-mm-dd, 2 = yyyy-mm-dd hh:mm, 3 = 0%.
const STYLES = `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${MAIN}">` +
  `<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm"/></numFmts>` +
  `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
  `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
  `<borders count="1"><border/></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;

type RawSheet = { name: string; rows: Array<Cell[] | { r: number; cells: Cell[] }>; part?: string; chart?: boolean };

/** A workbook's parts in Excel's own order: sheets before styles and shared strings. */
function workbookEntries(sheets: RawSheet[], options: { date1904?: string; absoluteTargets?: boolean; sharedStrings?: string[] } = {}): RawEntry[] {
  const parts = sheets.map((sheet, index) => sheet.part ?? (sheet.chart ? `xl/chartsheets/sheet${index + 1}.xml` : `xl/worksheets/sheet${index + 1}.xml`));
  const workbook = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${MAIN}" xmlns:r="${REL}">` +
    `<workbookPr${options.date1904 ? ` date1904="${options.date1904}"` : ""}/><sheets>` +
    sheets.map((sheet, index) => `<sheet name="${escape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("") +
    `</sheets></workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheets.map((sheet, index) => {
      const target = options.absoluteTargets ? `/${parts[index]}` : parts[index].replace(/^xl\//, "");
      return `<Relationship Id="rId${index + 1}" Type="${REL}/${sheet.chart ? "chartsheet" : "worksheet"}" Target="${target}"/>`;
    }).join("") +
    `<Relationship Id="rId100" Type="${REL}/styles" Target="styles.xml"/>` +
    (options.sharedStrings ? `<Relationship Id="rId101" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>` : "") +
    `</Relationships>`;
  const types = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`;
  const entries: RawEntry[] = [
    { name: "[Content_Types].xml", bytes: Buffer.from(types) },
    { name: "xl/workbook.xml", bytes: Buffer.from(workbook) },
    { name: "xl/_rels/workbook.xml.rels", bytes: Buffer.from(rels) },
    // Sheets in reverse: the ZIP's order isn't the tab order.
    ...sheets.map((sheet, index) => ({ name: parts[index], bytes: Buffer.from(sheetXml(sheet.rows)) })).reverse(),
    { name: "xl/styles.xml", bytes: Buffer.from(STYLES) },
  ];
  if (options.sharedStrings) {
    entries.push({
      name: "xl/sharedStrings.xml",
      bytes: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${MAIN}">${options.sharedStrings.map((text) => `<si><t>${escape(text)}</t></si>`).join("")}</sst>`),
    });
  }
  return entries;
}

function writeFile(name: string, bytes: Buffer): string {
  const file = path.join(sources, name);
  fs.writeFileSync(file, bytes);
  return file;
}

const SALES: LoadColumn[] = [
  { source: "Day", name: "day", kind: "date" },
  { source: "Customer", name: "customer", kind: "text" },
  { source: "Amount", name: "amount", kind: "money" },
];

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-xlsx-"));
  sources = path.join(root, "sources");
  fs.mkdirSync(sources);
  previousDir = process.env.TOHYEE_ANALYTICS_DIR;
  process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
});

afterAll(async () => {
  await closeAnalytics(ORG);
  if (previousDir === undefined) delete process.env.TOHYEE_ANALYTICS_DIR;
  else process.env.TOHYEE_ANALYTICS_DIR = previousDir;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Excel cells as text (decision 376)", () => {
  it("writes numbers as the shortest exact text, never in exponent form", () => {
    expect(excelNumberText(0.1 + 0.2)).toBe("0.30000000000000004");
    expect(excelNumberText(1e-7)).toBe("0.0000001");
    expect(excelNumberText(-1.5e-7)).toBe("-0.00000015");
    expect(excelNumberText(1e21)).toBe("1000000000000000000000");
    expect(excelNumberText(1.25e22)).toBe("12500000000000000000000");
    expect(excelNumberText(-0)).toBe("0");
    expect(excelNumberText(123456789012.34)).toBe("123456789012.34");
    expect(excelNumberText(Number.NaN)).toBe("#NUM!");
  });

  it("reads formulas, rich text, booleans, errors and dates", () => {
    expect(excelCellText({ formula: "A1+A2", result: 0.30000000000000004 }, undefined, false)).toBe("0.30000000000000004");
    expect(excelCellText({ formula: "A1+1", result: 46023 }, "yyyy-mm-dd", false)).toBe("2026-01-01");
    expect(excelCellText({ formula: "A1+1", result: 46023 - 1462 }, "yyyy-mm-dd", true)).toBe("2026-01-01");
    expect(excelCellText({ formula: "A1", result: 46023.5 }, "yyyy-mm-dd hh:mm", false)).toBe("2026-01-01 12:00:00");
    expect(excelCellText({ formula: "NA()", result: Number.NaN }, undefined, false)).toBe("#ERROR!");
    expect(excelCellText({ formula: "A1" }, undefined, false)).toBe("");
    expect(excelCellText({ sharedFormula: "B2", result: "text" }, undefined, false)).toBe("text");
    expect(excelCellText({ richText: [{ text: "Kia " }, { text: "ora" }] }, undefined, false)).toBe("Kia ora");
    expect(excelCellText({ text: { richText: [{ text: "link" }] }, hyperlink: "https://example.nz" }, undefined, false)).toBe("link");
    expect(excelCellText({ error: "#DIV/0!" }, undefined, false)).toBe("#DIV/0!");
    expect(excelCellText(true, undefined, false)).toBe("true");
    expect(excelCellText(new Date("2026-04-01T00:00:00Z"), "d/mm/yyyy", false)).toBe("2026-04-01");
    expect(excelCellText(new Date("2026-04-01T09:30:00Z"), "[$-en-NZ]d/mm/yyyy h:mm", false)).toBe("2026-04-01 09:30:00");
    expect(excelCellText(null, undefined, false)).toBe("");
  });
});

describe("loading Excel workbooks (decision 376)", () => {
  it("loads exact money, dates, formulas and text from the first tab, whatever the ZIP order", async () => {
    const file = writeFile("money.xlsx", zip(workbookEntries([
      {
        name: "Sales",
        rows: [
          ["Day", "Customer", "Amount", "Rate", "Paid", "Count", "When"],
          [{ v: 46023, style: 1 }, "Kauri, \"Ltd\"", 0.1, { v: 0.15, style: 3 }, true, 3, { v: 46023.75, style: 2 }],
          [{ v: 46024, style: 1 }, { f: "\"Rimu\"", v: "Rimu", t: "str" }, 0.2, 0.125, false, 4, null],
          // 0.1 + 0.2 worked out by Excel, and money written with float noise.
          [{ f: "A2+2", v: 46025, style: 1 }, "Tōtara\nNorth", { f: "C2+C3", v: 0.30000000000000004 }, 1, true, 5],
          [{ v: 46026, style: 1 }, "Big", 12345678901234.56],
          [{ v: 46027, style: 1 }, "Refund", -1234.565],
          [{ v: 46028, style: 1 }, "Half cent", 2.675],
          [{ v: 46029, style: 1 }, "Tiny", 1e-7],
          // An empty row (formatting only) and a short row.
          { r: 20, cells: [] },
          { r: 21, cells: [{ v: 46030, style: 1 }, "Short"] },
        ],
      },
      { name: "Other", rows: [["Day", "Customer", "Amount"], ["2026-01-01", "Wrong sheet", 1]] },
    ])));
    const result = await loadSourceFile({
      organisationId: ORG,
      sourceFolder: sources,
      file,
      table: "money",
      columns: [
        ...SALES,
        { source: "Rate", name: "rate", kind: "decimal" },
        { source: "Paid", name: "paid", kind: "boolean" },
        { source: "Count", name: "count", kind: "integer" },
        { source: "When", name: "at_time", kind: "timestamp" },
      ],
    });
    expect(result.rows).toBe(8);
    expect(await queryAnalytics(ORG, `select day::varchar as day, customer, amount::varchar as amount, rate::varchar as rate,
      paid, count::varchar as count, at_time::varchar as at_time from money order by day`)).toEqual([
      { day: "2026-01-01", customer: 'Kauri, "Ltd"', amount: "0.10", rate: "0.150000", paid: true, count: "3", at_time: "2026-01-01 18:00:00" },
      { day: "2026-01-02", customer: "Rimu", amount: "0.20", rate: "0.125000", paid: false, count: "4", at_time: null },
      { day: "2026-01-03", customer: "Tōtara\nNorth", amount: "0.30", rate: "1.000000", paid: true, count: "5", at_time: null },
      { day: "2026-01-04", customer: "Big", amount: "12345678901234.56", rate: null, paid: null, count: null, at_time: null },
      { day: "2026-01-05", customer: "Refund", amount: "-1234.57", rate: null, paid: null, count: null, at_time: null },
      { day: "2026-01-06", customer: "Half cent", amount: "2.68", rate: null, paid: null, count: null, at_time: null },
      { day: "2026-01-07", customer: "Tiny", amount: "0.00", rate: null, paid: null, count: null, at_time: null },
      { day: "2026-01-08", customer: "Short", amount: null, rate: null, paid: null, count: null, at_time: null },
    ]);
    // The column type is an exact decimal, never a float.
    expect(await queryAnalytics(ORG, "select data_type from information_schema.columns where table_name = 'money' and column_name = 'amount'"))
      .toEqual([{ data_type: "DECIMAL(18,2)" }]);
    expect(await queryAnalytics(ORG, "select sum(amount)::varchar as total from money where day <= '2026-01-03'")).toEqual([{ total: "0.60" }]);
    // The scratch copy of the sheet is gone.
    expect(fs.readdirSync(path.join(root, "data")).filter((name) => name.startsWith(".xlsx-"))).toEqual([]);
  });

  it("keeps formula results of 0 and FALSE (ExcelJS drops them from cell.value)", async () => {
    const file = writeFile("zero.xlsx", zip(workbookEntries([
      { name: "Zero", rows: [["Day", "Customer", "Amount", "Paid"], [{ v: 46023, style: 1 }, { f: "\"\"", v: "", t: "str" }, { f: "1-1", v: 0 }, { f: "1=2", v: 0, t: "b" }]] },
    ])));
    await loadXlsx({
      organisationId: ORG, sourceFolder: sources, file, table: "zero",
      columns: [...SALES, { source: "Paid", name: "paid", kind: "boolean" }],
    });
    expect(await queryAnalytics(ORG, "select customer, amount::varchar as amount, paid from zero")).toEqual([{ customer: null, amount: "0.00", paid: false }]);
  });

  it("uses the 1904 date system when the workbook says so", async () => {
    for (const flag of ["1", "true"]) {
      const file = writeFile(`mac-${flag}.xlsx`, zip(workbookEntries([
        { name: "Mac", rows: [["Day", "Customer", "Amount"], [{ v: 46023 - 1462, style: 1 }, "Mac", 1], [{ f: "A2", v: 0, style: 1 }, "Zero", 2]] },
      ], { date1904: flag })));
      await loadXlsx({ organisationId: ORG, sourceFolder: sources, file, table: "mac", columns: SALES });
      expect(await queryAnalytics(ORG, "select day::varchar as day from mac order by amount")).toEqual([{ day: "2026-01-01" }, { day: "1904-01-01" }]);
    }
  });

  it("reads shared strings, absolute sheet paths and odd sheet file names", async () => {
    const file = writeFile("shared.xlsx", zip(workbookEntries([
      { name: "Data", part: "xl/worksheets/Data Sheet.xml", rows: [["Day", "Customer", "Amount"], [{ v: 46023, style: 1 }, "Inline", 5]] },
    ], { absoluteTargets: true, sharedStrings: ["unused"] })));
    await loadXlsx({ organisationId: ORG, sourceFolder: sources, file, table: "shared", columns: SALES });
    expect(await queryAnalytics(ORG, "select customer, amount::varchar as amount from shared")).toEqual([{ customer: "Inline", amount: "5.00" }]);
  });

  it("loads the chosen sheet, refuses a missing one, and keeps the old table when a load fails", async () => {
    const book = (rows: RawSheet["rows"]) => zip(workbookEntries([
      { name: "Chart", chart: true, rows: [] },
      { name: "January", rows: [["Day", "Customer", "Amount"], [{ v: 46023, style: 1 }, "Jan", 10]] },
      { name: "February", rows },
    ]));
    const file = writeFile("months.xlsx", book([["Day", "Customer", "Amount"], [{ v: 46054, style: 1 }, "Feb", 20]]));
    const preview = await inspectSourceFile(sources, "months.xlsx");
    // Chart sheets have no rows, so they aren't offered; the first worksheet is the default.
    expect(preview.sheets).toEqual(["January", "February"]);
    expect(preview.sheetName).toBe("January");
    expect(preview.columns.map((entry) => [entry.source, entry.kind])).toEqual([["Day", "date"], ["Customer", "text"], ["Amount", "money"]]);
    expect((await inspectXlsx(sources, "months.xlsx", "February")).rows).toEqual([["2026-02-01", "Feb", "20"]]);
    expect((await inspectXlsx(sources, "months.xlsx", "Gone")).sheetName).toBe("January");

    await loadXlsx({ organisationId: ORG, sourceFolder: sources, file, table: "months", columns: SALES, sheetName: "February" });
    expect(await queryAnalytics(ORG, "select customer from months")).toEqual([{ customer: "Feb" }]);
    await expect(loadXlsx({ organisationId: ORG, sourceFolder: sources, file, table: "months", columns: SALES, sheetName: "March" }))
      .rejects.toThrow('The sheet "March" wasn\'t found');

    // Same errors as a CSV: a bad value, a missing column, a value with no heading.
    writeFile("months.xlsx", book([["Day", "Customer", "Amount"], ["not a date", "Feb", 20]]));
    await expect(loadXlsx({ organisationId: ORG, sourceFolder: sources, file, table: "months", columns: SALES, sheetName: "February" }))
      .rejects.toThrow(/not a date/);
    writeFile("months.xlsx", book([["Day", "Customer"], [{ v: 46054, style: 1 }, "Feb"]]));
    await expect(loadXlsx({ organisationId: ORG, sourceFolder: sources, file, table: "months", columns: SALES, sheetName: "February" }))
      .rejects.toThrow(/Amount/);
    writeFile("months.xlsx", book([["Day", "Customer", "Amount"], [{ v: 46054, style: 1 }, "Feb", 20, null, "stray"]]));
    await expect(loadXlsx({ organisationId: ORG, sourceFolder: sources, file, table: "months", columns: SALES, sheetName: "February" }))
      .rejects.toThrow("Row 2 has a value in column E, which has no heading");
    expect(await queryAnalytics(ORG, "select customer from months")).toEqual([{ customer: "Feb" }]);
    expect(await queryAnalytics(ORG, "select count(*)::int as n from information_schema.tables where table_name like '\\_tohyee%' escape '\\'"))
      .toEqual([{ n: 0 }]);
  });

  it("lists .xls and .xlsm files so choosing one says why it can't be used", async () => {
    writeFile("old.xls", Buffer.from("old"));
    writeFile("macro.xlsm", Buffer.from("macro"));
    const names = listSourceFiles(sources).map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining(["old.xls", "macro.xlsm"]));
    await expect(inspectSourceFile(sources, "old.xls")).rejects.toThrow(/\.xls\).*\.xlsx/);
    await expect(inspectSourceFile(sources, "macro.xlsm")).rejects.toThrow(/macros/);
    await expect(loadSourceFile({ organisationId: ORG, sourceFolder: sources, file: path.join(sources, "old.xls"), table: "old", columns: SALES }))
      .rejects.toThrow(/\.xls/);
  });

  it("refuses macros hidden in an .xlsx, password-protected and binary workbooks", async () => {
    const ordinary = workbookEntries([{ name: "Data", rows: [["Day", "Customer", "Amount"]] }]);
    const cases: Array<[string, Buffer, RegExp]> = [
      ["vba.xlsx", zip([...ordinary, { name: "xl/vbaProject.bin", bytes: Buffer.from("macro") }]), /macros/],
      ["typed.xlsx", zip(ordinary.map((entry) => entry.name === "[Content_Types].xml"
        ? { ...entry, bytes: Buffer.from(entry.bytes.toString().replace("sheet.main+xml", "sheet.macroEnabled.main+xml")) }
        : entry)), /macros/],
      // Excel saves a password-protected workbook as an encrypted OLE compound file.
      ["locked.xlsx", Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(504)]), /password-protected/],
      ["zipcrypto.xlsx", zip(ordinary.map((entry) => ({ ...entry, flags: 1 }))), /password-protected/],
      ["binary.xlsx", zip([...ordinary, { name: "xl/workbook.bin", bytes: Buffer.from("bin") }]), /\.xlsb/],
      ["text.xlsx", Buffer.from("Day,Amount\n2026-01-01,1\n"), /isn't an Excel workbook/],
    ];
    for (const [name, bytes, message] of cases) {
      const file = writeFile(name, bytes);
      await expect(loadXlsx({ organisationId: ORG, sourceFolder: sources, file, table: "refused", columns: SALES }), name).rejects.toThrow(message);
      await expect(inspectSourceFile(sources, name), name).rejects.toThrow(message);
    }
  });

  it("refuses ZIP bombs disguised as workbooks and never reads entries the ZIP doesn't list", async () => {
    const ordinary = workbookEntries([{ name: "Data", rows: [["Day", "Customer", "Amount"], [{ v: 46023, style: 1 }, "Real", 1]] }]);
    // 20 MB of zeros squeezes to about 20 kB.
    const bomb = writeFile("bomb.xlsx", zip([...ordinary, { name: "xl/media/zeros.bin", bytes: Buffer.alloc(20 * 1024 * 1024) }]));
    await expect(loadXlsx({ organisationId: ORG, sourceFolder: sources, file: bomb, table: "bomb", columns: SALES })).rejects.toThrow(/unsafe|limit/);
    // A size the ZIP understates is caught as it unpacks.
    const lying = writeFile("lying.xlsx", zip([...ordinary, { name: "xl/media/a.bin", bytes: Buffer.alloc(200_000, 7), declaredSize: 100_000 }]));
    await expect(loadXlsx({ organisationId: ORG, sourceFolder: sources, file: lying, table: "bomb", columns: SALES })).rejects.toThrow(/unsafe|limit/);
    // Two entries with the same name.
    const twice = writeFile("twice.xlsx", zip([...ordinary, ordinary.find((entry) => entry.name.startsWith("xl/worksheets/"))!]));
    await expect(loadXlsx({ organisationId: ORG, sourceFolder: sources, file: twice, table: "bomb", columns: SALES })).rejects.toThrow(/unsafe/);

    // A sheet hidden before the real parts, missing from the ZIP's directory:
    // ExcelJS on its own reads it; Tohyee never shows it to ExcelJS.
    const evil = { name: "xl/worksheets/sheet1.xml", bytes: Buffer.from(sheetXml([["Day", "Customer", "Amount"], [{ v: 46023, style: 1 }, "Hidden", 999]])), hidden: true };
    const hidden = writeFile("hidden.xlsx", zip([evil, ...ordinary]));
    const seenByExcelJs: string[] = [];
    for await (const worksheet of new ExcelJS.stream.xlsx.WorkbookReader(hidden, {})) {
      for await (const row of worksheet) seenByExcelJs.push(String(row.getCell(2).value));
    }
    expect(seenByExcelJs).toContain("Hidden");
    await loadXlsx({ organisationId: ORG, sourceFolder: sources, file: hidden, table: "hidden", columns: SALES });
    expect(await queryAnalytics(ORG, "select customer from hidden")).toEqual([{ customer: "Real" }]);
  });

  it("refuses workbooks over 50 MB before reading them", async () => {
    const file = path.join(sources, "huge.xlsx");
    const descriptor = fs.openSync(file, "w");
    try {
      fs.ftruncateSync(descriptor, 50 * 1024 * 1024 + 1);
    } finally {
      fs.closeSync(descriptor);
    }
    await expect(loadXlsx({ organisationId: ORG, sourceFolder: sources, file, table: "huge", columns: SALES })).rejects.toThrow(/50 MB/);
    await expect(inspectSourceFile(sources, "huge.xlsx")).rejects.toThrow(/50 MB/);
  });

  it("streams a large workbook and previews it without reading every row", async () => {
    const rows = 150_000;
    const file = path.join(sources, "large.xlsx");
    const writer = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file, useSharedStrings: true, useStyles: true });
    const sheet = writer.addWorksheet("Large");
    sheet.addRow(["Day", "Customer", "Amount"]).commit();
    let cents = 0;
    for (let index = 0; index < rows; index += 1) {
      const amount = ((index % 1000) + 1) / 100 + 0.1 + 0.2; // float noise on purpose
      cents += Math.round(amount * 100);
      const row = sheet.addRow([new Date(Date.UTC(2026, 0, 1 + (index % 365))), `Customer ${index % 5000}`, amount]);
      row.getCell(1).numFmt = "yyyy-mm-dd";
      row.commit();
    }
    await writer.commit();

    const startedPreview = performance.now();
    const preview = await inspectSourceFile(sources, "large.xlsx");
    expect(preview.rows).toHaveLength(20);
    expect(preview.columns.map((entry) => entry.kind)).toEqual(["date", "text", "money"]);
    const previewMs = performance.now() - startedPreview;

    const startedLoad = performance.now();
    const result = await loadXlsx({ organisationId: ORG, sourceFolder: sources, file, table: "large", columns: SALES });
    const loadMs = performance.now() - startedLoad;
    expect(result.rows).toBe(rows);
    expect(await queryAnalytics(ORG, "select sum(amount)::varchar as total, count(distinct customer)::int as customers from large"))
      .toEqual([{ total: (cents / 100).toFixed(2), customers: 5000 }]);
    // A preview reads only the first 20,481 rows, not all of them.
    expect(previewMs).toBeLessThan(loadMs);
  }, 180_000);
});
