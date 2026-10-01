/**
 * A tax code's "Available on" (TAO1-TAO12), following NetSuite's tax code
 * field of the same name: Sales Transactions, Purchase Transactions or Both.
 * "Most NetSuite Tax Codes are exclusive to either sales or purchase
 * transactions. However, some are available for both." Tohyee's starting NZ
 * codes (GST, ZERO, EXEMPT, NONE) are Both. It only limits which codes can be
 * chosen; saved documents never change. Shared with the browser, so no
 * server imports here.
 */
export const AVAILABLE_ON = ["sales", "purchases", "both"] as const;
export type AvailableOn = (typeof AVAILABLE_ON)[number];

/** The side of a document line: sales (invoices, receive money) or purchases (bills, spend money). */
export type TaxSide = "sales" | "purchases";

export const AVAILABLE_ON_LABELS: Readonly<Record<AvailableOn, string>> = {
  sales: "Sales",
  purchases: "Purchases",
  both: "Both",
};

/** Whether a code with this "Available on" can be used on this side. */
export function isAvailableOn(availableOn: AvailableOn, side: TaxSide): boolean {
  return availableOn === "both" || availableOn === side;
}

/** "sales only" / "purchases only" (for a code that isn't Both). */
export function onlyWords(availableOn: AvailableOn): string {
  return availableOn === "both" ? "sales and purchases" : `${availableOn} only`;
}

/**
 * The refusal for a line whose code isn't available on its side (TAO2-TAO4,
 * TAO9), naming the code and the side; null when it's fine.
 */
export function sideRefusal(label: string | null, code: string, availableOn: AvailableOn, side: TaxSide): string | null {
  if (isAvailableOn(availableOn, side)) return null;
  const text = `tax code ${code} is available on ${onlyWords(availableOn)}, so it can't be used on ${side}. Choose a tax code available on ${side}.`;
  return label ? `${label}: ${text}` : text.charAt(0).toUpperCase() + text.slice(1);
}

/** The side a bank rule's code must suit: money in is sales, out is purchases, either way both (TAO8). */
export function ruleSides(direction: "any" | "in" | "out"): TaxSide[] {
  return direction === "in" ? ["sales"] : direction === "out" ? ["purchases"] : ["sales", "purchases"];
}

type SideCode = { code: string; isActive: boolean; availableOn: AvailableOn };

/**
 * The tax codes as an editor on one side sees them (TAO6): a code that isn't
 * available on that side counts as not active there, so it's left out of the
 * picker and never chosen as a starting code (the first standard-rated code,
 * an account's usual code, an item's or a contact's code). `offSide` marks it,
 * so a saved line that still has it can show why it will be refused.
 */
export function codesForSide<T extends SideCode>(taxCodes: ReadonlyArray<T>, side: TaxSide): Array<T & { offSide: boolean }> {
  return taxCodes.map((taxCode) => {
    const offSide = !isAvailableOn(taxCode.availableOn, side);
    return { ...taxCode, isActive: taxCode.isActive && !offSide, offSide };
  });
}

/** What a picker shows after a code that can't be chosen: " (inactive)" or " (purchases only)". */
export function unavailableNote(taxCode: { isActive: boolean; availableOn: AvailableOn; offSide?: boolean }): string {
  if (taxCode.offSide) return ` (${onlyWords(taxCode.availableOn)})`;
  return taxCode.isActive ? "" : " (inactive)";
}
