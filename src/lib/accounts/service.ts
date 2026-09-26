import { writeAuditEvent } from "@/lib/audit";
import {
  ACCOUNT_TYPES,
  type AccountClass,
  type AccountType,
  classOfType,
  isAccountType,
  type SystemKey,
} from "@/lib/accounts/types";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { parseCurrencyCode } from "@/lib/money/currency";
import { optionalBoolean, optionalString, requireId, requireString } from "@/lib/validation";

export type Account = {
  id: string;
  code: string;
  name: string;
  accountClass: AccountClass;
  accountType: AccountType;
  description: string | null;
  currencyCode: string | null;
  systemKey: SystemKey | null;
  isActive: boolean;
  hasPostings: boolean;
};

type AccountRow = {
  id: string;
  code: string;
  name: string;
  account_class: AccountClass;
  account_type: AccountType;
  description: string | null;
  currency_code: string | null;
  system_key: SystemKey | null;
  is_active: boolean;
  has_postings: boolean;
};

const ACCOUNT_SELECT = `
  select a.id, a.code, a.name, a.account_class, a.account_type, a.description,
         a.currency_code, a.system_key, a.is_active,
         exists (select 1 from ledger_journal_lines l where l.account_id = a.id) as has_postings
    from accounts a`;

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    accountClass: row.account_class,
    accountType: row.account_type,
    description: row.description,
    currencyCode: row.currency_code,
    systemKey: row.system_key,
    isActive: row.is_active,
    hasPostings: row.has_postings,
  };
}

export const ACCOUNT_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/;

function parseAccountCode(input: unknown, fieldName = "code"): string {
  return requireString(input, fieldName, {
    maxLength: 20,
    pattern: ACCOUNT_CODE_PATTERN,
    patternHint: `${fieldName} must be 1-20 letters, numbers, dots, dashes or underscores.`,
  });
}

function parseAccountType(input: unknown): AccountType {
  if (!isAccountType(input)) {
    throw new ValidationError(`accountType must be one of: ${Object.keys(ACCOUNT_TYPES).join(", ")}.`);
  }
  return input;
}

export async function listAccounts(
  tx: OrgTx,
  options: { includeArchived?: boolean } = {},
): Promise<Account[]> {
  const result = await tx.query<AccountRow>(
    `${ACCOUNT_SELECT}
      where ($1::boolean or a.is_active)
      order by a.code`,
    [options.includeArchived ?? false],
  );
  return result.rows.map(toAccount);
}

async function getAccountById(tx: OrgTx, id: string): Promise<Account> {
  const result = await tx.query<AccountRow>(`${ACCOUNT_SELECT} where a.id = $1`, [id]);
  if (!result.rows[0]) {
    throw new NotFoundError("Account not found.");
  }
  return toAccount(result.rows[0]);
}

function parseAccountCurrency(tx: OrgTx, input: unknown): string | null {
  if (input == null || input === "") {
    return null;
  }
  const code = parseCurrencyCode(input, "currencyCode");
  // Base-currency accounts leave the currency blank.
  return code === tx.baseCurrency ? null : code;
}

export async function createAccount(
  tx: OrgTx,
  input: {
    code: unknown;
    name: unknown;
    accountType: unknown;
    description?: unknown;
    currencyCode?: unknown;
  },
): Promise<Account> {
  const code = parseAccountCode(input.code);
  const name = requireString(input.name, "name", { maxLength: 150 });
  const accountType = parseAccountType(input.accountType);
  const description = optionalString(input.description, "description", { maxLength: 500 });
  const currencyCode = parseAccountCurrency(tx, input.currencyCode);
  const accountClass = classOfType(accountType);
  if (currencyCode && accountClass !== "asset" && accountClass !== "liability") {
    throw new ValidationError("Only asset and liability accounts can hold a foreign currency.");
  }

  const inserted = await tx.query<{ id: string }>(
    `insert into accounts (code, name, account_class, account_type, description, currency_code)
     values ($1, $2, $3, $4, $5, $6)
     on conflict do nothing
     returning id`,
    [code, name, accountClass, accountType, description, currencyCode],
  );
  const id = inserted.rows[0]?.id;
  if (!id) {
    throw new ConflictError(`An account with the code ${code} already exists.`);
  }
  await writeAuditEvent(tx, {
    eventType: "account.created",
    entityType: "account",
    entityId: id,
    details: { code, name, accountType, currencyCode },
  });
  return getAccountById(tx, id);
}

/**
 * Admins can rename, re-code, archive or re-type accounts. Lines point at the
 * account's id, so posted history follows the account. Once an account has
 * postings its class (asset/liability/...) and currency are fixed, because
 * changing them would silently rewrite past reports.
 */
export async function updateAccount(
  tx: OrgTx,
  accountIdInput: unknown,
  input: {
    code?: unknown;
    name?: unknown;
    accountType?: unknown;
    description?: unknown;
    currencyCode?: unknown;
    isActive?: unknown;
  },
): Promise<Account> {
  const accountId = requireId(accountIdInput, "accountId");
  const existing = await getAccountById(tx, accountId);

  const code = input.code === undefined ? existing.code : parseAccountCode(input.code);
  const name =
    input.name === undefined ? existing.name : requireString(input.name, "name", { maxLength: 150 });
  const accountType =
    input.accountType === undefined ? existing.accountType : parseAccountType(input.accountType);
  const description =
    input.description === undefined
      ? existing.description
      : optionalString(input.description, "description", { maxLength: 500 });
  const currencyCode =
    input.currencyCode === undefined ? existing.currencyCode : parseAccountCurrency(tx, input.currencyCode);
  const isActive = optionalBoolean(input.isActive, "isActive") ?? existing.isActive;
  const accountClass = classOfType(accountType);

  if (existing.hasPostings && accountClass !== existing.accountClass) {
    throw new ValidationError(
      `This account has postings, so it has to stay a ${existing.accountClass} account. Create a new account instead.`,
    );
  }
  if (existing.hasPostings && currencyCode !== existing.currencyCode) {
    throw new ValidationError("This account has postings, so its currency can't change.");
  }
  if (currencyCode && accountClass !== "asset" && accountClass !== "liability") {
    throw new ValidationError("Only asset and liability accounts can hold a foreign currency.");
  }
  if (!isActive && existing.systemKey) {
    throw new ValidationError(
      "This account is used by Toeyee for automatic postings, so it can't be archived. Rename it instead.",
    );
  }

  try {
    await tx.query(
      `update accounts
          set code = $2, name = $3, account_class = $4, account_type = $5,
              description = $6, currency_code = $7, is_active = $8, updated_at = now()
        where id = $1`,
      [accountId, code, name, accountClass, accountType, description, currencyCode, isActive],
    );
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new ConflictError(`An account with the code ${code} already exists.`);
    }
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "account.updated",
    entityType: "account",
    entityId: accountId,
    details: { code, name, accountType, currencyCode, isActive },
  });
  return getAccountById(tx, accountId);
}

export type ResolvedAccount = {
  id: string;
  code: string;
  name: string;
  accountClass: AccountClass;
  currencyCode: string | null;
};

/**
 * Looks up accounts by code for a posting. Every code must exist and be active.
 * Codes match case-insensitively.
 */
export async function resolveAccountsByCode(
  tx: OrgTx,
  codes: readonly string[],
): Promise<Map<string, ResolvedAccount>> {
  const wanted = [...new Set(codes.map((code) => code.toLowerCase()))];
  const result = await tx.query<{
    id: string;
    code: string;
    name: string;
    account_class: AccountClass;
    currency_code: string | null;
    is_active: boolean;
  }>(
    `select id, code, name, account_class, currency_code, is_active
       from accounts where lower(code) = any($1::text[])`,
    [wanted],
  );
  const byCode = new Map(result.rows.map((row) => [row.code.toLowerCase(), row]));
  const resolved = new Map<string, ResolvedAccount>();
  for (const code of codes) {
    const row = byCode.get(code.toLowerCase());
    if (!row) {
      throw new ValidationError(`There's no account with the code ${code}.`);
    }
    if (!row.is_active) {
      throw new ValidationError(`Account ${row.code} (${row.name}) is archived and can't take new postings.`);
    }
    resolved.set(code, {
      id: row.id,
      code: row.code,
      name: row.name,
      accountClass: row.account_class,
      currencyCode: row.currency_code,
    });
  }
  return resolved;
}

export function parseAccountCodeInput(input: unknown, fieldName: string): string {
  return parseAccountCode(input, fieldName);
}
