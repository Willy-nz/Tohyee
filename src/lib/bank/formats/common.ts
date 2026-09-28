import { dec, isZero, significantScale, toFixedString } from "@/lib/money/decimal";

/**
 * Shared pieces for reading bank statement files. Everything here is pure (no
 * database, no network) and works on text, so it can be tested on its own.
 */

/** One transaction read from a file or a bank feed, before it's stored. */
export type ParsedStatementLine = {
  /** YYYY-MM-DD. */
  date: string;
  /** Money in positive, money out negative, 2 decimal places. */
  amount: string;
  description: string;
  payee: string | null;
  particulars: string | null;
  code: string | null;
  reference: string | null;
  balance: string | null;
  /** The bank's own id for the transaction, when the source has one (OFX FITID, Akahu id). */
  externalId: string | null;
};

export type StatementFormat = "csv" | "xlsx" | "ofx" | "qif" | "camt053" | "mt940";

export const STATEMENT_FORMAT_LABELS: Readonly<Record<StatementFormat | "akahu", string>> = {
  csv: "CSV",
  xlsx: "Excel (.xlsx)",
  ofx: "OFX",
  qif: "QIF",
  camt053: "ISO 20022 CAMT.053",
  mt940: "MT940",
  akahu: "Akahu bank feed",
};

export type DateOrder = "dmy" | "mdy" | "ymd";

export class RowError extends Error {}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function isoDate(year: number, month: number, day: number): string | null {
  if (year < 100) year += 2000;
  if (year < 1900 || year > 2999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Excel stores dates as days since 30 December 1899 (the 1900 date system). */
export function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000);
  return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/**
 * Reads a date the way banks write them: 20/05/2026, 20-05-26, 20.5.2026,
 * 2026-05-20 (with or without a time), 20 May 2026, May 20 2026, 20260520,
 * QIF's 20/05'26, and Excel serial numbers. Numeric dates follow `order` (day
 * first in New Zealand) unless the year comes first.
 */
export function parseBankDate(input: string, order: DateOrder = "dmy"): string | null {
  const text = input.trim().replace(/'/g, "/").replace(/\s+/g, " ");
  if (!text) return null;
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(text);
  if (match) return isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{4})(\d{2})(\d{2})(?:\d{0,6}(?:\.\d+)?)?(?:\[.*\])?$/.exec(text);
  if (match) return isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2}|\d{4})(?:[ T].*)?$/.exec(text);
  if (match) {
    const [first, second, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (order === "mdy") return isoDate(year, first, second);
    return isoDate(year, second, first);
  }
  match = /^(\d{1,2})[-/ ]([A-Za-z]{3,9})[-/ ,]*(\d{2}|\d{4})$/.exec(text);
  if (match) {
    const month = MONTHS[match[2].toLowerCase().slice(0, match[2].toLowerCase().startsWith("sept") ? 4 : 3)];
    return month ? isoDate(Number(match[3]), month, Number(match[1])) : null;
  }
  match = /^([A-Za-z]{3,9})[ -](\d{1,2}),?[ -](\d{2}|\d{4})$/.exec(text);
  if (match) {
    const month = MONTHS[match[1].toLowerCase().slice(0, 3)];
    return month ? isoDate(Number(match[3]), month, Number(match[2])) : null;
  }
  if (/^\d{5}(\.\d+)?$/.test(text)) {
    return excelSerialToIso(Number(text));
  }
  return null;
}

/**
 * Reads an amount as banks write it: -46.00, 1,234.56, $46.00, (46.00),
 * 46.00 DR / 46.00 CR, +115.00, and 46,00 when `decimalComma`. Returns a
 * 2-decimal string, or null when the text is empty. Throws RowError for
 * anything else, or for more than 2 decimal places.
 */
export function parseBankAmount(input: string, options: { decimalComma?: boolean } = {}): string | null {
  let text = input.trim();
  if (!text) return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  const suffix = /\s*(DR|CR|D|C)$/i.exec(text);
  if (suffix) {
    if (suffix[1].toUpperCase().startsWith("D")) negative = !negative;
    text = text.slice(0, suffix.index).trim();
  }
  text = text.replace(/^([+-]?)\s*(?:NZ\$|\$|NZD)\s*/i, "$1").replace(/\s*(?:NZD)$/i, "");
  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1).trim();
  } else if (text.startsWith("+")) {
    text = text.slice(1).trim();
  }
  text = text.replace(/^(?:NZ\$|\$)/, "");
  if (options.decimalComma) {
    text = text.replace(/\./g, "").replace(",", ".");
  } else {
    text = text.replace(/,/g, "");
  }
  if (!/^\d+(\.\d+)?$/.test(text) && !/^\.\d+$/.test(text)) {
    throw new RowError(`"${input.trim()}" isn't an amount.`);
  }
  const value = dec(text.startsWith(".") ? `0${text}` : text);
  if (significantScale(value) > 2) {
    throw new RowError(`"${input.trim()}" has more than 2 decimal places.`);
  }
  const fixed = toFixedString(value, 2);
  return negative && !isZero(value) ? `-${fixed}` : fixed;
}

export function cleanText(input: string | null | undefined, maxLength: number): string | null {
  if (input == null) return null;
  const text = input.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > maxLength ? text.slice(0, maxLength).trim() : text;
}

/** A line's description: the bank's description, or its other details joined, never empty. */
export function describe(parts: Array<string | null | undefined>, fallback = "Transaction"): string {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const part of parts) {
    const text = cleanText(part ?? null, 500);
    if (text && !seen.has(text.toLowerCase())) {
      seen.add(text.toLowerCase());
      words.push(text);
    }
  }
  return cleanText(words.join(" "), 500) ?? fallback;
}

/** Decodes a file as UTF-8, falling back to Windows-1252 (common for bank exports). */
export function decodeText(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  return text.replace(/^﻿/, "");
}

export function makeLine(fields: {
  date: string;
  amount: string;
  description?: string | null;
  payee?: string | null;
  particulars?: string | null;
  code?: string | null;
  reference?: string | null;
  balance?: string | null;
  externalId?: string | null;
  extra?: Array<string | null | undefined>;
}): ParsedStatementLine {
  const payee = cleanText(fields.payee, 200);
  const particulars = cleanText(fields.particulars, 100);
  const code = cleanText(fields.code, 100);
  const reference = cleanText(fields.reference, 200);
  return {
    date: fields.date,
    amount: fields.amount,
    description: describe(
      fields.description
        ? [fields.description, ...(fields.extra ?? [])]
        : [payee, particulars, code, reference, ...(fields.extra ?? [])],
    ),
    payee,
    particulars,
    code,
    reference,
    balance: fields.balance ?? null,
    externalId: cleanText(fields.externalId, 200),
  };
}
