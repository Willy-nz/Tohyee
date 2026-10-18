import { add, dec, divide, mul, parseDecimalInput, toFixedString } from "@/lib/money/decimal";

/*
 * What a proposed fertiliser application would come to (example AIW12,
 * decision 560): the same sums as a plan line (FB2), worked out without
 * saving anything. Pure. No rate is suggested: the person or their AI
 * supplies it, with the product's nutrient content from the product list.
 */

export type WhatIfInput = {
  hectares: string;
  kgPerHa: string;
  product: { name: string; nPct: string; pPct: string; kPct: string; sPct: string };
  pricePerTonne: string | null;
  spreadingPerHa: string | null;
};

export type WhatIf = {
  product: string;
  hectares: string;
  kgPerHa: string;
  tonnes: string;
  kgPerHaOf: { n: string; p: string; k: string; s: string };
  totalKgOf: { n: string; p: string; k: string; s: string };
  productCost: string | null;
  spreadingCost: string | null;
  total: string | null;
  saved: false;
};

const HUNDRED = dec("100");
const THOUSAND = dec("1000");

export function parseWhatIf(input: { hectares: unknown; kgPerHa: unknown; pricePerTonne?: unknown; spreadingPerHa?: unknown }) {
  const optional = (value: unknown, label: string) => (value === undefined || value === null || value === "" ? null : parseDecimalInput(value, label, { maxScale: 2, allowZero: true }));
  return {
    hectares: parseDecimalInput(input.hectares, "hectares", { maxScale: 2 }),
    kgPerHa: parseDecimalInput(input.kgPerHa, "kgPerHa", { maxScale: 2 }),
    pricePerTonne: optional(input.pricePerTonne, "pricePerTonne"),
    spreadingPerHa: optional(input.spreadingPerHa, "spreadingPerHa"),
  };
}

/** Tonnes = ha × kg/ha ÷ 1,000 (3 places); kg nutrient/ha = kg/ha × % ÷ 100 (1 place); costs to the cent (FB2). */
export function fertiliserWhatIf(input: WhatIfInput): WhatIf {
  const ha = dec(input.hectares);
  const rate = dec(input.kgPerHa);
  const tonnes = divide(mul(ha, rate), THOUSAND, 3);
  const perHa = (pct: string) => toFixedString(divide(mul(rate, dec(pct)), HUNDRED, 1), 1);
  const total = (pct: string) => toFixedString(divide(mul(mul(ha, rate), dec(pct)), HUNDRED, 1), 1);
  const productCost = input.pricePerTonne === null ? null : divide(mul(tonnes, dec(input.pricePerTonne)), dec("1"), 2);
  const spreadingCost = input.spreadingPerHa === null ? null : divide(mul(ha, dec(input.spreadingPerHa)), dec("1"), 2);
  const { nPct, pPct, kPct, sPct } = input.product;
  return {
    product: input.product.name,
    hectares: toFixedString(ha, 2),
    kgPerHa: toFixedString(rate, 2),
    tonnes: toFixedString(tonnes, 3),
    kgPerHaOf: { n: perHa(nPct), p: perHa(pPct), k: perHa(kPct), s: perHa(sPct) },
    totalKgOf: { n: total(nPct), p: total(pPct), k: total(kPct), s: total(sPct) },
    productCost: productCost === null ? null : toFixedString(productCost, 2),
    spreadingCost: spreadingCost === null ? null : toFixedString(spreadingCost, 2),
    total: productCost === null && spreadingCost === null ? null : toFixedString(add(productCost ?? dec("0"), spreadingCost ?? dec("0")), 2),
    saved: false,
  };
}
