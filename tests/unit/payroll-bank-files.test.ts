import { describe, expect, it } from "vitest";
import { formatNzBankAccount, maskBankAccount, parseNzBankAccount } from "@/lib/payroll/bank-account-number";
import { type BankFileInput, type BankFilePayment, hashTotal, makeBankFile, REFUSED_BANKS } from "@/lib/payroll/bank-files";

/**
 * Examples PBF1-PBF4 and PBF6 in docs/ACCOUNTING-EXAMPLES.md ("NZ payroll —
 * bank files for paying wages", not yet approved by Jess). The expected
 * files are written out by hand from each bank's specification
 * (docs/sources/nz-bank-direct-credit-formats.md), not from the code.
 */

const CRLF = "\r\n";
const CR = "\r";
const sp = (count: number) => " ".repeat(count);

function account(text: string) {
  const parsed = parseNzBankAccount(text);
  if (!parsed) throw new Error(`not an account: ${text}`);
  return parsed;
}

function payment(whose: string, accountText: string, amount: string, run = "PAYRUN-1"): BankFilePayment {
  return { whose, name: whose, account: account(accountText), amount, particulars: "Wages", code: run, reference: "2026-10-14" };
}

// PAYRUN-1 (PRUN1), employees by last name.
const KIRI = payment("Kiri Tane", "12-3191-0654321-01", "1657.00");
const HEMI = payment("Hemi Walker", "01-0242-0123456-00", "2042.50");
const AROHA = payment("Aroha Ngata", "02-0108-0987654-000", "2590.50", "PAYRUN-2");

function input(format: BankFileInput["format"], overrides: Partial<BankFileInput> = {}): BankFileInput {
  return {
    format,
    payerName: "Harbour Cafe Ltd",
    payerAccount: null,
    dueDate: "2026-10-14",
    creationDate: "2026-10-13",
    payerParticulars: "Wages",
    payerCode: "PAYRUN-1",
    payerReference: "2026-10-14",
    statementLines: "one",
    fileStem: "PAYRUN-1",
    payments: [KIRI, HEMI],
    ...overrides,
  };
}

describe("NZ bank account numbers (PBF6)", () => {
  it("reads bank, branch, account and a 2- or 3-digit suffix, with or without hyphens or spaces", () => {
    expect(parseNzBankAccount("12-3191-0654321-01")).toEqual({ bank: "12", branch: "3191", base: "0654321", suffix: "01" });
    expect(parseNzBankAccount("02-0108-0987654-000")).toEqual({ bank: "02", branch: "0108", base: "0987654", suffix: "000" });
    expect(parseNzBankAccount(" 12 3191 0654321 01 ")).toEqual({ bank: "12", branch: "3191", base: "0654321", suffix: "01" });
    expect(parseNzBankAccount("123191065432101")).toEqual({ bank: "12", branch: "3191", base: "0654321", suffix: "01" });
    expect(parseNzBankAccount("0201080987654000")).toEqual({ bank: "02", branch: "0108", base: "0987654", suffix: "000" });
    expect(formatNzBankAccount(account("0201080987654000"))).toBe("02-0108-0987654-000");
  });

  it("refuses anything else", () => {
    for (const bad of ["12-3191-065432-01", "12-3191-06543210-01", "1-3191-0654321-01", "12-3191-0654321-1", "12-3191-0654321-0001", "12319106543210", "12-3191-0654321-0a", "", "IBAN"]) {
      expect(parseNzBankAccount(bad), bad).toBeNull();
    }
  });

  it("masks all but the last 3 digits (PSLIP1)", () => {
    expect(maskBankAccount("01-0242-0123456-00")).toBe("**-****-******6-00");
    expect(maskBankAccount("0201080987654000")).toBe("**-****-*******-000");
    expect(maskBankAccount("not a number 98765")).toBe("***765");
    expect(maskBankAccount("12")).toBe("***");
  });
});

describe("hash totals", () => {
  it("adds the branch and 7-digit account of each, keeping the rightmost 11 digits", () => {
    expect(hashTotal([KIRI.account, HEMI.account])).toBe("34330777777");
    expect(hashTotal([AROHA.account])).toBe("1080987654");
    // Over 11 digits: the digits on the left are dropped (ASB's own example: 123456789123 → 23456789123).
    const big = account("99-9999-9999999-99");
    expect(hashTotal([big, big])).toBe("99999999998");
  });
});

describe("ANZ domestic extended format (PBF1, PBF4)", () => {
  it("PBF1: PAYRUN-1 byte for byte", () => {
    const file = makeBankFile(input("anz_domestic_extended"));
    expect(file.content).toBe(
      [
        "1,,,,,,20261014,20261013,",
        "2,1231910654321001,50,165700,Kiri Tane,2026-10-14,PAYRUN-1,,Wages,Harbour Cafe Ltd,PAYRUN-1,2026-10-14,Wages",
        "2,0102420123456000,50,204250,Hemi Walker,2026-10-14,PAYRUN-1,,Wages,Harbour Cafe Ltd,PAYRUN-1,2026-10-14,Wages",
        "3,369950,2,34330777777",
      ].join(CRLF) + CRLF,
    );
    expect(file).toMatchObject({ fileName: "PAYRUN-1 ANZ 2026-10-14.csv", count: 2, total: "3699.50", hashTotal: "34330777777" });
  });

  it("PBF4: a hash total under 11 digits isn't zero-filled; PBF5: one employee left to pay", () => {
    const file = makeBankFile(input("anz_domestic_extended", { payments: [AROHA], payerCode: "PAYRUN-2", fileStem: "PAYRUN-2" }));
    expect(file.content.split(CRLF)[2]).toBe("3,259050,1,1080987654");
    const kiriOnly = makeBankFile(input("anz_domestic_extended", { payments: [KIRI] }));
    expect(kiriOnly.content.split(CRLF)[2]).toBe("3,165700,1,31910654321");
  });
});

describe("ASB FastNet MT9 (PBF2, PBF4)", () => {
  it("PBF2: PAYRUN-1 byte for byte, 160 characters a record, CR after each", () => {
    const file = makeBankFile(input("asb_mt9", { payerAccount: account("12-3011-0333444-00") }));
    const header = "12" + "12" + "3011" + "0333444" + "00 " + "14102026" + sp(5) + "Harbour Cafe Ltd" + sp(4) + sp(109);
    const kiri =
      "13" + "12" + "3191" + "0654321" + "001" + "052" + "0000165700" + "Kiri Tane" + sp(11) + "PAYRUN-1" + sp(4) + "PAYRUN-1" + sp(4) +
      "2026-10-14" + sp(2) + "Wages" + sp(7) + sp(1) + "Harbour Cafe Ltd" + sp(4) + "PAYRUN-1" + sp(4) + "2026-10-14" + sp(2) + "Wages" + sp(7) + sp(4);
    const hemi =
      "13" + "01" + "0242" + "0123456" + "000" + "052" + "0000204250" + "Hemi Walker" + sp(9) + "PAYRUN-1" + sp(4) + "PAYRUN-1" + sp(4) +
      "2026-10-14" + sp(2) + "Wages" + sp(7) + sp(1) + "Harbour Cafe Ltd" + sp(4) + "PAYRUN-1" + sp(4) + "2026-10-14" + sp(2) + "Wages" + sp(7) + sp(4);
    const trailer = "13" + "99" + "34330777777" + sp(6) + "0000369950" + sp(129);
    for (const record of [header, kiri, hemi, trailer]) expect(record).toHaveLength(160);
    expect(file.content).toBe(header + CR + kiri + CR + hemi + CR + trailer + CR);
    expect(file).toMatchObject({ fileName: "PAYRUN-1 ASB 2026-10-14.txt", count: 2, total: "3699.50", hashTotal: "34330777777" });
  });

  it("PBF4: the check total is a fixed 11 digits, zero-filled", () => {
    const file = makeBankFile(input("asb_mt9", { payerAccount: account("12-3011-0333444-00"), payments: [AROHA] }));
    const trailer = file.content.split(CR)[2];
    expect(trailer).toBe("13" + "99" + "01080987654" + sp(6) + "0000259050" + sp(129));
  });
});

describe("BNZ IB4B direct credit (PBF3, PBF4)", () => {
  const bnz = account("02-0100-0555666-000");

  it("PBF3: PAYRUN-1 byte for byte, one line on our statement", () => {
    const file = makeBankFile(input("bnz_ib4b", { payerAccount: bnz }));
    expect(file.content).toBe(
      [
        "1,,,,0201000555666000,7,261014,261013,",
        "2,1231910654321001,52,165700,Kiri Tane,2026-10-14,PAYRUN-1,,Wages,Harbour Cafe Ltd,PAYRUN-1,2026-10-14,Wages",
        "2,0102420123456000,52,204250,Hemi Walker,2026-10-14,PAYRUN-1,,Wages,Harbour Cafe Ltd,PAYRUN-1,2026-10-14,Wages",
        "3,369950,2,34330777777",
      ].join(CRLF) + CRLF,
    );
    expect(file.fileName).toBe("PAYRUN-1 BNZ 2026-10-14.txt");
    const each = makeBankFile(input("bnz_ib4b", { payerAccount: bnz, statementLines: "each" }));
    expect(each.content.split(CRLF)[0]).toBe("1,,,,0201000555666000,7,261014,261013,I");
    expect(each.content.split(CRLF).slice(1)).toEqual(file.content.split(CRLF).slice(1));
  });

  it("PBF4: one employee, the hash total zero-filled to 11 digits", () => {
    const file = makeBankFile(
      input("bnz_ib4b", { payerAccount: bnz, statementLines: "each", payments: [AROHA], payerCode: "PAYRUN-2", fileStem: "PAYRUN-2" }),
    );
    expect(file.content).toBe(
      [
        "1,,,,0201000555666000,7,261014,261013,I",
        "2,0201080987654000,52,259050,Aroha Ngata,2026-10-14,PAYRUN-2,,Wages,Harbour Cafe Ltd,PAYRUN-2,2026-10-14,Wages",
        "3,259050,1,01080987654",
      ].join(CRLF) + CRLF,
    );
  });

  it("PBF3: refuses a due date before the file is made, or more than a year ahead", () => {
    expect(() => makeBankFile(input("bnz_ib4b", { payerAccount: bnz, dueDate: "2026-10-12" }))).toThrow(
      "BNZ won't take a due date before the day the file is made (2026-10-13).",
    );
    expect(() => makeBankFile(input("bnz_ib4b", { payerAccount: bnz, dueDate: "2027-10-14" }))).toThrow(
      "BNZ won't take a due date more than a year after the day the file is made (2026-10-13).",
    );
    expect(makeBankFile(input("bnz_ib4b", { payerAccount: bnz, dueDate: "2027-10-13" })).count).toBe(2);
  });
});

describe("refused rather than guessed (PBF6)", () => {
  it("Westpac and Kiwibank have no published specification", () => {
    expect(REFUSED_BANKS.map((bank) => bank.bank)).toEqual(["Westpac", "Kiwibank"]);
    for (const bank of REFUSED_BANKS) expect(bank.reason).toMatch(/^Not supported yet \(refused rather than guessed\): /);
    expect(() => makeBankFile(input("westpac" as never))).toThrow("Not supported yet (refused rather than guessed)");
  });

  it("refuses a suffix over 99 in ANZ and BNZ files, but not ASB's", () => {
    const big = payment("Kiri Tane", "12-3191-0654321-100", "1657.00");
    expect(() => makeBankFile(input("anz_domestic_extended", { payments: [big] }))).toThrow(
      "Kiri Tane's account suffix 100 can't go in an ANZ file (ANZ takes suffixes up to 99).",
    );
    expect(() => makeBankFile(input("bnz_ib4b", { payerAccount: account("02-0100-0555666-000"), payments: [big] }))).toThrow(
      "Kiri Tane's account suffix 100 can't go in a BNZ file (BNZ takes suffixes up to 99).",
    );
    const asb = makeBankFile(input("asb_mt9", { payerAccount: account("12-3011-0333444-00"), payments: [big] }));
    expect(asb.content.split(CR)[1].slice(15, 18)).toBe("100");
  });

  it("drops macrons, refuses other characters, and cuts text to the field", () => {
    const macron = makeBankFile(input("anz_domestic_extended", { payments: [{ ...KIRI, name: "Kiri Tāne-Ōtepoti Whānau" }] }));
    expect(macron.content.split(CRLF)[1]).toContain(",Kiri Tane-Otepoti Wh,");
    expect(() => makeBankFile(input("anz_domestic_extended", { payments: [{ ...KIRI, name: "Kiri@Tane" }] }))).toThrow(
      "Kiri Tane's name has characters a bank file can't carry (@). Change it under Payroll › Employees.",
    );
    expect(() => makeBankFile(input("anz_domestic_extended", { payments: [{ ...KIRI, name: "Tane, Kiri" }] }))).toThrow("(,)");
    expect(() => makeBankFile(input("anz_domestic_extended", { payerName: "Harbour Cafe; Ltd" }))).toThrow(
      "The organisation's name has characters a bank file can't carry (;). Change it under Settings.",
    );
    // A cut that ends in a space leaves no trailing space (BNZ: "not trailing spaces").
    const cut = makeBankFile(input("bnz_ib4b", { payerAccount: account("02-0100-0555666-000"), payments: [{ ...KIRI, name: "Kiri Tane Wiremu Hone Te Rangi" }] }));
    expect(cut.content.split(CRLF)[1]).toContain(",Kiri Tane Wiremu Hon,");
    const spaced = makeBankFile(input("bnz_ib4b", { payerAccount: account("02-0100-0555666-000"), payments: [{ ...KIRI, name: "Kiri Tane Wiremu Ho e" }] }));
    expect(spaced.content.split(CRLF)[1]).toContain(",Kiri Tane Wiremu Ho,");
  });

  it("refuses amounts that are zero, negative, have part cents, or don't fit", () => {
    expect(() => makeBankFile(input("anz_domestic_extended", { payments: [{ ...KIRI, amount: "0.00" }] }))).toThrow("Kiri Tane's amount must be more than zero.");
    expect(() => makeBankFile(input("anz_domestic_extended", { payments: [{ ...KIRI, amount: "-1.00" }] }))).toThrow("Kiri Tane's amount must be more than zero.");
    expect(() => makeBankFile(input("anz_domestic_extended", { payments: [{ ...KIRI, amount: "1.005" }] }))).toThrow("whole cents");
    expect(() => makeBankFile(input("asb_mt9", { payerAccount: account("12-3011-0333444-00"), payments: [{ ...KIRI, amount: "100000000.00" }] }))).toThrow(
      "Kiri Tane's amount is too big for an ASB file (10 digits of cents).",
    );
    expect(() => makeBankFile(input("anz_domestic_extended", { payments: [] }))).toThrow("There's nothing to pay, so there's no bank file.");
  });

  it("needs the paying account for ASB and BNZ", () => {
    expect(() => makeBankFile(input("asb_mt9"))).toThrow("An ASB file needs the account it's paid from.");
    expect(() => makeBankFile(input("bnz_ib4b"))).toThrow("A BNZ file needs the account it's paid from.");
  });
});
