import { describe, expect, it } from "vitest";
import { readStatementFile } from "@/lib/bank/formats";
import { carryingValueOut, convertAtRate, impliedRate, lastRateOnOrBefore, type RateUsed } from "@/lib/ledger/foreign";

/** The pure pieces of examples FXB1-FXB11 (foreign-currency bank accounts). */
describe("foreign-currency amounts", () => {
  it("D2, FXB2, FXB3: foreign amount x rate, with the full rate, rounded once half away from zero", () => {
    expect(convertAtRate("1000.00", "1.6543")).toBe("1654.30");
    expect(convertAtRate("50.00", "1.66")).toBe("83.00");
    expect(convertAtRate("50.00", "1.6543")).toBe("82.72"); // 82.715
    expect(convertAtRate("-50.00", "1.6543")).toBe("-82.72");
    expect(convertAtRate("10.01", "1.5")).toBe("15.02"); // 15.015
    expect(convertAtRate("20.02", "1.5")).toBe("30.03");
    expect(convertAtRate("1.00", "1.12345678")).toBe("1.12");
  });

  it("FXB6: the rate of a transfer in is NZD / foreign, to 8 decimal places", () => {
    expect(impliedRate("1000.00", "610.00")).toBe("1.63934426");
    expect(impliedRate("820.00", "500.00")).toBe("1.64");
  });

  it("FXB5, FXB8: money leaves at its carrying value; everything left takes the whole NZD balance", () => {
    const account = { baseBalance: "3171.30", foreignBalance: "1950.00", currencyCode: "USD", code: "1030" };
    expect(carryingValueOut(account, "500.00")).toBe("813.15");
    expect(carryingValueOut({ ...account, baseBalance: "3358.15", foreignBalance: "2060.00" }, "2060.00")).toBe("3358.15");
    expect(() => carryingValueOut(account, "1950.01")).toThrow("Account 1030 holds USD 1950.00, so USD 1950.01 can't be transferred out of it.");
    // Weighted average (W3): three equal thirds of 10.00 leave as 3.33, 3.34 and 3.33.
    expect(carryingValueOut({ ...account, baseBalance: "10.00", foreignBalance: "3.00" }, "1.00")).toBe("3.33");
    expect(carryingValueOut({ ...account, baseBalance: "6.67", foreignBalance: "2.00" }, "1.00")).toBe("3.34");
    expect(carryingValueOut({ ...account, baseBalance: "3.33", foreignBalance: "1.00" }, "1.00")).toBe("3.33");
  });

  it("D4, FXB3, FXB7: the rate shown is the last one used on or before the line's date", () => {
    const rates: RateUsed[] = [
      { rate: "1.64", date: "2026-07-31", source: "revaluation" },
      { rate: "1.63934426", date: "2026-07-20", source: "posted" },
      { rate: "1.66", date: "2026-07-05", source: "posted" },
      { rate: "1.6543", date: "2026-07-03", source: "posted" },
    ];
    expect(lastRateOnOrBefore(rates, "2026-08-05")?.rate).toBe("1.64");
    expect(lastRateOnOrBefore(rates, "2026-07-05")?.rate).toBe("1.66");
    expect(lastRateOnOrBefore(rates, "2026-07-04")?.rate).toBe("1.6543");
    expect(lastRateOnOrBefore(rates, "2026-07-02")).toBeNull();
    expect(lastRateOnOrBefore(undefined, "2026-07-02")).toBeNull();
  });
});

describe("FXB10: the currency a statement file says it's in", () => {
  it("OFX CURDEF, CAMT.053 Ccy, MT940 balances", () => {
    const ofx = `OFXHEADER:100\n<OFX><STMTRS><CURDEF>usd\n<BANKTRANLIST><STMTTRN><DTPOSTED>20260703<TRNAMT>1000.00<FITID>A1<NAME>ETSY</STMTTRN></BANKTRANLIST></STMTRS></OFX>`;
    expect(readStatementFile("s.ofx", Buffer.from(ofx)).currencies).toEqual(["USD"]);
    const camt = `<Document><BkToCstmrStmt><Stmt><Acct><Id><IBAN>X</IBAN></Id><Ccy>USD</Ccy></Acct>
      <Ntry><NtryRef>1</NtryRef><Amt Ccy="USD">10.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-07-03</Dt></BookgDt></Ntry>
      </Stmt></BkToCstmrStmt></Document>`;
    expect(readStatementFile("s.xml", Buffer.from(camt)).currencies).toEqual(["USD"]);
    const mt940 = `:20:S\n:25:1\n:28C:1/1\n:60F:C260702USD1000,00\n:61:2607030703C1000,00NTRFNONREF//B1\n:86:ETSY\n:62F:C260703USD2000,00\n-`;
    expect(readStatementFile("s.sta", Buffer.from(mt940)).currencies).toEqual(["USD"]);
    const qif = `!Type:Bank\nD03/07/2026\nT1000.00\nPETSY\n^\n`;
    expect(readStatementFile("s.qif", Buffer.from(qif)).currencies).toEqual([]);
  });

  it("CSV: a currency column or an amount heading like Amount (USD); none when it doesn't say", () => {
    const column = readStatementFile("s.csv", Buffer.from("Date,Amount,Payee,Currency\n03/07/2026,1000.00,ETSY,usd\n05/07/2026,-50.00,AWS,NZD\n"));
    expect(column.currencies).toEqual(["NZD", "USD"]);
    expect(column.table?.layout.columns.currency).toBe("Currency");
    expect(readStatementFile("s.csv", Buffer.from("Date,Amount (USD),Payee\n03/07/2026,1000.00,ETSY\n")).currencies).toEqual(["USD"]);
    expect(readStatementFile("s.csv", Buffer.from("Date,Amount,Payee\n03/07/2026,1000.00,ETSY\n")).currencies).toEqual([]);
    expect(readStatementFile("s.csv", Buffer.from("Date,Amount,Payee,Currency\n03/07/2026,1000.00,ETSY,US DOLLARS\n")).errors).toEqual([
      'Row 2: "US DOLLARS" isn\'t a currency code.',
    ]);
  });
});
