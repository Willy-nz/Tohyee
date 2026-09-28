import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseBankAmount, parseBankDate } from "@/lib/bank/formats/common";
import { readStatementFile } from "@/lib/bank/formats";
import { parseDelimited, readTable } from "@/lib/bank/formats/table";

/** The three BK1 transactions, as every format should read them. */
const BK1 = [
  { date: "2026-05-20", amount: "115.00" },
  { date: "2026-05-21", amount: "-46.00" },
  { date: "2026-05-22", amount: "-500.00" },
];

const CSV = `Date,Amount,Payee,Particulars,Code,Reference
20/05/2026,115.00,KOBE LTD,INV-0001,,
21/05/2026,-46.00,Z ENERGY,,,
22/05/2026,-500.00,TRANSFER,SAVINGS,,
`;

function dateAndAmount(lines: Array<{ date: string; amount: string }>) {
  return lines.map((line) => ({ date: line.date, amount: line.amount }));
}

/** A minimal .xlsx: a zip of the workbook parts, some stored and some deflated. */
function xlsx(rows: Array<Array<string | number>>): Buffer {
  const strings: string[] = [];
  const sheetRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, column) => {
          const ref = `${String.fromCharCode(65 + column)}${rowIndex + 1}`;
          if (typeof value === "number") return `<c r="${ref}"><v>${value}</v></c>`;
          strings.push(value);
          return `<c r="${ref}" t="s"><v>${strings.length - 1}</v></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  const parts: Record<string, string> = {
    "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="Statement" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst>${strings.map((text) => `<si><t>${text.replace(/&/g, "&amp;")}</t></si>`).join("")}</sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`,
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  Object.entries(parts).forEach(([name, content], index) => {
    const raw = Buffer.from(content, "utf8");
    const deflate = index % 2 === 1;
    const data = deflate ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  });
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(parts).length, 8);
  end.writeUInt16LE(Object.keys(parts).length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

describe("bank statement files (examples BK1-BK3)", () => {
  it("reads dates the way NZ banks write them", () => {
    expect(parseBankDate("20/05/2026")).toBe("2026-05-20");
    expect(parseBankDate("20/05/26")).toBe("2026-05-20");
    expect(parseBankDate("20-05-2026")).toBe("2026-05-20");
    expect(parseBankDate("2026-05-20")).toBe("2026-05-20");
    expect(parseBankDate("2026-05-20T00:00:00")).toBe("2026-05-20");
    expect(parseBankDate("20 May 2026")).toBe("2026-05-20");
    expect(parseBankDate("20-May-26")).toBe("2026-05-20");
    expect(parseBankDate("May 20, 2026")).toBe("2026-05-20");
    expect(parseBankDate("20260520")).toBe("2026-05-20");
    expect(parseBankDate("20/05'26")).toBe("2026-05-20");
    expect(parseBankDate("05/20/2026", "mdy")).toBe("2026-05-20");
    expect(parseBankDate("46162")).toBe("2026-05-20");
    expect(parseBankDate("31/02/2026")).toBeNull();
    expect(parseBankDate("Closing balance")).toBeNull();
  });

  it("reads amounts the way banks write them", () => {
    expect(parseBankAmount("-46.00")).toBe("-46.00");
    expect(parseBankAmount("1,234.5")).toBe("1234.50");
    expect(parseBankAmount("$46.00")).toBe("46.00");
    expect(parseBankAmount("-$46.00")).toBe("-46.00");
    expect(parseBankAmount("(46.00)")).toBe("-46.00");
    expect(parseBankAmount("46.00 DR")).toBe("-46.00");
    expect(parseBankAmount("46.00 CR")).toBe("46.00");
    expect(parseBankAmount("+115")).toBe("115.00");
    expect(parseBankAmount("46,00", { decimalComma: true })).toBe("46.00");
    expect(parseBankAmount("")).toBeNull();
    expect(() => parseBankAmount("10.001")).toThrow("more than 2 decimal places");
    expect(() => parseBankAmount("abc")).toThrow("isn't an amount");
  });

  it("BK1: the CSV gives three lines, day-first dates, with payee and particulars", () => {
    const file = readStatementFile("statement.csv", Buffer.from(CSV));
    expect(file.format).toBe("csv");
    expect(file.errors).toEqual([]);
    expect(dateAndAmount(file.lines)).toEqual(BK1);
    expect(file.lines[0]).toMatchObject({
      description: "KOBE LTD INV-0001",
      payee: "KOBE LTD",
      particulars: "INV-0001",
      code: null,
      reference: null,
      externalId: null,
    });
    expect(file.table?.layout).toMatchObject({
      headerRow: 0,
      dateOrder: "dmy",
      columns: { date: "Date", amount: "Amount", payee: "Payee", particulars: "Particulars", code: "Code", reference: "Reference" },
    });
  });

  it("CSV: preamble lines, quoted fields, money in and out columns, summary rows and a saved layout", () => {
    const text = [
      "Created date / time : 23 May 2026",
      "Bank 12-3456-7890123-00",
      "",
      'Processed Date,Details,Withdrawals,Deposits,Balance',
      '"20/05/2026","KOBE LTD, INV-0001",,"1,115.00","2,000.00"',
      '21/05/2026,Z ENERGY,46.00,,1954.00',
      "Closing balance,,,,1954.00",
    ].join("\r\n");
    const file = readStatementFile("asb.csv", Buffer.from(text));
    expect(file.errors).toEqual([]);
    expect(file.lines.map((line) => [line.date, line.amount, line.description, line.balance])).toEqual([
      ["2026-05-20", "1115.00", "KOBE LTD, INV-0001", "2000.00"],
      ["2026-05-21", "-46.00", "Z ENERGY", "1954.00"],
    ]);
    // A credit card export showing purchases as positive: flip the amounts.
    const card = readTable(parseDelimited("Date,Amount,Description\n21/05/2026,86.25,CAFE\n"), {
      headerRow: 0,
      columns: { date: "Date", amount: "Amount", description: "Description" },
      dateOrder: "dmy",
      invertAmounts: true,
    });
    expect(card.lines.map((line) => line.amount)).toEqual(["-86.25"]);
    // Bad rows are reported by row number.
    const bad = readStatementFile("bad.csv", Buffer.from("Date,Amount\n32/05/2026,1.00\n21/05/2026,1.001\n"));
    expect(bad.errors).toEqual([
      'Row 2: "32/05/2026" isn\'t a date.',
      'Row 3: "1.001" has more than 2 decimal places.',
    ]);
  });

  it("CSV without headings: the date and amount columns are found from the values", () => {
    const file = readStatementFile("x.csv", Buffer.from("20/05/2026,KOBE LTD,115.00\n21/05/2026,Z ENERGY,-46.00\n"));
    expect(file.table?.layout.headerRow).toBe(-1);
    expect(file.lines.map((line) => [line.date, line.amount, line.description])).toEqual([
      ["2026-05-20", "115.00", "KOBE LTD"],
      ["2026-05-21", "-46.00", "Z ENERGY"],
    ]);
  });

  it("BK3: an Excel (.xlsx) file with dates as Excel serial numbers", () => {
    const file = readStatementFile(
      "statement.xlsx",
      xlsx([
        ["Date", "Amount", "Payee", "Particulars"],
        [46162, 115, "KOBE LTD", "INV-0001"],
        [46163, -46, "Z ENERGY & CO", ""],
        [46164, -500, "TRANSFER", "SAVINGS"],
      ]),
    );
    expect(file.format).toBe("xlsx");
    expect(file.errors).toEqual([]);
    expect(dateAndAmount(file.lines)).toEqual(BK1);
    expect(file.lines[1].payee).toBe("Z ENERGY & CO");
    expect(() => readStatementFile("old.xls", Buffer.from("not a zip"))).toThrow("Older Excel files (.xls) aren't supported");
  });

  it("BK3: OFX (SGML without closing tags) keeps the bank's FITIDs and the closing balance", () => {
    const ofx = `OFXHEADER:100
DATA:OFXSGML

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>NZD
<BANKACCTFROM><BANKID>12<ACCTID>12-3456-7890123-00<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20260501
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260520120000[+12:NZST]<TRNAMT>115.00<FITID>A1<NAME>KOBE LTD<MEMO>INV-0001
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260521<TRNAMT>-46.00<FITID>A2<NAME>Z ENERGY
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260522<TRNAMT>-500.00<FITID>A3<NAME>TRANSFER<MEMO>SAVINGS
</BANKTRANLIST><LEDGERBAL><BALAMT>1569.00<DTASOF>20260522</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    const file = readStatementFile("statement.ofx", Buffer.from(ofx));
    expect(file.format).toBe("ofx");
    expect(file.errors).toEqual([]);
    expect(dateAndAmount(file.lines)).toEqual(BK1);
    expect(file.lines.map((line) => line.externalId)).toEqual(["ofx:A1", "ofx:A2", "ofx:A3"]);
    expect(file.lines[0]).toMatchObject({ description: "KOBE LTD INV-0001", payee: "KOBE LTD" });
    expect(file.closingBalance).toEqual({ amount: "1569.00", date: "2026-05-22" });
    expect(file.accountNumber).toBe("12-3456-7890123-00");
    // OFX 2 (XML) reads the same.
    const xml = `<?xml version="1.0"?><?OFX OFXHEADER="200"?><OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260521</DTPOSTED><TRNAMT>-86.25</TRNAMT><FITID>C1</FITID><NAME>CAFE &amp; CO</NAME></STMTTRN>
</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;
    expect(readStatementFile("card.qfx", Buffer.from(xml)).lines).toEqual([
      expect.objectContaining({ date: "2026-05-21", amount: "-86.25", payee: "CAFE & CO", externalId: "ofx:C1" }),
    ]);
  });

  it("BK3: QIF, day first", () => {
    const qif = `!Type:Bank
D20/05/2026
T115.00
PKOBE LTD
MINV-0001
^
D21/05/2026
T-46.00
PZ ENERGY
^
D22/05'26
T-500.00
PTRANSFER
^
`;
    const file = readStatementFile("statement.qif", Buffer.from(qif));
    expect(file.format).toBe("qif");
    expect(file.errors).toEqual([]);
    expect(dateAndAmount(file.lines)).toEqual(BK1);
    expect(file.lines[0].description).toBe("KOBE LTD INV-0001");
  });

  it("BK3: ISO 20022 CAMT.053, booked entries only", () => {
    const entry = (amount: string, direction: string, date: string, name: string, ref: string, status = "BOOK") => `
      <Ntry><NtryRef>${ref}</NtryRef><Amt Ccy="NZD">${amount}</Amt><CdtDbtInd>${direction}</CdtDbtInd><Sts><Cd>${status}</Cd></Sts>
        <BookgDt><Dt>${date}</Dt></BookgDt><AcctSvcrRef>${ref}</AcctSvcrRef>
        <NtryDtls><TxDtls><RltdPties><${direction === "CRDT" ? "Dbtr" : "Cdtr"}><Nm>${name}</Nm></${direction === "CRDT" ? "Dbtr" : "Cdtr"}></RltdPties>
        <RmtInf><Ustrd>${name === "KOBE LTD" ? "INV-0001" : ""}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`;
    const camt = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
      <Acct><Id><Othr><Id>123456789</Id></Othr></Id></Acct>
      <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="NZD">1569.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-05-22</Dt></Dt></Bal>
      ${entry("115.00", "CRDT", "2026-05-20", "KOBE LTD", "E1")}
      ${entry("46.00", "DBIT", "2026-05-21", "Z ENERGY", "E2")}
      ${entry("500.00", "DBIT", "2026-05-22", "TRANSFER", "E3")}
      ${entry("9.99", "DBIT", "2026-05-23", "PENDING", "E4", "PDNG")}
    </Stmt></BkToCstmrStmt></Document>`;
    const file = readStatementFile("statement.xml", Buffer.from(camt));
    expect(file.format).toBe("camt053");
    expect(file.errors).toEqual([]);
    expect(dateAndAmount(file.lines)).toEqual(BK1);
    expect(file.lines[0]).toMatchObject({ payee: "KOBE LTD", description: "KOBE LTD INV-0001", externalId: "camt:E1" });
    expect(file.closingBalance).toEqual({ amount: "1569.00", date: "2026-05-22" });
  });

  it("BK3: MT940", () => {
    const mt940 = `:20:STATEMENT
:25:123456789
:28C:1/1
:60F:C260519NZD1000,00
:61:2605200520C115,00NTRFINV-0001//B1
:86:KOBE LTD
:61:2605210521D46,00NTRFNONREF//B2
:86:Z ENERGY
:61:2605220522D500,00NTRFNONREF//B3
:86:TRANSFER SAVINGS
:62F:C260522NZD569,00
-`;
    const file = readStatementFile("statement.sta", Buffer.from(mt940));
    expect(file.format).toBe("mt940");
    expect(file.errors).toEqual([]);
    expect(dateAndAmount(file.lines)).toEqual(BK1);
    expect(file.lines[0]).toMatchObject({ description: "KOBE LTD", reference: "INV-0001" });
    expect(file.lines[1].reference).toBeNull();
    expect(file.closingBalance).toEqual({ amount: "569.00", date: "2026-05-22" });
    expect(file.accountNumber).toBe("123456789");
  });
});
