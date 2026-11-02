"use client";

import { type KeyboardEvent, useId, useState } from "react";
import { AccountSelect } from "@/components/books";
import { Button, Notice, ui } from "@/components/ui";
import type { Account } from "@/lib/accounts/service";
import { ACCOUNT_TYPES, type AccountType } from "@/lib/accounts/types";
import { api, errorMessage } from "@/lib/client/api";
import { type NewAccountSuggestion, nextFreeCode } from "@/lib/sales-platforms/setup";
import styles from "./store-setup.module.css";

/**
 * An account dropdown with "Add account" right there (decision 1254), so a
 * setup doesn't have to be left to add a code to the chart. The new account
 * goes through the chart's own rules (admins only, codes unique, the type
 * decides the class); a bank account is added as a bank account, so it can
 * take payments and transfers. When the suggested account isn't in the
 * chart yet, "Create it for me" adds it in one tap.
 */
export function AccountPicker({
  organisationId,
  label,
  accounts,
  value,
  onChange,
  filter,
  types,
  suggestion,
  canAdd,
  onAdded,
  describedBy,
}: {
  organisationId: string;
  label: string;
  accounts: Account[];
  value: string;
  onChange: (code: string) => void;
  filter: (account: Account) => boolean;
  /** The account types an added account can be. */
  types: readonly AccountType[];
  /** What "Create it for me" and the add form start with. */
  suggestion: NewAccountSuggestion;
  canAdd: boolean;
  onAdded: (account: Account) => void;
  describedBy?: string;
}) {
  const id = useId();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(suggestion);
  const suggestedExists = accounts.some((account) => account.code.toLowerCase() === suggestion.code.toLowerCase() && account.name === suggestion.name);

  async function create(input: NewAccountSuggestion) {
    setBusy(true);
    setError(null);
    try {
      const body = { organisationId, code: input.code.trim(), name: input.name.trim(), accountType: input.accountType };
      let added: Account;
      if (input.accountType === "bank") {
        const { bankAccount } = await api<{ bankAccount: { id: string; code: string; name: string; currencyCode: string } }>("/api/bank-accounts", { method: "POST", body });
        added = {
          id: bankAccount.id,
          code: bankAccount.code,
          name: bankAccount.name,
          accountClass: "asset",
          accountType: "bank",
          description: null,
          currencyCode: null,
          systemKey: null,
          isActive: true,
          hasPostings: false,
          defaultTaxCode: null,
        };
      } else {
        added = (await api<{ account: Account }>("/api/accounts", { method: "POST", body })).account;
      }
      onAdded(added);
      onChange(added.code);
      setAdding(false);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    // The form sits inside the setup, so Enter adds the account rather than submitting anything else.
    if (event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT") {
      event.preventDefault();
      void create(form);
    }
    if (event.key === "Escape") setAdding(false);
  };

  return (
    <div className={styles.picker}>
      <AccountSelect id={id} accounts={accounts} filter={filter} placeholder="Not chosen" value={value} onChange={onChange} ariaLabel={label} aria-describedby={describedBy} />
      {canAdd && !adding ? (
        <div className={styles.pickerActions}>
          {!value && !suggestedExists ? (
            <Button size="small" disabled={busy} onClick={() => void create(suggestion)}>
              {busy ? "Adding…" : `Create ${suggestion.code} ${suggestion.name} for me`}
            </Button>
          ) : null}
          <Button
            size="small"
            variant="secondary"
            onClick={() => {
              setForm({ ...suggestion, code: nextFreeCode(suggestion.code, accounts) });
              setError(null);
              setAdding(true);
            }}
          >
            Add a new account
          </Button>
        </div>
      ) : null}
      {error && !adding ? <Notice tone="error">{error}</Notice> : null}
      {adding ? (
        <div className={styles.addAccount} role="group" aria-label={`Add an account for ${label.toLowerCase()}`} onKeyDown={onKey}>
          <div className={styles.addAccountFields}>
            <label className={styles.smallField}>
              <span>Code</span>
              <input value={form.code} maxLength={20} onChange={(event) => setForm({ ...form, code: event.target.value })} autoFocus />
            </label>
            <label className={styles.smallField} style={{ flex: "2 1 180px" }}>
              <span>Name</span>
              <input value={form.name} maxLength={150} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </label>
            {types.length > 1 ? (
              <label className={styles.smallField}>
                <span>Type</span>
                <select value={form.accountType} onChange={(event) => setForm({ ...form, accountType: event.target.value as AccountType })}>
                  {types.map((type) => (
                    <option key={type} value={type}>
                      {ACCOUNT_TYPES[type].label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className={ui.muted} style={{ margin: 0, alignSelf: "end" }}>
                Type: {ACCOUNT_TYPES[form.accountType].label}
              </p>
            )}
          </div>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <div className={ui.actions}>
            <Button size="small" disabled={busy || !form.code.trim() || !form.name.trim()} onClick={() => void create(form)}>
              {busy ? "Adding…" : "Add account"}
            </Button>
            <Button size="small" variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
          <p className={ui.muted} style={{ margin: 0 }}>
            It&apos;s added to the chart of accounts straight away and chosen here. Your other answers stay as they are.
          </p>
        </div>
      ) : null}
    </div>
  );
}
