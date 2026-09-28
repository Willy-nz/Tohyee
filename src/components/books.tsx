"use client";

import type { ReactNode } from "react";
import type { Account } from "@/lib/accounts/service";
import { ACCOUNT_CLASSES, type AccountClass } from "@/lib/accounts/types";
import { formatMoney } from "@/lib/format";
import { useApiData, useHydrated } from "./hooks";
import { Card, Empty, Notice, ui } from "./ui";
import { useWorkspace } from "./workspace";

export const CLASS_LABELS: Record<AccountClass, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  revenue: "Income",
  expense: "Expenses",
};

/** Renders children only when an organisation is selected and ready. */
export function RequireOrganisation({ children }: { children: (organisationId: string) => ReactNode }) {
  const { current, user, serverSettingsUrl } = useWorkspace();
  const hydrated = useHydrated();
  if (!hydrated) {
    return <p className={ui.muted}>Loading…</p>;
  }
  if (!current) {
    return (
      <Card title="No organisation yet">
        <Empty>
          {user.isServerAdmin ? (
            <>
              You aren&apos;t a member of any organisation. Create one in the server settings, on the server
              computer: open Tohyee server settings from the Start menu
              {serverSettingsUrl ? (
                <>
                  {" "}
                  or go to <code>{serverSettingsUrl}</code> there
                </>
              ) : null}
              .
            </>
          ) : (
            <>You aren&apos;t a member of any organisation yet. Ask a server admin to add you.</>
          )}
        </Empty>
      </Card>
    );
  }
  if (current.status !== "ready") {
    return (
      <Notice tone="warning">
        {current.displayName}&apos;s database isn&apos;t ready ({current.status}). A server admin can repair it from
        Organisations.
      </Notice>
    );
  }
  return <>{children(current.id)}</>;
}

export function useAccounts(organisationId: string | null, includeArchived = false) {
  return useApiData<{ accounts: Account[] }>(organisationId ? "/api/accounts" : null, {
    organisationId,
    includeArchived: includeArchived ? "true" : null,
  });
}

/** Account dropdown grouped by class. Values are account codes. */
export function AccountSelect({
  accounts,
  value,
  onChange,
  filter,
  placeholder = "Choose an account",
  required,
  name,
  ariaLabel,
  id,
  "aria-describedby": describedBy,
}: {
  accounts: Account[];
  value: string;
  onChange: (code: string) => void;
  filter?: (account: Account) => boolean;
  placeholder?: string;
  required?: boolean;
  name?: string;
  ariaLabel?: string;
  id?: string;
  "aria-describedby"?: string;
}) {
  const usable = accounts.filter((account) => account.isActive && (!filter || filter(account)));
  return (
    <select
      id={id}
      name={name}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      value={value}
      required={required}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{placeholder}</option>
      {ACCOUNT_CLASSES.map((accountClass) => {
        const options = usable.filter((account) => account.accountClass === accountClass);
        if (options.length === 0) return null;
        return (
          <optgroup key={accountClass} label={CLASS_LABELS[accountClass]}>
            {options.map((account) => (
              <option key={account.id} value={account.code}>
                {account.code} · {account.name}
                {account.currencyCode ? ` (${account.currencyCode})` : ""}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}

export function Money({ value, blankZero = false }: { value: string | null | undefined; blankZero?: boolean }) {
  if (blankZero && (value == null || /^-?0*(\.0*)?$/.test(value))) {
    return <span className={ui.num} />;
  }
  return <span className={ui.num}>{formatMoney(value)}</span>;
}
