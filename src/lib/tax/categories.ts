/** Shared with the browser, so no server imports here. */
export const TAX_CATEGORIES = ["standard", "zero_rated", "exempt", "out_of_scope"] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];
