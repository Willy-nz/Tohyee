"use client";

import { type FormEvent, useState } from "react";
import { CLASS_LABELS, RequireOrganisation, useAccounts } from "@/components/books";
import { Badge, Button, Card, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Account } from "@/lib/accounts/service";
import { ACCOUNT_CLASSES, ACCOUNT_TYPES, type AccountType } from "@/lib/accounts/types";
import { api, errorMessage } from "@/lib/client/api";
import { CURRENCY_MINOR_UNITS } from "@/lib/money/currency";

const TYPE_OPTIONS = Object.entries(ACCOUNT_TYPES) as Array<[AccountType, (typeof ACCOUNT_TYPES)[AccountType]]>;
const CURRENCIES = Object.keys(CURRENCY_MINOR_UNITS);

type Draft = {
  code: string;
  name: string;
  accountType: AccountType;
  description: string;
  currencyCode: string;
};

const EMPTY_DRAFT: Draft = { code: "", name: "", accountType: "expense", description: "", currencyCode: "" };

function AccountForm({
  initial,
  lockClass,
  lockCurrency,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: Draft;
  lockClass?: string | null;
  lockCurrency?: boolean;
  submitLabel: string;
  onSubmit: (draft: Draft) => Promise<void>;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const typeClass = ACCOUNT_TYPES[draft.accountType].accountClass;
  const canHoldCurrency = typeClass === "asset" || typeClass === "liability";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(draft);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid4}>
        <Field label="Code">
          <input value={draft.code} onChange={(event) => setDraft({ ...draft, code: event.target.value })} maxLength={20} required />
        </Field>
        <Field label="Name">
          <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} maxLength={150} required />
        </Field>
        <Field label="Type" hint={lockClass ? `Has postings, so it stays a ${lockClass} account.` : undefined}>
          <select
            value={draft.accountType}
            onChange={(event) => setDraft({ ...draft, accountType: event.target.value as AccountType })}
          >
            {ACCOUNT_CLASSES.map((accountClass) => (
              <optgroup key={accountClass} label={CLASS_LABELS[accountClass]}>
                {TYPE_OPTIONS.filter(([, info]) => info.accountClass === accountClass).map(([type, info]) => (
                  <option key={type} value={type} disabled={Boolean(lockClass) && lockClass !== accountClass}>
                    {info.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>
        <Field label="Currency" hint="Only for foreign-currency bank, receivable or payable accounts.">
          <select
            value={draft.currencyCode}
            disabled={!canHoldCurrency || lockCurrency}
            onChange={(event) => setDraft({ ...draft, currencyCode: event.target.value })}
          >
            <option value="">Base currency</option>
            {CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Description">
        <input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} maxLength={500} />
      </Field>
      <div className={ui.actions}>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </Button>
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function Accounts({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const [showArchived, setShowArchived] = useState(false);
  const accounts = useAccounts(organisationId, showArchived);
  const [editing, setEditing] = useState<Account | null>(null);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const isAdmin = can("admin");

  async function toggleArchived(account: Account) {
    try {
      await api(`/api/accounts/${account.id}`, {
        method: "PATCH",
        body: { organisationId, isActive: !account.isActive },
      });
      setMessage(`${account.code} ${account.isActive ? "archived" : "restored"}.`);
      accounts.reload();
    } catch (caught) {
      setMessage(errorMessage(caught));
    }
  }

  return (
    <>
      {message ? <Notice tone="info">{message}</Notice> : null}
      {isAdmin && adding ? (
        <Card title="New account">
          <AccountForm
            initial={EMPTY_DRAFT}
            submitLabel="Add account"
            onCancel={() => setAdding(false)}
            onSubmit={async (draft) => {
              await api("/api/accounts", { method: "POST", body: { organisationId, ...draft } });
              setAdding(false);
              setMessage(`Added ${draft.code} ${draft.name}.`);
              accounts.reload();
            }}
          />
        </Card>
      ) : null}
      {isAdmin && editing ? (
        <Card title={`Edit ${editing.code} · ${editing.name}`}>
          <AccountForm
            key={editing.id}
            initial={{
              code: editing.code,
              name: editing.name,
              accountType: editing.accountType,
              description: editing.description ?? "",
              currencyCode: editing.currencyCode ?? "",
            }}
            lockClass={editing.hasPostings ? editing.accountClass : null}
            lockCurrency={editing.hasPostings}
            submitLabel="Save changes"
            onCancel={() => setEditing(null)}
            onSubmit={async (draft) => {
              await api(`/api/accounts/${editing.id}`, { method: "PATCH", body: { organisationId, ...draft } });
              setEditing(null);
              setMessage(`Saved ${draft.code} ${draft.name}.`);
              accounts.reload();
            }}
          />
        </Card>
      ) : null}
      <Card
        title="Accounts"
        actions={
          <>
            <label className={ui.checkbox}>
              <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
              Show archived
            </label>
            {isAdmin && !adding ? (
              <Button
                onClick={() => {
                  setEditing(null);
                  setAdding(true);
                }}
              >
                New account
              </Button>
            ) : null}
          </>
        }
      >
        {accounts.error ? <Notice tone="error">{accounts.error}</Notice> : null}
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Type</th>
                <th>Currency</th>
                <th>Status</th>
                {isAdmin ? <th /> : null}
              </tr>
            </thead>
            {ACCOUNT_CLASSES.map((accountClass) => {
              const rows = (accounts.data?.accounts ?? []).filter((account) => account.accountClass === accountClass);
              if (rows.length === 0) return null;
              return (
                <tbody key={accountClass}>
                  <tr className={ui.reportHeading}>
                    <td colSpan={isAdmin ? 6 : 5}>{CLASS_LABELS[accountClass]}</td>
                  </tr>
                  {rows.map((account) => (
                    <tr key={account.id}>
                      <td>{account.code}</td>
                      <td>
                        {account.name}
                        {account.description ? <div className={ui.muted}>{account.description}</div> : null}
                      </td>
                      <td>{ACCOUNT_TYPES[account.accountType]?.label ?? account.accountType}</td>
                      <td>{account.currencyCode ?? ""}</td>
                      <td>
                        {account.isActive ? <Badge tone="green">Active</Badge> : <Badge>Archived</Badge>}{" "}
                        {account.systemKey ? <Badge tone="blue">Used by Tohyee</Badge> : null}
                      </td>
                      {isAdmin ? (
                        <td className={ui.num}>
                          <span className={ui.actions} style={{ justifyContent: "flex-end" }}>
                            <Button
                              variant="secondary"
                              size="small"
                              onClick={() => {
                                setAdding(false);
                                setEditing(account);
                              }}
                            >
                              Edit
                            </Button>
                            {!account.systemKey ? (
                              <Button variant="secondary" size="small" onClick={() => void toggleArchived(account)}>
                                {account.isActive ? "Archive" : "Restore"}
                              </Button>
                            ) : null}
                          </span>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              );
            })}
          </table>
        </div>
      </Card>
    </>
  );
}

export default function AccountsPage() {
  return (
    <Page>
      <PageHeader
        title="Chart of accounts"
        description="Every journal line posts to one of these accounts. Archived accounts keep their history but can't take new postings."
      />
      <RequireOrganisation>{(organisationId) => <Accounts key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
