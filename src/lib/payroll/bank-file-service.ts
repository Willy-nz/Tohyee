import { writeAuditEvent } from "@/lib/audit";
import { parseAccountCodeInput } from "@/lib/accounts/service";
import { parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { cmp, dec, isZero, ZERO_DECIMAL } from "@/lib/money/decimal";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { formatNzBankAccount, NZ_BANK_ACCOUNT_SHAPE, parseNzBankAccount } from "@/lib/payroll/bank-account-number";
import { BANK_FILE_FORMAT_LABELS, BANK_FILE_FORMATS, type BankFile, type BankFileFormat, type BankFilePayment, makeBankFile, REFUSED_BANKS } from "@/lib/payroll/bank-files";
import { listWagePayments } from "@/lib/payroll/wage-payments";
import { decryptSecret } from "@/lib/secrets";
import { requireId, requireOneOf } from "@/lib/validation";

/**
 * Bank direct credit files for an approved pay run's unpaid net wages
 * (examples PBF1-PBF7), and each bank account's file settings. Making a
 * file posts nothing and marks nothing paid: the wage payment (P4) does
 * that. Employees' bank accounts are decrypted only here, after the payroll
 * access check, and never logged or put in audit events.
 */

export type BankFileSetting = {
  accountId: string;
  code: string;
  name: string;
  /** Null until an admin sets it up. */
  format: BankFileFormat | null;
  formatLabel: string | null;
  accountNumber: string | null;
  updatedByEmail: string | null;
  updatedAt: string | null;
};

type SettingRow = {
  id: string;
  code: string;
  name: string;
  currency_code: string | null;
  is_active: boolean;
  direct_credit_format: BankFileFormat | null;
  direct_credit_account_number: string | null;
  direct_credit_updated_by_email: string | null;
  direct_credit_updated_at: string | null;
};

const SETTING_SELECT = `
  select a.id::text, a.code, a.name, a.currency_code, a.is_active, s.direct_credit_format, s.direct_credit_account_number,
         s.direct_credit_updated_by_email, s.direct_credit_updated_at::text
    from accounts a left join bank_account_settings s on s.account_id = a.id
   where a.account_type = 'bank'`;

function toSetting(row: SettingRow): BankFileSetting {
  return {
    accountId: row.id,
    code: row.code,
    name: row.name,
    format: row.direct_credit_format,
    formatLabel: row.direct_credit_format ? BANK_FILE_FORMAT_LABELS[row.direct_credit_format] : null,
    accountNumber: row.direct_credit_account_number,
    updatedByEmail: row.direct_credit_updated_by_email,
    updatedAt: row.direct_credit_updated_at,
  };
}

function isBaseCurrency(tx: OrgTx, row: SettingRow): boolean {
  return row.currency_code === null || row.currency_code === tx.baseCurrency;
}

export type BankFileSettings = {
  accounts: BankFileSetting[];
  formats: Array<{ format: BankFileFormat; label: string }>;
  refused: ReadonlyArray<{ bank: string; reason: string }>;
};

/** Active bank accounts in the base currency, with their bank file settings (PBF7). Bookkeepers and above. */
export async function listBankFileSettings(tx: OrgTx): Promise<BankFileSettings> {
  const result = await tx.query<SettingRow>(`${SETTING_SELECT} and a.is_active order by a.code`);
  return {
    accounts: result.rows.filter((row) => isBaseCurrency(tx, row)).map(toSetting),
    formats: BANK_FILE_FORMATS.map((format) => ({ format, label: BANK_FILE_FORMAT_LABELS[format] })),
    refused: REFUSED_BANKS,
  };
}

/**
 * Sets (or, with format null, clears) a bank account's file format and
 * account number (PBF7). The route checks the caller is an admin.
 */
export async function setBankFileSetting(tx: OrgTx, accountIdInput: unknown, input: { format?: unknown; accountNumber?: unknown }): Promise<BankFileSetting> {
  const accountId = requireId(accountIdInput, "accountId");
  const found = await tx.query<SettingRow>(`${SETTING_SELECT} and a.id = $1`, [accountId]);
  const row = found.rows[0];
  if (!row) throw new NotFoundError("That bank account wasn't found.");
  if (!row.is_active) throw new ValidationError(`${row.code} (${row.name}) is archived.`);
  if (!isBaseCurrency(tx, row)) throw new ValidationError(`${row.code} (${row.name}) is in ${row.currency_code}. Bank files pay wages in ${tx.baseCurrency} only.`);
  let format: BankFileFormat | null = null;
  let accountNumber: string | null = null;
  if (input.format !== null && input.format !== undefined && input.format !== "") {
    const refused = REFUSED_BANKS.find((bank) => typeof input.format === "string" && input.format.toLowerCase() === bank.bank.toLowerCase());
    if (refused) throw new ValidationError(refused.reason);
    format = requireOneOf(input.format, "format", BANK_FILE_FORMATS);
    const parsed = typeof input.accountNumber === "string" ? parseNzBankAccount(input.accountNumber) : null;
    if (!parsed) throw new ValidationError(`Enter ${row.code}'s New Zealand bank account number (${NZ_BANK_ACCOUNT_SHAPE}).`);
    accountNumber = formatNzBankAccount(parsed);
  }
  await tx.query(
    `insert into bank_account_settings (account_id, direct_credit_format, direct_credit_account_number, direct_credit_updated_by_email, direct_credit_updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (account_id) do update
        set direct_credit_format = excluded.direct_credit_format,
            direct_credit_account_number = excluded.direct_credit_account_number,
            direct_credit_updated_by_email = excluded.direct_credit_updated_by_email,
            direct_credit_updated_at = excluded.direct_credit_updated_at,
            updated_at = now()`,
    [accountId, format, accountNumber, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "bank_file_settings.changed",
    entityType: "account",
    entityId: accountId,
    details: { code: row.code, format },
  });
  const updated = await tx.query<SettingRow>(`${SETTING_SELECT} and a.id = $1`, [accountId]);
  return toSetting(updated.rows[0]);
}

export type PayRunBankFile = BankFile & { payRunReference: string; bankAccountCode: string; format: BankFileFormat; dueDate: string };

/**
 * Makes the bank file for an approved pay run's unpaid net wages (PBF1-PBF6):
 * each employee's unpaid net pay, from the chosen bank account, in its
 * bank's format. Nothing is posted or marked paid.
 */
export async function makePayRunBankFile(
  tx: OrgTx,
  runIdInput: unknown,
  input: { bankAccountCode?: unknown; dueDate?: unknown; statementLines?: unknown },
): Promise<PayRunBankFile> {
  await requirePayrollAccess(tx);
  const payments = await listWagePayments(tx, runIdInput);
  const reference = payments.reference;
  if (payments.payRunStatus === "draft") throw new ConflictError(`${reference} is a draft, so it has no bank file. Approve it first.`);
  if (payments.payRunStatus === "voided") throw new ConflictError(`${reference} is voided, so it has no bank file.`);
  const code = parseAccountCodeInput(input.bankAccountCode, "bankAccountCode");
  const dueDate = input.dueDate === undefined || input.dueDate === null || input.dueDate === "" ? payments.payDate : parseIsoDate(input.dueDate, "Due date");
  const statementLines = requireOneOf(input.statementLines ?? "one", "statementLines", ["one", "each"] as const);

  const found = await tx.query<SettingRow>(`${SETTING_SELECT} and lower(a.code) = lower($1)`, [code]);
  const bank = found.rows[0];
  if (!bank) throw new ValidationError(`There's no bank account with the code ${code}.`);
  if (!bank.is_active) throw new ValidationError(`${bank.code} (${bank.name}) is archived.`);
  if (!isBaseCurrency(tx, bank)) throw new ValidationError(`${bank.code} (${bank.name}) is in ${bank.currency_code}. Bank files pay wages in ${tx.baseCurrency} only.`);
  if (!bank.direct_credit_format || !bank.direct_credit_account_number) {
    throw new ValidationError(`Set up ${bank.code} (${bank.name}) for bank files first: an admin enters its account number and bank under Settings › Bank files.`);
  }

  if (isZero(dec(payments.unpaid))) throw new ConflictError(`Nothing is left to pay on ${reference}.`);
  if (payments.paidAs === "whole") {
    throw new ConflictError(
      `${reference} has been paid in part as a whole, so Tohyee can't tell whose pay is left. Void that payment, or pay the rest in your bank's own screens.`,
    );
  }
  const owing = payments.employees.filter((entry) => cmp(dec(entry.unpaid), ZERO_DECIMAL) > 0);
  const secrets = await tx.query<{ id: string; bank_account_ciphertext: string | null }>(
    "select id, bank_account_ciphertext from payroll_employees where id = any($1::uuid[])",
    [owing.map((entry) => entry.employeeId)],
  );
  const ciphertexts = new Map(secrets.rows.map((row) => [row.id, row.bank_account_ciphertext]));
  const settings = await getOrganisationSettings(tx);
  const lines: BankFilePayment[] = owing.map((entry) => {
    const ciphertext = ciphertexts.get(entry.employeeId) ?? null;
    if (ciphertext === null) throw new ValidationError(`${entry.name} has no bank account. Add it under Payroll › Employees.`);
    const account = parseNzBankAccount(decryptSecret(ciphertext));
    if (!account) {
      throw new ValidationError(`${entry.name}'s bank account isn't a New Zealand bank account number (${NZ_BANK_ACCOUNT_SHAPE}). Fix it under Payroll › Employees.`);
    }
    return { whose: entry.name, name: entry.name, account, amount: entry.unpaid, particulars: "Wages", code: reference, reference: payments.payDate };
  });
  const file = makeBankFile({
    format: bank.direct_credit_format,
    payerName: settings.displayName,
    payerAccount: parseNzBankAccount(bank.direct_credit_account_number),
    dueDate,
    creationDate: todayIsoDate(),
    payerParticulars: "Wages",
    payerCode: reference,
    payerReference: payments.payDate,
    statementLines,
    fileStem: reference,
    payments: lines,
  });
  // Never an amount or an account number (PBF7, PPAY10).
  await writeAuditEvent(tx, {
    eventType: "payroll_bank_file.made",
    entityType: "payroll_pay_run",
    entityId: payments.payRunId,
    details: { payRunReference: reference, bankAccountCode: bank.code, format: bank.direct_credit_format, dueDate, payments: file.count },
  });
  return { ...file, payRunReference: reference, bankAccountCode: bank.code, format: bank.direct_credit_format, dueDate };
}
