"use client";

import { type FormEvent, useState } from "react";
import { Money } from "@/components/books";
import { Button, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { BankAccount, StatementLine } from "@/lib/bank/accounts";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatMoney, todayInBrowser } from "@/lib/format";
import { convertAtRate, isRateText } from "@/lib/money/fx";
import { isDecimalString } from "@/lib/money/decimal";

/**
 * Screens for foreign-currency bank accounts (examples FXB1-FXB11): amounts
 * are in the account's currency with the base-currency value beside them.
 */

/** An amount with its currency code in front, e.g. "USD 1,000.00". */
export function CurrencyMoney({ currency, value }: { currency: string; value: string | null | undefined }) {
  if (value == null) return <span className={ui.num}>—</span>;
  return (
    <span className={ui.num}>
      {currency} {formatMoney(value)}
    </span>
  );
}

/** A foreign-currency line's base value: what it was reconciled at, or at the last rate used (D4). */
export function LineBaseValue({ line, baseCurrency }: { line: StatementLine; baseCurrency: string }) {
  if (line.currencyCode === baseCurrency) return null;
  if (line.baseAmount === null) {
    return <div className={ui.muted}>No {line.currencyCode} rate used yet: type one</div>;
  }
  return (
    <div className={ui.muted}>
      {baseCurrency} {formatMoney(line.baseAmount)}
      {line.status !== "reconciled" && line.suggestedRate ? ` at ${line.suggestedRate.rate}` : ""}
    </div>
  );
}

/** The rate field for spend and receive money on a foreign-currency line, with the base value it gives. */
export function RateField({
  currency,
  baseCurrency,
  rate,
  onChange,
  amount,
  suggested,
}: {
  currency: string;
  baseCurrency: string;
  rate: string;
  onChange: (rate: string) => void;
  amount: string;
  suggested: StatementLine["suggestedRate"];
}) {
  const valid = isRateText(rate) && isDecimalString(amount);
  return (
    <Field
      label={`Exchange rate (${baseCurrency} per 1 ${currency})`}
      hint={
        suggested
          ? `Filled in with the last ${currency} rate used, ${suggested.rate} (${suggested.source === "revaluation" ? "a revaluation" : "a transaction"} on ${formatDate(suggested.date)}). Change it to the bank's rate if it's different.`
          : `No ${currency} rate has been used on or before this date yet, so type the bank's rate.`
      }
    >
      <input inputMode="decimal" value={rate} onChange={(event) => onChange(event.target.value)} required aria-label="Exchange rate" />
      {valid ? (
        <span className={ui.muted}>
          {currency} {formatMoney(amount)} = {baseCurrency} {formatMoney(convertAtRate(amount, rate.trim()))}
        </span>
      ) : null}
    </Field>
  );
}

/**
 * The opening foreign balance of an account with postings from before
 * Tohyee kept foreign amounts (FXB1): entered once, as at a date, posting
 * nothing.
 */
export function OpeningBalancePanel({
  organisationId,
  account,
  canEnter,
  onSaved,
}: {
  organisationId: string;
  account: BankAccount;
  canEnter: boolean;
  onSaved: () => void;
}) {
  const [asAtDate, setAsAtDate] = useState(() => todayInBrowser());
  const [foreignBalance, setForeignBalance] = useState("");
  const [key, setKey] = useState(() => newIdempotencyKey("opening"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currency = account.statementCurrency;
  const base = useWorkspace().current?.baseCurrency ?? "NZD";

  if (account.openingBalance) {
    return (
      <p className={ui.muted}>
        Opening foreign balance: {currency} {formatMoney(account.openingBalance.foreignBalance)} = {base}{" "}
        {formatMoney(account.openingBalance.baseBalance)} as at {formatDate(account.openingBalance.asAtDate)}.
      </p>
    );
  }
  if (!account.needsOpeningBalance) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/bank-accounts/${account.id}/opening-foreign-balance`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: key, asAtDate, foreignBalance: foreignBalance.trim() },
      });
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught));
      setKey(newIdempotencyKey("opening"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Notice tone="warning">
      <div style={{ display: "grid", gap: 8 }}>
        <span>
          This account has postings from before Tohyee kept {currency} amounts, so Tohyee only knows its balance in {base} (
          <Money value={account.ledgerBalance} />
          ). Enter its {currency} balance once, as at a date on or after its last posting, before importing statements or posting to it.
          It posts nothing: it says what the {base} balance at that date is in {currency}. Afterwards nothing can be posted to the account
          dated on or before that date.
        </span>
        {canEnter ? (
          <form onSubmit={(event) => void submit(event)} className={ui.grid3} autoComplete="off">
            <Field label="As at">
              <input type="date" value={asAtDate} onChange={(event) => setAsAtDate(event.target.value)} required />
            </Field>
            <Field label={`${currency} balance`} hint="Money in the account is positive; owed (an overdrawn account or a card) is negative.">
              <input inputMode="decimal" value={foreignBalance} onChange={(event) => setForeignBalance(event.target.value)} required />
            </Field>
            <div className={ui.actions} style={{ alignItems: "end" }}>
              <Button type="submit" disabled={busy || !foreignBalance.trim()}>
                {busy ? "Saving…" : "Save opening foreign balance"}
              </Button>
            </div>
          </form>
        ) : (
          <span className={ui.muted}>A bookkeeper can enter it.</span>
        )}
        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Notice>
  );
}
