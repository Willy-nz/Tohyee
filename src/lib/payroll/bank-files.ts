import { ValidationError } from "@/lib/errors";
import { add, cmp, dec, type Decimal, mul, significantScale, toFixedString, toPlainString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { type NzBankAccount, suffixNumber, threeDigitSuffix } from "@/lib/payroll/bank-account-number";

/**
 * Bank direct credit files for paying wages (examples PBF1-PBF6), written
 * exactly as each bank's own published specification says
 * (docs/sources/nz-bank-direct-credit-formats.md):
 *
 * - ANZ "Domestic extended format" (comma-separated, CR LF),
 * - ASB FastNet Business Standard Bulk Payments, MT9 (fixed 160-character
 *   records, CR),
 * - BNZ Internet Banking for Business direct credit file, type 7
 *   (comma-delimited, CR LF).
 *
 * Westpac and Kiwibank don't publish a field-level specification, so
 * they're refused rather than guessed. Pure: no database, no network; the
 * caller decrypts employees' bank accounts and never logs them.
 */

export const BANK_FILE_FORMATS = ["anz_domestic_extended", "asb_mt9", "bnz_ib4b"] as const;
export type BankFileFormat = (typeof BANK_FILE_FORMATS)[number];

export const BANK_FILE_FORMAT_LABELS: Record<BankFileFormat, string> = {
  anz_domestic_extended: "ANZ domestic extended",
  asb_mt9: "ASB FastNet MT9",
  bnz_ib4b: "BNZ IB4B",
};

const BANK_NAMES: Record<BankFileFormat, string> = { anz_domestic_extended: "ANZ", asb_mt9: "ASB", bnz_ib4b: "BNZ" };

const REFUSED = "Not supported yet (refused rather than guessed)";

/** Banks Tohyee doesn't make files for, and why (PBF6). */
export const REFUSED_BANKS: ReadonlyArray<{ bank: string; reason: string }> = [
  { bank: "Westpac", reason: `${REFUSED}: Westpac doesn't publish a field-level specification of its payment files. Ask Westpac for it.` },
  { bank: "Kiwibank", reason: `${REFUSED}: Kiwibank doesn't publish a field-level specification of its payment files. Ask Kiwibank for it.` },
];

export type BankFilePayment = {
  /** Whose pay, for messages (e.g. "Kiri Tane"). */
  whose: string;
  /** The payee's name on the file. */
  name: string;
  account: NzBankAccount;
  /** Dollars and cents, e.g. "1657.00". */
  amount: string;
  particulars: string;
  code: string;
  reference: string;
};

export type BankFileInput = {
  format: BankFileFormat;
  payerName: string;
  /** The organisation's own account (ASB and BNZ files carry it; ANZ's doesn't). */
  payerAccount: NzBankAccount | null;
  /** YYYY-MM-DD. */
  dueDate: string;
  creationDate: string;
  payerParticulars: string;
  payerCode: string;
  payerReference: string;
  /** BNZ only: one line on the organisation's statement for the whole file, or one per payment. */
  statementLines: "one" | "each";
  /** The start of the file name, e.g. "PAYRUN-1". */
  fileStem: string;
  payments: BankFilePayment[];
};

export type BankFile = {
  fileName: string;
  contentType: string;
  content: string;
  count: number;
  /** Dollars and cents. */
  total: string;
  hashTotal: string;
};

// Letters, numerals, spaces and ASB's list "( ) * + - = ? [ ] _ { } ~ / & , . '",
// less the comma (ANZ and BNZ: "Fields must not contain commas").
const ALLOWED_CHARACTER = /^[A-Za-z0-9 ()*+\-=?[\]_{}~/&.']$/;

/**
 * Text for a bank file: macrons and other accents dropped (Ōtepoti →
 * Otepoti), anything else outside the allowed characters refused, cut to
 * `width` with no trailing spaces.
 */
function bankText(value: string, width: number, owner: string, field: string, fixWhere: string): string {
  const plain = value.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const bad = [...new Set([...plain].filter((character) => !ALLOWED_CHARACTER.test(character)))];
  if (bad.length > 0) {
    throw new ValidationError(`${owner} ${field} has characters a bank file can't carry (${bad.join(" ")}). Change it under ${fixWhere}.`);
  }
  return plain.trim().slice(0, width).trimEnd();
}

function possessive(name: string): string {
  return `${name}'s`;
}

const HUNDRED = dec("100");

/** Whole cents as digits ("1657.00" → "165700"). */
function cents(amount: Decimal, whose: string): string {
  if (cmp(amount, ZERO_DECIMAL) <= 0) throw new ValidationError(`${whose} amount must be more than zero.`);
  if (significantScale(amount) > 2) throw new ValidationError(`${whose} amount must be in whole cents.`);
  return toPlainString(mul(amount, HUNDRED)).replace(/\.0*$/, "");
}

/**
 * The hash (check) total: the sum of each account's branch and 7-digit
 * account number (bank and suffix ignored), keeping the rightmost 11 digits.
 * Not zero-filled; each format pads it as its specification says.
 */
export function hashTotal(accounts: readonly NzBankAccount[]): string {
  let sum = BigInt(0);
  for (const account of accounts) sum += BigInt(`${account.branch}${account.base}`);
  const digits = sum.toString();
  return digits.length > 11 ? digits.slice(-11).replace(/^0+(?=\d)/, "") : digits;
}

function checkDigits(value: string, width: number, message: string): string {
  if (value.length > width) throw new ValidationError(message);
  return value;
}

function yyyymmdd(date: string): string {
  return date.replace(/-/g, "");
}

function ddmmccyy(date: string): string {
  return `${date.slice(8, 10)}${date.slice(5, 7)}${date.slice(0, 4)}`;
}

function yymmdd(date: string): string {
  return `${date.slice(2, 4)}${date.slice(5, 7)}${date.slice(8, 10)}`;
}

function sixteenDigits(account: NzBankAccount, whose: string, bank: string): string {
  if (suffixNumber(account) > 99) {
    throw new ValidationError(`${whose} account suffix ${account.suffix} can't go in ${bank === "ANZ" ? "an" : "a"} ${bank} file (${bank} takes suffixes up to 99).`);
  }
  return `${account.bank}${account.branch}${account.base}${threeDigitSuffix(account)}`;
}

/** A field padded on the right with spaces to its width (MT9). */
function padRight(value: string, width: number): string {
  return value.padEnd(width, " ");
}

/** A number padded on the left with zeros to its width (MT9). */
function zeroFill(value: string, width: number): string {
  return value.padStart(width, "0");
}

type Prepared = {
  payment: BankFilePayment;
  whose: string;
  cents: string;
  name: string;
  particulars: string;
  code: string;
  reference: string;
};

const LIMITS: Record<BankFileFormat, { amountDigits: number; totalDigits: number; maxCount: number }> = {
  // ANZ: amount and batch total 11 digits, count 5 digits.
  anz_domestic_extended: { amountDigits: 11, totalDigits: 11, maxCount: 99_999 },
  // ASB MT9: amount and total 9(10).
  asb_mt9: { amountDigits: 10, totalDigits: 10, maxCount: 99_999 },
  // BNZ: amount and total 12 digits; 99,998 bulk or 49,999 individualised.
  bnz_ib4b: { amountDigits: 12, totalDigits: 12, maxCount: 99_998 },
};

/** Makes the file, or throws a ValidationError saying what's wrong (PBF1-PBF6). */
export function makeBankFile(input: BankFileInput): BankFile {
  if (!(BANK_FILE_FORMATS as readonly string[]).includes(input.format)) {
    throw new ValidationError(`${REFUSED}: Tohyee makes bank files for ANZ, ASB and BNZ only.`);
  }
  const bank = BANK_NAMES[input.format];
  const limits = LIMITS[input.format];
  if (input.payments.length === 0) throw new ValidationError("There's nothing to pay, so there's no bank file.");
  const maxCount = input.format === "bnz_ib4b" && input.statementLines === "each" ? 49_999 : limits.maxCount;
  if (input.payments.length > maxCount) {
    throw new ValidationError(`${bank} files can hold at most ${maxCount.toLocaleString("en-NZ")} payments.`);
  }
  if ((input.format === "asb_mt9" || input.format === "bnz_ib4b") && !input.payerAccount) {
    throw new ValidationError(`${bank === "ASB" ? "An" : "A"} ${bank} file needs the account it's paid from.`);
  }
  const organisation = "The organisation's";
  const payerName = bankText(input.payerName, 20, organisation, "name", "Settings");
  if (!payerName) throw new ValidationError("The organisation needs a name for the bank file. Add it under Settings.");
  const payerParticulars = bankText(input.payerParticulars, 12, organisation, "particulars", "the bank file");
  const payerCode = bankText(input.payerCode, 12, organisation, "code", "the bank file");
  const payerReference = bankText(input.payerReference, 12, organisation, "reference", "the bank file");

  let total = ZERO_DECIMAL;
  const prepared: Prepared[] = input.payments.map((payment) => {
    const whose = possessive(payment.whose);
    const amount = dec(payment.amount);
    const amountCents = checkDigits(
      cents(amount, whose),
      limits.amountDigits,
      `${whose} amount is too big for ${bank === "ANZ" || bank === "ASB" ? "an" : "a"} ${bank} file (${limits.amountDigits} digits of cents).`,
    );
    total = add(total, amount);
    const name = bankText(payment.name, 20, whose, "name", "Payroll › Employees");
    if (!name) throw new ValidationError(`${whose} name is missing. Add it under Payroll › Employees.`);
    return {
      payment,
      whose,
      cents: amountCents,
      name,
      particulars: bankText(payment.particulars, 12, whose, "particulars", "the bank file"),
      code: bankText(payment.code, 12, whose, "code", "the bank file"),
      reference: bankText(payment.reference, 12, whose, "reference", "the bank file"),
    };
  });
  const totalCents = checkDigits(cents(total, "The file's total"), limits.totalDigits, `The total is too big for one ${bank} file.`);
  const hash = hashTotal(input.payments.map((payment) => payment.account));

  let content: string;
  let extension: string;
  switch (input.format) {
    case "anz_domestic_extended": {
      // Header as ANZ's own example: fields 2-6 empty, due date, creation date, and a comma at the end.
      const lines = [`1,,,,,,${yyyymmdd(input.dueDate)},${yyyymmdd(input.creationDate)},`];
      for (const entry of prepared) {
        lines.push(
          [
            "2",
            sixteenDigits(entry.payment.account, entry.whose, bank),
            "50",
            entry.cents,
            entry.name,
            entry.reference,
            entry.code,
            "",
            entry.particulars,
            payerName,
            payerCode,
            payerReference,
            payerParticulars,
          ].join(","),
        );
      }
      lines.push(["3", totalCents, String(prepared.length), hash].join(","));
      content = lines.map((line) => `${line}\r\n`).join("");
      extension = "csv";
      break;
    }
    case "asb_mt9": {
      const payer = input.payerAccount!;
      const payerSuffix = payer.suffix.length === 2 ? `${payer.suffix} ` : payer.suffix;
      const records = [
        "12" + payer.bank + payer.branch + payer.base + payerSuffix + ddmmccyy(input.dueDate) + " ".repeat(5) + padRight(payerName, 20) + " ".repeat(109),
      ];
      for (const entry of prepared) {
        const account = entry.payment.account;
        records.push(
          "13" +
            account.bank +
            account.branch +
            account.base +
            threeDigitSuffix(account) +
            "052" +
            zeroFill(entry.cents, 10) +
            padRight(entry.name, 20) +
            padRight(entry.code, 12) +
            padRight(entry.code, 12) +
            padRight(entry.reference, 12) +
            padRight(entry.particulars, 12) +
            " " +
            padRight(payerName, 20) +
            padRight(payerCode, 12) +
            padRight(payerReference, 12) +
            padRight(payerParticulars, 12) +
            " ".repeat(4),
        );
      }
      records.push("13" + "99" + zeroFill(hash, 11) + " ".repeat(6) + zeroFill(totalCents, 10) + " ".repeat(129));
      for (const record of records) {
        if (record.length !== 160) throw new Error(`MT9 record is ${record.length} characters, not 160`);
      }
      content = records.map((record) => `${record}\r`).join("");
      extension = "txt";
      break;
    }
    case "bnz_ib4b": {
      if (input.dueDate < input.creationDate) {
        throw new ValidationError(`BNZ won't take a due date before the day the file is made (${input.creationDate}).`);
      }
      const yearLater = `${String(Number(input.creationDate.slice(0, 4)) + 1).padStart(4, "0")}${input.creationDate.slice(4)}`;
      if (input.dueDate > yearLater) {
        throw new ValidationError(`BNZ won't take a due date more than a year after the day the file is made (${input.creationDate}).`);
      }
      const lines = [
        `1,,,,${sixteenDigits(input.payerAccount!, organisation, bank)},7,${yymmdd(input.dueDate)},${yymmdd(input.creationDate)},${input.statementLines === "each" ? "I" : ""}`,
      ];
      for (const entry of prepared) {
        lines.push(
          [
            "2",
            sixteenDigits(entry.payment.account, entry.whose, bank),
            "52",
            entry.cents,
            entry.name,
            entry.reference,
            entry.code,
            "",
            entry.particulars,
            payerName,
            payerCode,
            payerReference,
            payerParticulars,
          ].join(","),
        );
      }
      lines.push(["3", totalCents, String(prepared.length), zeroFill(hash, 11)].join(","));
      content = lines.map((line) => `${line}\r\n`).join("");
      extension = "txt";
      break;
    }
  }
  return {
    fileName: `${input.fileStem} ${bank} ${input.dueDate}.${extension}`,
    contentType: "text/plain; charset=us-ascii",
    content,
    count: prepared.length,
    total: toFixedString(total, 2),
    hashTotal: hash,
  };
}
