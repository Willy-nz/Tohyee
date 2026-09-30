"use client";

import { type FormEvent, useState } from "react";
import { takesBankTransactionLines } from "@/components/bank/common";
import { AccountSelect } from "@/components/books";
import { formatRate } from "@/components/invoices/invoice-editor";
import { TrackingSelects } from "@/components/tracking";
import { Button, Field, Notice, ui } from "@/components/ui";
import type { Account } from "@/lib/accounts/service";
import type { StatementLine } from "@/lib/bank/accounts";
import type { BulkResult } from "@/lib/bank/bulk";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";
import { formatDate, formatMoney } from "@/lib/format";
import type { TaxCode } from "@/lib/tax/codes";
import type { TrackingSetup, TrackingTags } from "@/lib/tracking/service";

/** A line's own values; blank means "as for all". `taxCode` "none" is no GST. */
type Own = { contactId: string; accountCode: string; taxCode: string; description: string; tracking: TrackingTags };
const BLANK: Own = { contactId: "", accountCode: "", taxCode: "", description: "", tracking: {} };
const NO_GST = "none";

/**
 * Bulk coding, or cash coding (examples BK22, BK23): the ticked lines each
 * become their own spend or receive money reconciled to the line, with the
 * values for all lines or each line's own.
 */
export function CashCodingForm({
  organisationId,
  accountId,
  lines,
  lookups,
  onDone,
}: {
  organisationId: string;
  accountId: string;
  lines: StatementLine[];
  lookups: { accounts: Account[]; contacts: Contact[]; taxCodes: TaxCode[]; tracking: TrackingSetup };
  onDone: (reconciledIds: string[]) => void;
}) {
  const activeTaxCodes = lookups.taxCodes.filter((taxCode) => taxCode.isActive);
  const contacts = lookups.contacts.filter((contact) => !contact.isArchived);
  const [contactId, setContactId] = useState("");
  const [accountCode, setAccountCode] = useState("");
  const [taxCode, setTaxCode] = useState(() => (activeTaxCodes.find((code) => code.category === "standard") ?? activeTaxCodes[0])?.code ?? "");
  const [description, setDescription] = useState("");
  const [tracking, setTracking] = useState<TrackingTags>({});
  const [own, setOwn] = useState<Record<string, Own>>({});
  // One key until the server answers, so a retry after a dropped connection can't post twice.
  const [key, setKey] = useState(() => newIdempotencyKey("cashcode"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ done: BulkResult; sent: StatementLine[] } | null>(null);
  const moneyIn = lines.filter((line) => !line.amount.startsWith("-")).length;
  const ownFor = (lineId: string) => own[lineId] ?? BLANK;
  const setOwnFor = (lineId: string, patch: Partial<Own>) => setOwn((current) => ({ ...current, [lineId]: { ...(current[lineId] ?? BLANK), ...patch } }));
  const missingAccount = !accountCode && lines.some((line) => !ownFor(line.id).accountCode);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    const sent = lines;
    try {
      const done = await api<BulkResult>(`/api/bank-accounts/${accountId}/cash-coding`, {
        method: "POST",
        body: {
          organisationId,
          source: "ui",
          idempotencyKey: key,
          contactId: contactId || undefined,
          accountCode: accountCode || undefined,
          taxCode: taxCode || null,
          description: description.trim() || undefined,
          tracking,
          lines: sent.map((line) => {
            const mine = ownFor(line.id);
            return {
              lineId: line.id,
              ...(mine.contactId ? { contactId: mine.contactId } : {}),
              ...(mine.accountCode ? { accountCode: mine.accountCode } : {}),
              ...(mine.taxCode ? { taxCode: mine.taxCode === NO_GST ? null : mine.taxCode } : {}),
              ...(mine.description.trim() ? { description: mine.description.trim() } : {}),
              ...(Object.keys(mine.tracking).length > 0 ? { tracking: mine.tracking } : {}),
            };
          }),
        },
      });
      setKey(newIdempotencyKey("cashcode"));
      setResult({ done, sent });
      onDone(done.results.flatMap((entry) => (entry.ok ? [entry.lineId] : [])));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const describe = (sent: StatementLine[], lineId: string) => {
    const line = sent.find((candidate) => candidate.id === lineId);
    return line ? `${formatDate(line.date)} ${line.description} ${formatMoney(line.amount)}` : `Line ${lineId}`;
  };

  return (
    <form onSubmit={(event) => void save(event)} style={{ display: "grid", gap: 12 }} autoComplete="off">
      <p className={ui.muted}>
        Each ticked line becomes its own{" "}
        {moneyIn === 0 ? "spend money" : moneyIn === lines.length ? "receive money" : "spend money (money out) or receive money (money in)"} for
        the line&apos;s full amount, on the line&apos;s date, reconciled to it. Amounts include GST. A line&apos;s own values below win
        over the values for all.
      </p>
      {lines.length > 0 ? (
        <>
          <h4 className={ui.cardTitle}>For all ticked lines</h4>
          <div className={ui.grid3}>
            <Field label="Contact" hint="Blank: the contact named like each line's payee.">
              <select value={contactId} onChange={(event) => setContactId(event.target.value)}>
                <option value="">Each line&apos;s payee</option>
                {contacts.map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Account">
              <AccountSelect accounts={lookups.accounts} filter={takesBankTransactionLines} value={accountCode} onChange={setAccountCode} />
            </Field>
            <Field label="GST">
              <select value={taxCode} onChange={(event) => setTaxCode(event.target.value)}>
                <option value="">No GST</option>
                {activeTaxCodes.map((code) => (
                  <option key={code.id} value={code.code}>
                    {code.code} ({formatRate(code.rate)})
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Description" hint="Blank: each line's own description.">
            <input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} />
          </Field>
          <TrackingSelects setup={lookups.tracking} labelPrefix="All lines" value={tracking} onChange={setTracking} />
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Contact</th>
                  <th style={{ width: "24%" }}>Account</th>
                  <th>GST</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => {
                  const mine = ownFor(line.id);
                  const label = `${formatDate(line.date)} ${line.description}`;
                  return (
                    <tr key={line.id}>
                      <td>
                        {formatDate(line.date)} · {line.description}
                        <div className={ui.muted}>{formatMoney(line.amount)}</div>
                      </td>
                      <td>
                        <select aria-label={`${label} contact`} value={mine.contactId} onChange={(event) => setOwnFor(line.id, { contactId: event.target.value })}>
                          <option value="">{contactId ? "As for all" : `Payee: ${line.payee ?? line.description}`}</option>
                          {contacts.map((contact) => (
                            <option key={contact.id} value={contact.id}>
                              {contact.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <AccountSelect
                          ariaLabel={`${label} account`}
                          accounts={lookups.accounts}
                          filter={takesBankTransactionLines}
                          placeholder="As for all"
                          value={mine.accountCode}
                          onChange={(code) => setOwnFor(line.id, { accountCode: code })}
                        />
                        <TrackingSelects
                          setup={lookups.tracking}
                          labelPrefix={label}
                          value={mine.tracking}
                          onChange={(tags) => setOwnFor(line.id, { tracking: tags })}
                        />
                      </td>
                      <td>
                        <select aria-label={`${label} GST`} value={mine.taxCode} onChange={(event) => setOwnFor(line.id, { taxCode: event.target.value })}>
                          <option value="">As for all</option>
                          <option value={NO_GST}>No GST</option>
                          {activeTaxCodes.map((code) => (
                            <option key={code.id} value={code.code}>
                              {code.code} ({formatRate(code.rate)})
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          aria-label={`${label} description`}
                          placeholder="As for all"
                          value={mine.description}
                          onChange={(event) => setOwnFor(line.id, { description: event.target.value })}
                          maxLength={500}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {result ? (
        <Notice tone={result.done.failed ? "warning" : "success"}>
          {result.done.succeeded} coded and reconciled{result.done.failed ? `, ${result.done.failed} not:` : "."}
          {result.done.failed ? (
            <ul>
              {result.done.results.flatMap((entry) =>
                entry.ok ? [] : [<li key={entry.lineId}>{describe(result.sent, entry.lineId)}: {entry.error}</li>],
              )}
            </ul>
          ) : null}
        </Notice>
      ) : null}
      <div className={ui.actions}>
        {missingAccount ? <span className={ui.muted}>Choose an account for all lines, or for each line.</span> : null}
        <Button type="submit" disabled={busy || lines.length === 0 || missingAccount}>
          {busy ? "Saving…" : `Code and reconcile ${lines.length} ${lines.length === 1 ? "line" : "lines"}`}
        </Button>
      </div>
    </form>
  );
}
