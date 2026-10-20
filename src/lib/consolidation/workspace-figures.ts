import { add, dec, type Decimal, mul, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/**
 * The group workspace's figures (decisions 643-644; Codex, delegated by
 * owner, 20 October 2026). Browser-safe and pure, so the rules are tested
 * on their own:
 *
 * - CRM amounts are added up per currency and never across currencies
 *   (MC68), unless the person chooses a translation basis; translated
 *   figures always say which rate was used.
 * - Opportunity stages are combined across organisations only where a
 *   person mapped them, or where the stage is the same everywhere (same
 *   key, name and type); anything else is listed as unmapped, not guessed.
 */

export type CurrencyAmount = { currencyCode: string; amount: string; weighted: string; count: number };

/** Amounts per currency, the group's currency first then alphabetical. */
export function totalsByCurrency(rows: ReadonlyArray<{ currencyCode: string; amount: string; weighted: string }>, groupCurrency: string): CurrencyAmount[] {
  const sums = new Map<string, { amount: Decimal; weighted: Decimal; count: number }>();
  for (const row of rows) {
    const sum = sums.get(row.currencyCode) ?? { amount: ZERO_DECIMAL, weighted: ZERO_DECIMAL, count: 0 };
    sums.set(row.currencyCode, { amount: add(sum.amount, dec(row.amount)), weighted: add(sum.weighted, dec(row.weighted)), count: sum.count + 1 });
  }
  return [...sums.entries()]
    .sort(([a], [b]) => (a === groupCurrency ? -1 : b === groupCurrency ? 1 : a.localeCompare(b)))
    .map(([currencyCode, sum]) => ({ currencyCode, amount: toFixedString(sum.amount, 2), weighted: toFixedString(sum.weighted, 2), count: sum.count }));
}

/** Adds per-currency totals together, still per currency. */
export function mergeCurrencyTotals(lists: ReadonlyArray<ReadonlyArray<CurrencyAmount>>, groupCurrency: string): CurrencyAmount[] {
  const sums = new Map<string, { amount: Decimal; weighted: Decimal; count: number }>();
  for (const list of lists) {
    for (const entry of list) {
      const sum = sums.get(entry.currencyCode) ?? { amount: ZERO_DECIMAL, weighted: ZERO_DECIMAL, count: 0 };
      sums.set(entry.currencyCode, { amount: add(sum.amount, dec(entry.amount)), weighted: add(sum.weighted, dec(entry.weighted)), count: sum.count + entry.count });
    }
  }
  return [...sums.entries()]
    .sort(([a], [b]) => (a === groupCurrency ? -1 : b === groupCurrency ? 1 : a.localeCompare(b)))
    .map(([currencyCode, sum]) => ({ currencyCode, amount: toFixedString(sum.amount, 2), weighted: toFixedString(sum.weighted, 2), count: sum.count }));
}

export type TranslationRate = { currencyCode: string; rate: string; date: string | null; changed: boolean };

export type TranslatedTotal = {
  currencyCode: string;
  /** In the group's currency, each currency's total times its rate, rounded to cents. */
  amount: string;
  weighted: string;
  /** What was translated and at which rates, so the figure is never shown without its basis. */
  label: string;
  rates: TranslationRate[];
  /** Currencies with no rate: not in the translated total, and named. */
  untranslated: CurrencyAmount[];
};

/**
 * Translates per-currency totals into the group's currency (decision 644):
 * each currency's total times the rate (group currency per unit), rounded
 * half up to cents, then added. A currency without a rate is left out and
 * listed.
 */
export function translateTotals(totals: ReadonlyArray<CurrencyAmount>, groupCurrency: string, rates: ReadonlyMap<string, TranslationRate>, basisLabel: string): TranslatedTotal {
  let amount = ZERO_DECIMAL;
  let weighted = ZERO_DECIMAL;
  const used: TranslationRate[] = [];
  const untranslated: CurrencyAmount[] = [];
  for (const entry of totals) {
    const rate = entry.currencyCode === groupCurrency ? { currencyCode: groupCurrency, rate: "1", date: null, changed: false } : rates.get(entry.currencyCode);
    if (!rate) {
      untranslated.push(entry);
      continue;
    }
    if (entry.currencyCode !== groupCurrency) used.push(rate);
    amount = add(amount, dec(toFixedString(mul(dec(entry.amount), dec(rate.rate)), 2)));
    weighted = add(weighted, dec(toFixedString(mul(dec(entry.weighted), dec(rate.rate)), 2)));
  }
  return { currencyCode: groupCurrency, amount: toFixedString(amount, 2), weighted: toFixedString(weighted, 2), label: basisLabel, rates: used, untranslated };
}

export type MemberStage = { organisationId: string; key: string; name: string; type: string };
export type StageMapping = { organisationId: string; stageKey: string; groupStage: string };

export type StageResolution = {
  /** `${organisationId}|${stageKey}` to the group stage it counts as. */
  resolved: Map<string, string>;
  /** Stages with no mapping that differ between organisations. */
  unmapped: MemberStage[];
};

/**
 * Which group stage each member's stage counts as: its mapping when a
 * person made one; otherwise the stage's own name when every organisation
 * in the comparison has a stage with the same key, name and type and nobody
 * mapped that key anywhere; otherwise unmapped.
 */
export function resolveStages(stages: ReadonlyArray<MemberStage>, mappings: ReadonlyArray<StageMapping>, organisationIds: readonly string[]): StageResolution {
  const mapped = new Map(mappings.map((mapping) => [`${mapping.organisationId}|${mapping.stageKey}`, mapping.groupStage]));
  const resolved = new Map<string, string>();
  const unmapped: MemberStage[] = [];
  for (const stage of stages) {
    const id = `${stage.organisationId}|${stage.key}`;
    const chosen = mapped.get(id);
    if (chosen) {
      resolved.set(id, chosen);
      continue;
    }
    const sameEverywhere = !mappings.some((mapping) => mapping.stageKey === stage.key) && organisationIds.every((organisationId) =>
      stages.some((other) => other.organisationId === organisationId && other.key === stage.key && other.name === stage.name && other.type === stage.type),
    );
    if (sameEverywhere) resolved.set(id, stage.name);
    else unmapped.push(stage);
  }
  return { resolved, unmapped };
}
