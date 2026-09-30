"use client";

import { useApiData } from "@/components/hooks";
import { Field } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { isRateText } from "@/lib/money/fx";

type RateUsed = { rate: string; date: string; source: "posted" | "revaluation" };

/**
 * The last rate used for a currency on or before a date (D4), which a
 * foreign-currency document or payment starts with (MC3); null in the base
 * currency or when none has been used yet.
 */
export function useLastRate(organisationId: string, currencyCode: string, baseCurrency: string, date: string): RateUsed | null {
  const foreign = currencyCode !== baseCurrency && /^\d{4}-\d{2}-\d{2}$/.test(date);
  const found = useApiData<{ rate: RateUsed | null }>(foreign ? "/api/fx/last-rate" : null, { organisationId, currencyCode, date });
  return foreign ? (found.data?.rate ?? null) : null;
}

/**
 * The exchange rate on a foreign-currency invoice, bill, credit note or
 * payment (MC2, MC3): the last rate used for its date until one is typed.
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
        ? `The last ${currencyCode} rate used, on ${formatDate(suggested.date)}. Change it if the rate on the day was different.`
        : `No ${currencyCode} rate has been used on or before this date yet, so type it.`;
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
