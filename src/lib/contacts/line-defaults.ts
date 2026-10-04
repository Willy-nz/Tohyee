/**
 * A contact's default account and tracking on new lines (SD1-SD3), like
 * Xero's contact "Purchase defaults" and "Sales defaults". Shared with the
 * browser, so no server imports here.
 */

type Tags = Record<string, string>;

/** What a contact carries for it (see `ContactDefaults`). */
export type LineDefaultsContact = {
  defaultPurchaseAccountCode: string | null;
  defaultSalesAccountCode: string | null;
  defaultPurchaseTracking: Tags;
  defaultSalesTracking: Tags;
};

/**
 * Fills the contact's default account and tracking into lines that haven't
 * been filled in yet (`isFresh`: by default, no account). Lines someone has
 * filled in keep theirs, so changing a draft's contact doesn't recode it.
 * `accountUsable` says whether an account code can be used (active, and one
 * the line can take); `valueUsable` whether a tracking value can (active).
 * Archived defaults are kept on the contact but not used (SD3).
 */
export function withContactDefaults<T extends { accountCode: string; tracking: Tags }>(
  lines: T[],
  contact: LineDefaultsContact | null | undefined,
  side: "purchase" | "sales",
  accountUsable: (code: string) => boolean,
  valueUsable: (valueId: string) => boolean,
  /** Which lines take the defaults: by default those with no account yet. */
  isFresh: (line: T) => boolean = (line) => !line.accountCode,
): T[] {
  if (!contact) return lines;
  const account = side === "purchase" ? contact.defaultPurchaseAccountCode : contact.defaultSalesAccountCode;
  if (!account || !accountUsable(account)) return lines;
  const raw = side === "purchase" ? contact.defaultPurchaseTracking : contact.defaultSalesTracking;
  const tracking: Tags = {};
  for (const [category, value] of Object.entries(raw ?? {})) if (valueUsable(value)) tracking[category] = value;
  return lines.map((line) => (isFresh(line) ? { ...line, accountCode: account, tracking: { ...tracking, ...line.tracking } } : line));
}

type AccountChoice = { code: string; isActive: boolean };
type TrackingChoices = {
  advancedFeatures: boolean;
  categories: ReadonlyArray<{ isActive: boolean; values: ReadonlyArray<{ id: string; isActive: boolean }> }>;
};

/** The checks `withContactDefaults` needs, from the accounts and tracking a screen already has. */
export function defaultsCheckers<A extends AccountChoice>(
  accounts: readonly A[],
  tracking: TrackingChoices | null | undefined,
  lineTakes: (account: A) => boolean = () => true,
): { accountUsable: (code: string) => boolean; valueUsable: (valueId: string) => boolean } {
  const usableCodes = new Set(accounts.filter((account) => account.isActive && lineTakes(account)).map((account) => account.code.toLowerCase()));
  const usableValues = new Set(
    tracking?.advancedFeatures
      ? tracking.categories.filter((category) => category.isActive).flatMap((category) => category.values.filter((value) => value.isActive).map((value) => value.id))
      : [],
  );
  return { accountUsable: (code) => usableCodes.has(code.toLowerCase()), valueUsable: (valueId) => usableValues.has(valueId) };
}
