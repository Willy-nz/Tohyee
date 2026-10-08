"use client";

import { useApiData } from "@/components/hooks";
import { Field } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { isRateText } from "@/lib/money/fx";

type RateUsed = { rate: string; date: string; source: "list" | "posted" | "revaluation"; label?: string; until?: string | null };

/**
 * The rate a foreign-currency document or payment starts with: the exchange
 * rates list's rate effective on the date (MC48), else the last rate used on
 * or before it (D4, MC3); null in the base currency or when there's neither.
 */
export function useLastRate(organisationId: string, currencyCode: string, baseCurrency: string, date: string): RateUsed | null {
  const foreign = currencyCode !== baseCurrency && /^\d{4}-\d{2}-\d{2}$/.test(date);
  const found = useApiData<{ rate: RateUsed | null }>(foreign ? "/api/fx/last-rate" : null, { organisationId, currencyCode, date });
  return foreign ? (found.data?.rate ?? null) : null;
}

/**
 * The exchange rate on a foreign-currency invoice, bill, credit note or
 * payment (MC2, MC3, MC48): the list's rate or the last rate used for its
 * date until one is typed.
 * `value` is what was typed, or null to use the suggested one (the server
 * takes the same rate when none is sent).
 */
export function ExchangeRateField({
  currencyCode,
  baseCurrency,
  suggested,
  value,
  onChange,
}: {
  currencyCode: string;
  baseCurrency: string;
  /** From `useLastRate`. */
  suggested: RateUsed | null;
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  if (currencyCode === baseCurrency) return null;
  const shown = value ?? suggested?.rate ?? "";
  const hint =
    value !== null
      ? `${baseCurrency} per 1 ${currencyCode}, up to 8 decimal places.`
      : suggested
        ? suggested.source === "list"
          ? `From ${suggested.label && suggested.label !== "Exchange rates list" ? suggested.label : "the exchange rates list"}, effective ${formatDate(suggested.date)}${suggested.until ? ` to ${formatDate(suggested.until)}` : ""}. Change it if the rate on the day was different.`
          : `The last ${currencyCode} rate used, on ${formatDate(suggested.date)}. Change it if the rate on the day was different.`
        : `No ${currencyCode} rate for this date in the exchange rates list or its uploaded rate sets yet, so type it (or add rates under Accounting › Exchange rates).`;
  return (
    <Field label={`Exchange rate (${baseCurrency} per 1 ${currencyCode})`} hint={hint}>
      <input
        inputMode="decimal"
        value={shown}
        onChange={(event) => onChange(event.target.value)}
        required={!suggested}
        aria-invalid={shown !== "" && !isRateText(shown)}
      />
    </Field>
  );
}

/** The rate a document or payment will use: what was typed, else the suggested one; blank when neither. */
export function effectiveRate(typed: string | null, suggested: RateUsed | null): string {
  return typed ?? suggested?.rate ?? "";
}
