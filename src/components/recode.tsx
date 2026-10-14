"use client";

import Link from "next/link";
import { useState } from "react";
import { AccountSelect, Money, useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { TrackingSelects, TrackingTagsText, useTracking } from "@/components/tracking";
import { Button, Card, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import type { Recode, RecodeDocument } from "@/lib/ledger/recode";
import type { TrackingTags } from "@/lib/tracking/service";

type RecodableLine = { lineOrder: number; description: string; accountCode: string; tracking: TrackingTags };

/** Accounts a line can be recoded to: not control, bank, card, foreign or fixed asset accounts (RCD6). */
const recodable = (account: { systemKey: string | null; currencyCode: string | null; accountType: string }) =>
  !account.systemKey && !account.currencyCode && !["bank", "credit_card", "fixed_asset"].includes(account.accountType);

/**
 * Recode a posted line's account or tracking, with a reason (RCD1-RCD6).
 * A correcting journal is posted on the document's own date.
 */
export function RecodeForm({
  organisationId,
  documentType,
  documentId,
  lines,
  onDone,
}: {
  organisationId: string;
  documentType: RecodeDocument;
  documentId: string;
  lines: RecodableLine[];
  onDone: (message: string) => void;
}) {
  const accounts = useAccounts(organisationId);
  const tracking = useTracking(organisationId);
  const [lineOrder, setLineOrder] = useState(lines[0]?.lineOrder ?? 1);
  const line = lines.find((entry) => entry.lineOrder === lineOrder) ?? lines[0];
  const [accountCode, setAccountCode] = useState(line?.accountCode ?? "");
  const [tags, setTags] = useState<TrackingTags>(line?.tracking ?? {});
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(() => newIdempotencyKey("rc"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!line) return null;

  function chooseLine(order: number) {
    const next = lines.find((entry) => entry.lineOrder === order)!;
    setLineOrder(order);
    setAccountCode(next.accountCode);
    setTags(next.tracking);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ recode: Recode }>("/api/recodes", {
        method: "POST",
        body: { organisationId, idempotencyKey: key, documentType, documentId, lineOrder, accountCode, tracking: tags, reason },
      });
      setKey(newIdempotencyKey("rc"));
      setReason("");
      onDone(`Line ${result.recode.lineOrder} recoded: journal #${result.recode.journalId} moved ${result.recode.amount} from ${result.recode.fromAccountCode} to ${result.recode.toAccountCode}.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form style={{ display: "grid", gap: 12 }} onSubmit={save}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p className={ui.muted}>
        Only the account and tracking change. A correcting journal moves the line&apos;s amount on the document&apos;s own date, so it must be after
        the lock date. GST and the amount stay as they are.
      </p>
      <div className={ui.inlineForm}>
        {lines.length > 1 ? (
          <Field label="Line">
            <select value={lineOrder} onChange={(event) => chooseLine(Number(event.target.value))}>
              {lines.map((entry) => (
                <option key={entry.lineOrder} value={entry.lineOrder}>
                  {entry.lineOrder}. {entry.description} ({entry.accountCode})
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label="Account">
          {accounts.data ? (
            <AccountSelect
              accounts={accounts.data.accounts}
              value={accountCode}
              onChange={setAccountCode}
              filter={(account) => recodable(account) || account.code === line.accountCode}
              required
            />
          ) : (
            <span className={ui.muted}>Loading…</span>
          )}
        </Field>
        <TrackingSelects setup={tracking.data} value={tags} onChange={setTags} labelPrefix="Recode" />
      </div>
      <Field label="Reason">
        <input required maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? "Recoding…" : "Recode"}
        </Button>
      </div>
    </form>
  );
}

/** A posted invoice's or bill's recodes, and the form for bookkeepers. */
export function RecodeCard({
  organisationId,
  documentType,
  documentId,
  lines,
  onRecoded,
}: {
  organisationId: string;
  documentType: RecodeDocument;
  documentId: string;
  lines: RecodableLine[];
  onRecoded: () => void;
}) {
  const { can } = useWorkspace();
  const tracking = useTracking(organisationId);
  const history = useApiData<{ recodes: Recode[] }>("/api/recodes", { organisationId, documentType, documentId });
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const recodes = history.data?.recodes ?? [];
  if (!can("bookkeeper") && recodes.length === 0) return null;
  return (
    <Card title="Recode" description="Coded to the wrong account or tracking? Recode a line instead of voiding the whole document.">
      {message ? <Notice tone="success">{message}</Notice> : null}
      {recodes.length > 0 ? (
        <ul style={{ margin: "0 0 12px", paddingLeft: 20, display: "grid", gap: 6 }}>
          {recodes.map((recode) => (
            <li key={recode.id}>
              Line {recode.lineOrder}: {recode.fromAccountCode}
              {Object.keys(recode.fromTracking).length > 0 ? (
                <>
                  {" "}
                  (<TrackingTagsText setup={tracking.data} tags={recode.fromTracking} />)
                </>
              ) : null}{" "}
              → {recode.toAccountCode}
              {Object.keys(recode.toTracking).length > 0 ? (
                <>
                  {" "}
                  (<TrackingTagsText setup={tracking.data} tags={recode.toTracking} />)
                </>
              ) : null}
              , <Money value={recode.amount} />. &ldquo;{recode.reason}&rdquo; by {recode.createdByEmail}, {formatDateTime(recode.createdAt)}.{" "}
              <Link href={`/operations/ledger-journals?journal=${recode.journalId}`}>Journal #{recode.journalId}</Link>
            </li>
          ))}
        </ul>
      ) : null}
      {can("bookkeeper") ? (
        open ? (
          <RecodeForm
            organisationId={organisationId}
            documentType={documentType}
            documentId={documentId}
            lines={lines}
            onDone={(text) => {
              setMessage(text);
              setOpen(false);
              history.reload();
              onRecoded();
            }}
          />
        ) : (
          <div>
            <Button variant="secondary" size="small" onClick={() => setOpen(true)}>
              Recode a line
            </Button>
          </div>
        )
      ) : null}
    </Card>
  );
}
