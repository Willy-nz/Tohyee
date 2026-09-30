/**
 * A supplier's default purchase tax code (EX16-EX25), like Xero's contact
 * "Purchase defaults" tax rate and the customer's default sales tax code
 * (EX5). Shared with the browser, so no server imports here.
 */

/** What a contact carries for it. */
export type PurchaseTaxContact = { defaultPurchaseTaxCode: string | null };

type CodeChoice = { code: string; isActive: boolean };

/**
 * The tax code a new purchase line starts with when the contact decides it
 * (EX17-EX19): the contact's own default purchase tax code if it's among the
 * codes the line can take (active ones; a foreign-currency bank line leaves
 * out standard-rated ones). Null means Tohyee's usual default applies (the
 * item's purchase tax code, the account's usual code, or the first active
 * standard-rated code), exactly as before. It's only a starting value: any
 * line can be changed (EX20), and saved documents never change (EX21).
 */
export function contactPurchaseTaxCode(
  contact: PurchaseTaxContact | null | undefined,
  usableCodes: ReadonlyArray<CodeChoice>,
): string | null {
  const code = contact?.defaultPurchaseTaxCode ?? null;
  return code !== null && usableCodes.some((taxCode) => taxCode.code === code && taxCode.isActive) ? code : null;
}
