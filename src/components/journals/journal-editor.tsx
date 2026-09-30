"use client";

import { type FormEvent, useState } from "react";
import type { Account } from "@/lib/accounts/service";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatMoney, todayInBrowser } from "@/lib/format";
import type { JournalWithLines } from "@/lib/ledger/journals";
import { add, cmp, dec, isDecimalString, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { convertAtRate, isRateText } from "@/lib/money/fx";
import { AccountSelect } from "@/components/books";
import { CustomFieldInputs, startingValues, useCustomFields } from "@/components/custom-fields";
import { TrackingSelects, useTracking } from "@/components/tracking";
import { Button, Field, Notice, ui } from "@/components/ui";
import type { CustomValues } from "@/lib/custom-fields/values";
import type { TrackingTags } from "@/lib/tracking/service";

type EditorLine = {
  key: number;
  accountCode: string;
  description: string;
  debit: string;
  credit: string;
  tracking: TrackingTags;
  /** Undefined until the custom field set-up loads, then the line's values. */
  customFields?: CustomValues;
  /** On a foreign-currency account (FXB1-FXB11): the foreign amount and rate. */
  foreignAmount: string;
  exchangeRate: string;
};

let lineKey = 0;
function blankLine(): EditorLine {
  lineKey += 1;
  return { key: lineKey, accountCode: "", description: "", debit: "", credit: "", tracking: {}, foreignAmount: "", exchangeRate: "" };
}

function total(lines: EditorLine[], side: "debit" | "credit") {
  return lines.reduce((sum, line) => {
    const value = line[side].trim();
    return isDecimalString(value) ? add(sum, dec(value)) : sum;
  }, ZERO_DECIMAL);
}

function totalText(lines: EditorLine[], side: "debit" | "credit") {
  return formatMoney(toFixedString(total(lines, side), 2));
}

export type JournalEditorProps = {
  organisationId: string;
  accounts: Account[];
  mode: "new" | "correct";
  original?: JournalWithLines;
  onDone: (journalId: string) => void;
  onCancel?: () => void;
};

/**
 * Journal entry with an account picker per line. Each submission carries an
 * idempotency key, so a double click or a retry after a network error can't
 * post the same journal twice.
 */
export function JournalEditor({ organisationId, accounts, mode, original, onDone, onCancel }: JournalEditorProps) {
  const tracking = useTracking(organisationId);
  const customSetup = useCustomFields(organisationId);
  // Before the set-up loads, new records have no defaults yet; they're filled in once it has.
  const [customFields, setCustomFields] = useState<CustomValues | undefined>(original ? original.customFields : undefined);
  const headerValues = customFields ?? startingValues(customSetup.data, "document", ["journal"]);
  const lineValues = (line: EditorLine) => line.customFields ?? startingValues(customSetup.data, "line", ["journal"]);
  const [postingDate, setPostingDate] = useState(todayInBrowser);
  const [reference, setReference] = useState(original?.reference ?? "");
  const [description, setDescription] = useState(original?.description ?? "");
  const [lines, setLines] = useState<EditorLine[]>(() =>
    original
      ? original.lines.map((line) => {
          lineKey += 1;
          return {
            key: lineKey,
            accountCode: line.accountCode,
            description: line.description ?? "",
            debit: /^0*(\.0*)?$/.test(line.debitAmount) ? "" : line.debitAmount,
            credit: /^0*(\.0*)?$/.test(line.creditAmount) ? "" : line.creditAmount,
            tracking: line.tracking ?? {},
            customFields: line.customFields ?? {},
            foreignAmount: line.foreign?.amount ?? "",
            exchangeRate: line.foreign?.rate ?? "",
          };
        })
      : [blankLine(), blankLine()],
  );
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey(mode === "new" ? "journal" : "correction"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const debits = total(lines, "debit");
  const credits = total(lines, "credit");
  const balanced = cmp(debits, credits) === 0 && debits.units > BigInt(0);

  function update(key: number, patch: Partial<EditorLine>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  const currencyOf = (code: string) => accounts.find((account) => account.code === code)?.currencyCode ?? null;

  /** A foreign amount or rate changed: the NZD amount is foreign x rate, rounded once (D2). */
  function updateForeign(line: EditorLine, patch: Pick<Partial<EditorLine>, "foreignAmount" | "exchangeRate">) {
    const next = { ...line, ...patch };
    if (isDecimalString(next.foreignAmount.trim()) && isRateText(next.exchangeRate)) {
      const base = convertAtRate(next.foreignAmount.trim(), next.exchangeRate.trim());
      update(line.key, line.credit ? { ...patch, credit: base } : { ...patch, debit: base });
    } else {
      update(line.key, patch);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const payloadLines = lines
      .filter((line) => line.accountCode || line.debit || line.credit)
      .map((line) => ({
        accountCode: line.accountCode,
        description: line.description || null,
        debitAmount: line.debit || null,
        creditAmount: line.credit || null,
        tracking: line.tracking,
        customFields: lineValues(line),
        ...(currencyOf(line.accountCode) ? { foreignAmount: line.foreignAmount.trim() || null, exchangeRate: line.exchangeRate.trim() || null } : {}),
      }));
    try {
      if (mode === "new") {
        const result = await api<{ journal: { id: string } }>("/api/ledger/journals", {
          method: "POST",
          body: { organisationId, source: "ui", idempotencyKey, postingDate, reference, description, lines: payloadLines, customFields: headerValues },
        });
        setIdempotencyKey(newIdempotencyKey("journal"));
        setReference("");
        setDescription("");
        setCustomFields(undefined);
        setLines([blankLine(), blankLine()]);
        onDone(result.journal.id);
      } else {
        const result = await api<{ replacementJournal: { id: string } }>("/api/ledger/journals/corrections", {
          method: "POST",
          body: {
            organisationId,
            source: "ui",
            idempotencyKey,
            originalJournalId: original?.id,
            postingDate,
            reference,
            description,
            lines: payloadLines,
            customFields: headerValues,
          },
        });
        onDone(result.replacementJournal.id);
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} style={{ display: "grid", gap: 14 }}>
      {mode === "correct" && original ? (
        <Notice tone="info">
          This posts a reversal of journal #{original.id} and the corrected journal below, both dated{" "}
          {postingDate || "the date you choose"}. The original stays in the books for the audit trail.
        </Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid3}>
        <Field label="Date">
          <input type="date" value={postingDate} onChange={(event) => setPostingDate(event.target.value)} required />
        </Field>
        <Field label="Reference">
          <input value={reference} onChange={(event) => setReference(event.target.value)} maxLength={100} required />
        </Field>
        <Field label="Description">
          <input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} />
        </Field>
      </div>
      <CustomFieldInputs setup={customSetup.data} record="document" uses={["journal"]} value={headerValues} onChange={setCustomFields} />
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th style={{ width: "34%" }}>Account</th>
              <th>Line description</th>
              <th className={ui.num} style={{ width: 140 }}>
                Debit
              </th>
              <th className={ui.num} style={{ width: 140 }}>
                Credit
              </th>
              <th style={{ width: 44 }} />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={line.key}>
                <td data-label="Account">
                  <AccountSelect
                    ariaLabel={`Line ${index + 1} account`}
                    accounts={accounts}
                    value={line.accountCode}
                    onChange={(code) => update(line.key, { accountCode: code })}
                  />
                  {currencyOf(line.accountCode) ? (
                    <div className={ui.inlineForm} style={{ marginTop: 6 }}>
                      <input
                        aria-label={`Line ${index + 1} ${currencyOf(line.accountCode)} amount`}
                        placeholder={`${currencyOf(line.accountCode)} amount`}
                        inputMode="decimal"
                        className={ui.num}
                        value={line.foreignAmount}
                        onChange={(event) => updateForeign(line, { foreignAmount: event.target.value })}
                        required
                      />
                      <input
                        aria-label={`Line ${index + 1} exchange rate`}
                        placeholder="Rate (NZD per 1)"
                        inputMode="decimal"
                        className={ui.num}
                        value={line.exchangeRate}
                        onChange={(event) => updateForeign(line, { exchangeRate: event.target.value })}
                        required
                      />
                    </div>
                  ) : null}
                  <TrackingSelects
                    setup={tracking.data}
                    labelPrefix={`Line ${index + 1}`}
                    value={line.tracking}
                    onChange={(tags) => update(line.key, { tracking: tags })}
                  />
                  <CustomFieldInputs
                    compact
                    setup={customSetup.data}
                    record="line"
                    uses={["journal"]}
                    labelPrefix={`Line ${index + 1}`}
                    value={lineValues(line)}
                    onChange={(values) => update(line.key, { customFields: values })}
                  />
                </td>
                <td data-label="Line description">
                  <input
                    aria-label={`Line ${index + 1} description`}
                    value={line.description}
                    onChange={(event) => update(line.key, { description: event.target.value })}
                    maxLength={200}
                  />
                </td>
                <td data-label="Debit">
                  <input
                    aria-label={`Line ${index + 1} debit`}
                    inputMode="decimal"
                    className={ui.num}
                    value={line.debit}
                    onChange={(event) => update(line.key, { debit: event.target.value, credit: event.target.value ? "" : line.credit })}
                  />
                </td>
                <td data-label="Credit">
                  <input
                    aria-label={`Line ${index + 1} credit`}
                    inputMode="decimal"
                    className={ui.num}
                    value={line.credit}
                    onChange={(event) => update(line.key, { credit: event.target.value, debit: event.target.value ? "" : line.debit })}
                  />
                </td>
                <td data-label="">
                  <Button
                    variant="secondary"
                    size="small"
                    aria-label={`Remove line ${index + 1}`}
                    disabled={lines.length <= 2}
                    onClick={() => setLines((current) => current.filter((entry) => entry.key !== line.key))}
                  >
                    ×
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>
                <Button variant="secondary" size="small" onClick={() => setLines((current) => [...current, blankLine()])}>
                  Add line
                </Button>
              </td>
              <td className={ui.num}>Totals</td>
              <td className={ui.num}>{totalText(lines, "debit")}</td>
              <td className={ui.num}>{totalText(lines, "credit")}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <div className={ui.actions}>
        <Button type="submit" disabled={busy || !balanced}>
          {busy ? "Posting…" : mode === "new" ? "Post journal" : "Post correction"}
        </Button>
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <span className={ui.muted}>
          {balanced
            ? "Balanced."
            : debits.units === BigInt(0) && credits.units === BigInt(0)
              ? "Enter the amounts."
              : "Debits and credits must be equal before you can post."}
        </span>
      </div>
    </form>
  );
}
