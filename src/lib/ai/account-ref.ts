import { type Account, listAccounts } from "@/lib/accounts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";

/**
 * An account for an AI tool, by id or by code (#573, decision 1378): every
 * tool that asks for one account takes either, as list_accounts gives both.
 */

export const ACCOUNT_ID = { type: "string", description: "The account's id (from list_accounts or list_bank_accounts). Or give accountCode." } as const;
export const ACCOUNT_CODE = { type: "string", description: "The account's code, e.g. 200. Or give accountId." } as const;
export const BANK_ACCOUNT_ID = { type: "string", description: "The bank or card account's id (from list_bank_accounts). Or give accountCode." } as const;
export const BANK_ACCOUNT_CODE = { type: "string", description: "The bank or card account's code. Or give accountId." } as const;

const BANK_TYPES = new Set(["bank", "credit_card"]);

function given(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  const text = String(input).trim();
  return text === "" ? null : text;
}

/** Whether the tool's arguments name an account at all. */
export function namesAccount(args: Record<string, unknown>): boolean {
  return given(args.accountId) !== null || given(args.accountCode) !== null;
}

/**
 * The account `accountId` or `accountCode` names (archived ones too). Both
 * may be given only when they're the same account. With `bank`, it must be a
 * bank or credit card account: anything else is refused with a clear reason
 * rather than an empty answer.
 */
export async function accountFromArgs(tx: OrgTx, args: Record<string, unknown>, options: { bank?: boolean } = {}): Promise<Account> {
  const id = given(args.accountId);
  const code = given(args.accountCode);
  if (!id && !code) throw new ValidationError("Give accountId or accountCode.");
  if (id && !/^[1-9]\d{0,17}$/.test(id)) throw new ValidationError("accountId must be a positive whole number. For an account's code, use accountCode.");
  const accounts = await listAccounts(tx, { includeArchived: true });
  const byId = id ? accounts.find((account) => account.id === id) : undefined;
  const byCode = code ? accounts.find((account) => account.code.toLowerCase() === code.toLowerCase()) : undefined;
  if (id && !byId) throw new NotFoundError(`There's no account with the id ${id}.`);
  if (code && !byCode) throw new NotFoundError(`There's no account with the code ${code}.`);
  if (byId && byCode && byId.id !== byCode.id) throw new ValidationError(`accountId ${id} and accountCode ${code} are different accounts. Give one.`);
  const account = (byId ?? byCode)!;
  if (options.bank && !BANK_TYPES.has(account.accountType)) {
    throw new ValidationError(`${account.code} ${account.name} is not a bank or card account. list_bank_accounts lists them.`);
  }
  return account;
}
