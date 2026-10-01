/**
 * The rules for copying a sales platform's values into Tohyee (examples
 * SPC2, SPC3, SPC5, SPC6). Pure, so they're tested on their own.
 */

export type FieldDecision =
  | { kind: "same" }
  | { kind: "apply"; value: string | null }
  /** Tohyee's value stays. `changedInTohyee`: someone changed it since the platform's last value was copied. */
  | { kind: "keep"; changedInTohyee: boolean };

/**
 * Decides one field. `last` is the platform's value when it was last copied
 * (undefined when the record is being linked for the first time).
 *
 * - First link: blank Tohyee values are filled; different ones are kept.
 * - Later: nothing happens unless the platform's value changed. Then it's
 *   applied if Tohyee still has the platform's last value, and Tohyee's is
 *   kept if someone changed it in Tohyee.
 * - The platform having nothing never blanks a Tohyee value on first link.
 */
export function mergeField(input: {
  tohyee: string | null;
  last: string | null | undefined;
  incoming: string | null;
  same?: (a: string, b: string) => boolean;
}): FieldDecision {
  const same = input.same ?? ((a: string, b: string) => a === b);
  const equal = (a: string | null | undefined, b: string | null | undefined): boolean => {
    const left = a ?? null;
    const right = b ?? null;
    return left === null || right === null ? left === right : same(left, right);
  };
  const { tohyee, last, incoming } = input;
  if (equal(tohyee, incoming)) return { kind: "same" };
  if (last === undefined) {
    if (incoming === null) return { kind: "same" };
    if (tohyee === null) return { kind: "apply", value: incoming };
    return { kind: "keep", changedInTohyee: false };
  }
  if (equal(incoming, last)) return { kind: "same" };
  if (equal(tohyee, last)) return { kind: "apply", value: incoming };
  return { kind: "keep", changedInTohyee: true };
}

/** A new item's name: the product's title, then " - " and the variant's title unless it's Shopify's "Default Title". */
export function itemNameFor(productTitle: string, variantTitle: string | null): string {
  const product = productTitle.trim().replace(/\s+/g, " ");
  const variant = variantTitle?.trim().replace(/\s+/g, " ") ?? "";
  const name = variant === "" || variant === "Default Title" ? product : `${product} - ${variant}`;
  return name.slice(0, 150);
}

/**
 * Item sale prices exclude GST and are in the base currency, so a
 * platform's price is copied only when the store is in the base currency
 * and its prices exclude tax (SPC6).
 */
export function priceCopyable(input: {
  storeCurrency: string | null;
  pricesIncludeTax: boolean | null;
  baseCurrency: string;
}): { copy: true } | { copy: false; reason: string } {
  if (input.storeCurrency === null || input.pricesIncludeTax === null) {
    return { copy: false, reason: "the store's currency and tax setting aren't known (test the connection)" };
  }
  if (input.storeCurrency !== input.baseCurrency) {
    return { copy: false, reason: `the store's currency is ${input.storeCurrency}, not ${input.baseCurrency}` };
  }
  if (input.pricesIncludeTax) {
    return { copy: false, reason: "the store's prices include tax and Tohyee's item prices exclude GST" };
  }
  return { copy: true };
}
