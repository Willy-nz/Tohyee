import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readXlsxRows } from "@/lib/bank/formats/xlsx";

/** A minimal .xlsx (just the parts Tohyee reads); the reader doesn't check CRCs. */
function xlsx(sheets: Record<string, string | Buffer>): Buffer {
  const parts: Array<{ name: string; data: Buffer; size: number }> = Object.entries(sheets).map(([name, content]) => {
    const raw = typeof content === "string" ? Buffer.from(content) : content;
    return { name, data: typeof content === "string" ? deflateRawSync(raw) : raw, size: typeof content === "string" ? raw.length : 10 };
  });
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(part.data.length, 18);
    local.writeUInt32LE(part.size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, part.data);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(part.data.length, 20);
    header.writeUInt32LE(part.size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += 30 + name.length + part.data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const sheet = (rows: string) => `<worksheet><sheetData>${rows}</sheetData></worksheet>`;
const cell = (ref: string, value: string) => `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;

describe("reading .xlsx files safely (#134)", () => {
  it("reads an ordinary sheet", () => {
    const file = xlsx({ "xl/worksheets/sheet1.xml": sheet(`<row r="1">${cell("A1", "Date")}${cell("B1", "Amount")}</row><row r="2">${cell("A2", "2026-10-01")}<c r="B2"><v>12.5</v></c></row>`) });
    expect(readXlsxRows(file)).toEqual([["Date", "Amount"], ["2026-10-01", "12.5"]]);
  });

  it("doesn't pad up to a huge row number", () => {
    const file = xlsx({ "xl/worksheets/sheet1.xml": sheet(`<row r="1048576">${cell("A1048576", "Last")}</row><row r="99999999">${cell("A1", "Later")}</row>`) });
    expect(readXlsxRows(file)).toEqual([["Last"], ["Later"]]);
  });

  it("refuses a cell past Excel's last column", () => {
    expect(() => readXlsxRows(xlsx({ "xl/worksheets/sheet1.xml": sheet(`<row r="1">${cell("XFE1", "x")}</row>`) }))).toThrow("past Excel's last column");
    expect(() => readXlsxRows(xlsx({ "xl/worksheets/sheet1.xml": sheet(`<row r="1">${cell("AAAAAAAA1", "x")}</row>`) }))).toThrow("past Excel's last column");
    expect(readXlsxRows(xlsx({ "xl/worksheets/sheet1.xml": sheet(`<row r="1">${cell("XFD1", "x")}</row>`) }))[0].length).toBe(16_384);
  });

  it("stops at the row limit, and at too many cells", () => {
    const rows = Array.from({ length: 30 }, (_, index) => `<row r="${index + 1}">${cell(`A${index + 1}`, "x")}</row>`).join("");
    expect(() => readXlsxRows(xlsx({ "xl/worksheets/sheet1.xml": sheet(rows) }), 20)).toThrow("more than 20 rows");
    const wide = Array.from({ length: 200 }, (_, index) => `<row r="${index + 1}">${cell(`XFD${index + 1}`, "x")}</row>`).join("");
    expect(() => readXlsxRows(xlsx({ "xl/worksheets/sheet1.xml": sheet(wide) }))).toThrow("too large to import");
  });

  it("only unpacks the sheet it reads", () => {
    const file = xlsx({
      "xl/worksheets/sheet1.xml": sheet(`<row r="1">${cell("A1", "Kept")}</row>`),
      // Not valid deflate data: unpacking it would fail.
      "xl/worksheets/sheet2.xml": Buffer.from("not deflate data"),
    });
    expect(readXlsxRows(file)).toEqual([["Kept"]]);
  });
});
