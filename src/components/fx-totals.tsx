"use client";

import { Money } from "@/components/books";
import { Stat } from "@/components/ui";

/**
 * A foreign-currency document's base-currency figures beside its own (MC2,
 * MC71): the exchange rate, the GST in the base currency (each line's GST
 * converted at the rate, what the GST account and return get) and the base
 * total, plus what's still due or unused at the document's rate. Nothing for
 * a base-currency document.
 */
export function ForeignTotals({
  document,
  baseCurrency,
  hasTax,
  openLabel,
  openBase,
}: {
  document: { exchangeRate: string | null; exchangeRateSource?: string | null; baseTaxTotal: string | null; baseTotal: string | null };
  baseCurrency: string;
  hasTax: boolean;
  openLabel?: string;
  openBase?: string | null;
}) {
  if (!document.exchangeRate) return null;
  return (
    <>
      <Stat label={document.exchangeRateSource ? `Exchange rate (${document.exchangeRateSource})` : "Exchange rate"} value={document.exchangeRate} />
      {hasTax ? <Stat label={`GST (${baseCurrency})`} value={<Money value={document.baseTaxTotal} />} /> : null}
      <Stat label={`Total (${baseCurrency})`} value={<Money value={document.baseTotal} />} />
      {openLabel && openBase !== null && openBase !== undefined ? (
        <Stat label={`${openLabel} (${baseCurrency}, at this rate)`} value={<Money value={openBase} />} />
      ) : null}
    </>
  );
}
