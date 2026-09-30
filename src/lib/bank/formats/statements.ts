import {
  type DateOrder,
  makeLine,
  type ParsedStatementLine,
  parseBankAmount,
  parseBankDate,
  RowError,
} from "@/lib/bank/formats/common";
import { decodeXml } from "@/lib/bank/formats/xlsx";

/**
 * Statement file formats that carry their own structure: OFX (and QFX/QBO),
 * QIF, ISO 20022 CAMT.053 and SWIFT MT940. Each returns the transactions,
 * any problems by transaction, and the closing balance when the file has one.
 */
export type StatementReadResult = {
  lines: ParsedStatementLine[];
  errors: string[];
  closingBalance: { amount: string; date: string | null } | null;
  accountNumber: string | null;
  /** Currencies the file says it's in (OFX CURDEF, CAMT.053 Ccy, MT940 balances); empty when it doesn't say. */
  currencies: string[];
};

function codes(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.flatMap((value) => (value && /^[A-Za-z]{3}$/.test(value.trim()) ? [value.trim().toUpperCase()] : [])))].sort();
}

function tag(block: string, name: string): string | null {
  const match = new RegExp(`<${name}>([^<\\r\\n]*)`, "i").exec(block);
  const value = match?.[1]?.trim();
  return value ? decodeXml(value) : null;
}

/** OFX 1.x (SGML, closing tags optional) and 2.x (XML). Amounts are signed from the account holder's side. */
export function readOfx(text: string): StatementReadResult {
  const lines: ParsedStatementLine[] = [];
  const errors: string[] = [];
  const blocks = [...text.matchAll(/<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi)].map((match) => match[1]);
  blocks.forEach((block, index) => {
    const label = `Transaction ${index + 1}`;
    try {
      const posted = tag(block, "DTPOSTED") ?? tag(block, "DTUSER");
      const date = posted ? parseBankDate(posted.slice(0, 8)) : null;
      if (!date) throw new RowError(`has no posted date${posted ? ` ("${posted}")` : ""}.`);
      const amount = parseBankAmount(tag(block, "TRNAMT") ?? "");
      if (amount === null) throw new RowError("has no amount.");
      if (/^-?0\.00$/.test(amount)) return;
      const name = tag(block, "NAME");
      const memo = tag(block, "MEMO");
      const fitId = tag(block, "FITID");
      lines.push(
        makeLine({
          date,
          amount,
          description: [name, memo].filter(Boolean).join(" ") || tag(block, "TRNTYPE") || null,
          payee: name,
          reference: tag(block, "REFNUM") ?? tag(block, "CHECKNUM"),
          externalId: fitId ? `ofx:${fitId}` : null,
        }),
      );
    } catch (error) {
      if (error instanceof RowError) errors.push(`${label} ${error.message}`);
      else throw error;
    }
  });
  const ledger = /<LEDGERBAL>([\s\S]*?)(?:<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>|<\/CCSTMTRS>|$)/i.exec(text)?.[1];
  let closingBalance: StatementReadResult["closingBalance"] = null;
  if (ledger) {
    try {
      const amount = parseBankAmount(tag(ledger, "BALAMT") ?? "");
      const asOf = tag(ledger, "DTASOF");
      if (amount !== null) closingBalance = { amount, date: asOf ? parseBankDate(asOf.slice(0, 8)) : null };
    } catch {
      closingBalance = null;
    }
  }
  if (blocks.length === 0) errors.push("The OFX file has no transactions.");
  return {
    lines,
    errors,
    closingBalance,
    accountNumber: tag(text, "ACCTID"),
    currencies: codes([...text.matchAll(/<CURDEF>\s*([A-Za-z]{3})/gi)].map((match) => match[1])),
  };
}

/**
 * QIF: one field per line (D date, T or U amount, P payee, M memo, N number),
 * each transaction ending with ^. Dates are day first unless the file only
 * makes sense month first, or `dateOrder` says otherwise.
 */
export function readQif(text: string, dateOrder?: DateOrder): StatementReadResult {
  const records: Array<Record<string, string>> = [];
  let current: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("!")) continue;
    if (line.startsWith("^")) {
      if (Object.keys(current).length > 0) records.push(current);
      current = {};
      continue;
    }
    const field = line[0];
    const value = line.slice(1).trim();
    if (field === "M" && current.M) current.M = `${current.M} ${value}`;
    else if (!(field in current)) current[field] = value;
  }
  if (Object.keys(current).length > 0) records.push(current);

  let order = dateOrder;
  if (!order) {
    let dayFirst = false;
    let monthFirst = false;
    for (const record of records) {
      const match = /^(\d{1,2})[/.-](\d{1,2})/.exec(record.D ?? "");
      if (!match) continue;
      if (Number(match[1]) > 12) dayFirst = true;
      if (Number(match[2]) > 12) monthFirst = true;
    }
    order = monthFirst && !dayFirst ? "mdy" : "dmy";
  }
  const lines: ParsedStatementLine[] = [];
  const errors: string[] = [];
  records.forEach((record, index) => {
    const label = `Transaction ${index + 1}`;
    try {
      const date = parseBankDate(record.D ?? "", order);
      if (!date) throw new RowError(`has no date${record.D ? ` ("${record.D}")` : ""}.`);
      const amount = parseBankAmount(record.T ?? record.U ?? "");
      if (amount === null) throw new RowError("has no amount.");
      if (/^-?0\.00$/.test(amount)) return;
      lines.push(
        makeLine({
          date,
          amount,
          description: [record.P, record.M].filter(Boolean).join(" ") || null,
          payee: record.P ?? null,
          reference: record.N ?? null,
        }),
      );
    } catch (error) {
      if (error instanceof RowError) errors.push(`${label} ${error.message}`);
      else throw error;
    }
  });
  if (records.length === 0) errors.push("The QIF file has no transactions.");
  return { lines, errors, closingBalance: null, accountNumber: null, currencies: [] };
}

function xmlValue(xml: string, path: string[]): string | null {
  let scope = xml;
  for (const name of path) {
    const match = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`).exec(scope);
    if (!match) return null;
    scope = match[1];
  }
  const text = decodeXml(scope.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  return text || null;
}

/** ISO 20022 CAMT.053 bank-to-customer statements: booked entries only. */
export function readCamt053(text: string): StatementReadResult {
  const lines: ParsedStatementLine[] = [];
  const errors: string[] = [];
  const entries = [...text.matchAll(/<(?:\w+:)?Ntry\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Ntry>/g)].map((match) => match[1]);
  entries.forEach((entry, index) => {
    const label = `Entry ${index + 1}`;
    try {
      const status = xmlValue(entry, ["Sts", "Cd"]) ?? xmlValue(entry, ["Sts"]);
      if (status && status.toUpperCase() !== "BOOK") return;
      const direction = xmlValue(entry, ["CdtDbtInd"]);
      const rawAmount = /<(?:\w+:)?Amt\b[^>]*>([^<]+)<\/(?:\w+:)?Amt>/.exec(entry)?.[1];
      const unsigned = parseBankAmount(rawAmount ?? "");
      if (unsigned === null) throw new RowError("has no amount.");
      if (direction !== "CRDT" && direction !== "DBIT") throw new RowError("doesn't say whether it's a credit or a debit.");
      const amount = direction === "DBIT" ? `-${unsigned.replace(/^-/, "")}` : unsigned.replace(/^-/, "");
      const dateText = xmlValue(entry, ["BookgDt", "Dt"]) ?? xmlValue(entry, ["BookgDt", "DtTm"]) ?? xmlValue(entry, ["ValDt", "Dt"]);
      const date = dateText ? parseBankDate(dateText.slice(0, 10)) : null;
      if (!date) throw new RowError("has no booking date.");
      const party =
        direction === "CRDT"
          ? xmlValue(entry, ["RltdPties", "Dbtr", "Nm"]) ?? xmlValue(entry, ["RltdPties", "Dbtr", "Pty", "Nm"])
          : xmlValue(entry, ["RltdPties", "Cdtr", "Nm"]) ?? xmlValue(entry, ["RltdPties", "Cdtr", "Pty", "Nm"]);
      const unstructured = [...entry.matchAll(/<(?:\w+:)?Ustrd>([\s\S]*?)<\/(?:\w+:)?Ustrd>/g)].map((match) => decodeXml(match[1]).trim());
      const endToEnd = xmlValue(entry, ["Refs", "EndToEndId"]);
      const reference = xmlValue(entry, ["CdtrRefInf", "Ref"]) ?? (endToEnd && endToEnd !== "NOTPROVIDED" ? endToEnd : null);
      const bankReference = xmlValue(entry, ["AcctSvcrRef"]) ?? xmlValue(entry, ["NtryRef"]);
      lines.push(
        makeLine({
          date,
          amount,
          description: [party, ...unstructured, xmlValue(entry, ["AddtlNtryInf"])].filter(Boolean).join(" ") || null,
          payee: party,
          reference,
          externalId: bankReference ? `camt:${bankReference}` : null,
        }),
      );
    } catch (error) {
      if (error instanceof RowError) errors.push(`${label} ${error.message}`);
      else throw error;
    }
  });
  let closingBalance: StatementReadResult["closingBalance"] = null;
  for (const balance of text.matchAll(/<(?:\w+:)?Bal\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Bal>/g)) {
    const kind = xmlValue(balance[1], ["Tp", "CdOrPrtry", "Cd"]);
    if (kind !== "CLBD") continue;
    try {
      const unsigned = parseBankAmount(/<(?:\w+:)?Amt\b[^>]*>([^<]+)</.exec(balance[1])?.[1] ?? "");
      if (unsigned !== null) {
        const negative = xmlValue(balance[1], ["CdtDbtInd"]) === "DBIT";
        closingBalance = { amount: negative ? `-${unsigned}` : unsigned, date: /<(?:\w+:)?Dt(?:Tm)?>(\d{4}-\d{2}-\d{2})/.exec(balance[1])?.[1] ?? null };
      }
    } catch {
      closingBalance = null;
    }
  }
  if (entries.length === 0) errors.push("The CAMT.053 file has no entries.");
  return {
    lines,
    errors,
    closingBalance,
    accountNumber: xmlValue(text, ["Acct", "Id", "Othr", "Id"]) ?? xmlValue(text, ["Acct", "Id", "IBAN"]),
    currencies: codes([
      ...[...text.matchAll(/<(?:\w+:)?Amt\b[^>]*\bCcy="([A-Za-z]{3})"/g)].map((match) => match[1]),
      xmlValue(text, ["Acct", "Ccy"]),
    ]),
  };
}

/** SWIFT MT940: :61: statement lines with their :86: details, and the :62F: closing balance. */
export function readMt940(text: string): StatementReadResult {
  const fields: Array<{ tag: string; value: string }> = [];
  for (const rawLine of text.replace(/\r/g, "").split("\n")) {
    const match = /^:(\d{2}[A-Z]?):(.*)$/.exec(rawLine);
    if (match) fields.push({ tag: match[1], value: match[2] });
    else if (fields.length > 0 && rawLine.trim() && rawLine.trim() !== "-" && !rawLine.startsWith("{")) {
      fields[fields.length - 1].value += `\n${rawLine}`;
    }
  }
  const lines: ParsedStatementLine[] = [];
  const errors: string[] = [];
  let closingBalance: StatementReadResult["closingBalance"] = null;
  let accountNumber: string | null = null;
  fields.forEach((field, index) => {
    if (field.tag === "25") accountNumber = field.value.trim();
    if (field.tag === "62F" || field.tag === "62M") {
      const match = /^([CD])(\d{6})[A-Z]{3}([\d,]+)/.exec(field.value.trim());
      if (match) {
        const amount = parseBankAmount(match[3], { decimalComma: true }) ?? "0.00";
        closingBalance = {
          amount: match[1] === "D" ? `-${amount}` : amount,
          date: parseBankDate(`20${match[2].slice(0, 2)}-${match[2].slice(2, 4)}-${match[2].slice(4, 6)}`),
        };
      }
    }
    if (field.tag !== "61") return;
    const label = `Statement line ${lines.length + errors.length + 1}`;
    try {
      const [first, ...rest] = field.value.split("\n");
      const match = /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?([\d,]+)([NFS])([A-Z0-9]{3})([^/]*)(?:\/\/(.*))?$/.exec(first.trim());
      if (!match) throw new RowError(`can't be read ("${first.trim()}").`);
      const date = parseBankDate(`20${match[1].slice(0, 2)}-${match[1].slice(2, 4)}-${match[1].slice(4, 6)}`);
      if (!date) throw new RowError("has no valid date.");
      const unsigned = parseBankAmount(match[5], { decimalComma: true });
      if (unsigned === null) throw new RowError("has no amount.");
      const moneyIn = match[3] === "C" || match[3] === "RD";
      const amount = moneyIn ? unsigned : `-${unsigned}`;
      const next = fields[index + 1];
      const details = next?.tag === "86" ? next.value.replace(/\?\d{2}/g, " ").replace(/\n/g, " ") : "";
      const customerReference = match[8].trim();
      lines.push(
        makeLine({
          date,
          amount,
          description: [details, rest.join(" ")].filter((part) => part.trim()).join(" ") || match[7],
          reference: customerReference && customerReference !== "NONREF" ? customerReference : null,
        }),
      );
    } catch (error) {
      if (error instanceof RowError) errors.push(`${label} ${error.message}`);
      else throw error;
    }
  });
  if (!fields.some((field) => field.tag === "61")) errors.push("The MT940 file has no statement lines.");
  const currencies = codes(
    fields.filter((field) => /^6[02][FM]$|^64$|^65$/.test(field.tag)).map((field) => /^[CD]\d{6}([A-Z]{3})/.exec(field.value.trim())?.[1]),
  );
  return { lines, errors, closingBalance, accountNumber, currencies };
}
