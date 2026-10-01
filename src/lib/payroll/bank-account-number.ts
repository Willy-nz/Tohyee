/**
 * New Zealand bank account numbers (examples PBF6, PSLIP1): bank (2 digits),
 * branch (4), account (7) and suffix (2 or 3), the shape every NZ bank's
 * direct credit specification uses (15 or 16 digits). Only the shape is
 * checked: the banks' check-digit rules aren't in Tohyee's sources
 * (question for Jess). Browser-safe: no server imports.
 */

export type NzBankAccount = {
  bank: string;
  branch: string;
  base: string;
  /** As written: 2 or 3 digits. */
  suffix: string;
};

export const NZ_BANK_ACCOUNT_SHAPE = "bank 2 digits, branch 4, account 7, suffix 2 or 3";

/** Reads "12-3191-0654321-01", "12 3191 0654321 01" or 15 or 16 digits; null when it isn't that shape. */
export function parseNzBankAccount(text: string): NzBankAccount | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/[\s-]+/);
  if (parts.length === 4) {
    const [bank, branch, base, suffix] = parts;
    if (/^\d{2}$/.test(bank) && /^\d{4}$/.test(branch) && /^\d{7}$/.test(base) && /^\d{2,3}$/.test(suffix)) {
      return { bank, branch, base, suffix };
    }
    return null;
  }
  if (parts.length === 1 && /^\d{15,16}$/.test(trimmed)) {
    return { bank: trimmed.slice(0, 2), branch: trimmed.slice(2, 6), base: trimmed.slice(6, 13), suffix: trimmed.slice(13) };
  }
  return null;
}

export function formatNzBankAccount(account: NzBankAccount): string {
  return `${account.bank}-${account.branch}-${account.base}-${account.suffix}`;
}

/** The suffix as a number (00 and 000 are both 0). */
export function suffixNumber(account: NzBankAccount): number {
  return Number.parseInt(account.suffix, 10);
}

/** The suffix written as 3 digits (25 → 025), as ANZ's and BNZ's 16-digit form has it. */
export function threeDigitSuffix(account: NzBankAccount): string {
  return account.suffix.padStart(3, "0");
}

/**
 * Everything but the last 3 digits hidden (PSLIP1): 01-0242-0123456-00 →
 * **-****-******6-00. Something that isn't an NZ account number shows only
 * its last 3 digits.
 */
export function maskBankAccount(text: string): string {
  const parsed = parseNzBankAccount(text);
  if (!parsed) {
    const digits = text.replace(/\D/g, "");
    return `***${digits.length > 3 ? digits.slice(-3) : ""}`;
  }
  const formatted = formatNzBankAccount(parsed);
  let keep = 3;
  let masked = "";
  for (let index = formatted.length - 1; index >= 0; index -= 1) {
    const char = formatted[index];
    if (char === "-") masked = char + masked;
    else if (keep > 0) {
      masked = char + masked;
      keep -= 1;
    } else masked = `*${masked}`;
  }
  return masked;
}
