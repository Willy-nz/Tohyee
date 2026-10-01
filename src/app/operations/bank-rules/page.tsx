"use client";

import { type FormEvent, useState } from "react";
import { takesBankTransactionLines } from "@/components/bank/common";
import { AccountSelect, RequireOrganisation, useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { formatRate } from "@/components/invoices/invoice-editor";
import { Badge, Button, Card, Empty, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { BankAccount } from "@/lib/bank/accounts";
import type { BankRule } from "@/lib/bank/rules";
import { api, errorMessage } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";
import { AMOUNTS_MODE_LABELS, AMOUNTS_MODES, type AmountsMode } from "@/lib/invoices/amounts";
import type { TaxCode } from "@/lib/tax/codes";
import { isAvailableOn, onlyWords, ruleSides } from "@/lib/tax/available-on";

const DIRECTION_LABELS: Record<BankRule["direction"], string> = { any: "Money in or out", in: "Money in", out: "Money out" };
const FIELD_LABELS: Record<BankRule["matchField"], string> = {
  any: "Any detail",
  description: "Description",
  payee: "Payee",
  particulars: "Particulars",
  code: "Code",
  reference: "Reference",
};

type Draft = {
  name: string;
  isActive: boolean;
  priority: string;
  accountId: string;
  direction: BankRule["direction"];
  matchField: BankRule["matchField"];
  matchText: string;
  contactId: string;
  targetAccountCode: string;
  taxCode: string;
  amountsMode: AmountsMode;
  lineDescription: string;
};

function toDraft(rule: BankRule | null, defaultTaxCode: string): Draft {
  return {
    name: rule?.name ?? "",
    isActive: rule?.isActive ?? true,
    priority: String(rule?.priority ?? 100),
    accountId: rule?.accountId ?? "",
    direction: rule?.direction ?? "out",
    matchField: rule?.matchField ?? "any",
    matchText: rule?.matchText ?? "",
    contactId: rule?.contactId ?? "",
    targetAccountCode: rule?.targetAccountCode ?? "",
    taxCode: rule?.taxCode ?? defaultTaxCode,
    amountsMode: rule?.amountsMode ?? "inclusive",
    lineDescription: rule?.lineDescription ?? "",
  };
}

function RuleForm({
  organisationId,
  rule,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  rule: BankRule | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const accounts = useAccounts(organisationId);
  const contacts = useApiData<{ contacts: Contact[] }>("/api/contacts", { organisationId });
  const taxCodes = useApiData<{ taxCodes: TaxCode[] }>("/api/tax/codes", { organisationId });
  const bankAccounts = useApiData<{ bankAccounts: BankAccount[] }>("/api/bank-accounts", { organisationId });
  const active = (taxCodes.data?.taxCodes ?? []).filter((taxCode) => taxCode.isActive);
  const defaultTaxCode = (active.find((taxCode) => taxCode.category === "standard") ?? active[0])?.code ?? "";
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadError = accounts.error ?? contacts.error ?? taxCodes.error ?? bankAccounts.error;
  if (loadError) return <Notice tone="error">{loadError}</Notice>;
  if (!accounts.data || !contacts.data || !taxCodes.data || !bankAccounts.data) return <p className={ui.muted}>Loading…</p>;
  const current = draft ?? toDraft(rule, defaultTaxCode);
  const set = (patch: Partial<Draft>) => setDraft({ ...current, ...patch });
  const hasTax = current.amountsMode !== "no_tax";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      organisationId,
      ...current,
      priority: current.priority,
      accountId: current.accountId || null,
      taxCode: hasTax ? current.taxCode : null,
      lineDescription: current.lineDescription || null,
    };
    try {
      if (rule) await api(`/api/bank-rules/${rule.id}`, { method: "PATCH", body });
      else await api("/api/bank-rules", { method: "POST", body });
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }} autoComplete="off">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <h3 className={ui.cardTitle}>When a statement line…</h3>
      <div className={ui.grid4}>
        <Field label="Contains" hint="Ignoring case.">
          <input value={current.matchText} onChange={(event) => set({ matchText: event.target.value })} maxLength={200} required />
        </Field>
        <Field label="In">
          <select value={current.matchField} onChange={(event) => set({ matchField: event.target.value as Draft["matchField"] })}>
            {Object.entries(FIELD_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Is">
          <select value={current.direction} onChange={(event) => set({ direction: event.target.value as Draft["direction"] })}>
            {Object.entries(DIRECTION_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="On account">
          <select value={current.accountId} onChange={(event) => set({ accountId: event.target.value })}>
            <option value="">Any bank or card account</option>
            {bankAccounts.data.bankAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} · {account.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <h3 className={ui.cardTitle}>…suggest spend or receive money</h3>
      <div className={ui.grid4}>
        <Field label="Contact">
          <select value={current.contactId} onChange={(event) => set({ contactId: event.target.value })} required>
            <option value="">Choose a contact</option>
            {contacts.data.contacts
              .filter((contact) => !contact.isArchived || contact.id === current.contactId)
              .map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Account">
          <AccountSelect
            accounts={accounts.data.accounts}
            filter={takesBankTransactionLines}
            value={current.targetAccountCode}
            onChange={(code) => set({ targetAccountCode: code })}
            required
          />
        </Field>
        <Field label="Amounts are">
          <select value={current.amountsMode} onChange={(event) => set({ amountsMode: event.target.value as AmountsMode })}>
            {AMOUNTS_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {AMOUNTS_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </Field>
        {hasTax ? (
          <Field label="Tax code">
            <select value={current.taxCode} onChange={(event) => set({ taxCode: event.target.value })} required>
              <option value="">Choose</option>
              {taxCodes.data.taxCodes
                // Money in is receive money (sales), out spend money (purchases); either needs a code for both (TAO8).
                .filter(
                  (taxCode) =>
                    (taxCode.isActive && ruleSides(current.direction).every((side) => isAvailableOn(taxCode.availableOn, side))) ||
                    taxCode.code === current.taxCode,
                )
                .map((taxCode) => (
                  <option key={taxCode.id} value={taxCode.code}>
                    {taxCode.code} ({formatRate(taxCode.rate)}){taxCode.availableOn === "both" ? "" : ` (${onlyWords(taxCode.availableOn)})`}
                  </option>
                ))}
            </select>
          </Field>
        ) : null}
      </div>
      <div className={ui.grid4}>
        <Field label="Rule name">
          <input value={current.name} onChange={(event) => set({ name: event.target.value })} maxLength={100} required />
        </Field>
        <Field label="Line description" hint="Blank uses the statement line's description.">
          <input value={current.lineDescription} onChange={(event) => set({ lineDescription: event.target.value })} maxLength={500} />
        </Field>
        <Field label="Priority" hint="Lower is checked first.">
          <input
            type="number"
            min={0}
            max={10000}
            value={current.priority}
            onChange={(event) => set({ priority: event.target.value })}
          />
        </Field>
        <Field label="Status">
          <select value={current.isActive ? "on" : "off"} onChange={(event) => set({ isActive: event.target.value === "on" })}>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </Field>
      </div>
      <div className={ui.actions}>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : rule ? "Save rule" : "Add rule"}
        </Button>
      </div>
    </form>
  );
}

function BankRules({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const rules = useApiData<{ rules: BankRule[] }>("/api/bank-rules", { organisationId });
  const [editing, setEditing] = useState<BankRule | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(rule: BankRule) {
    if (!window.confirm(`Delete the rule “${rule.name}”? Nothing already reconciled changes.`)) return;
    setError(null);
    try {
      await api(`/api/bank-rules/${rule.id}`, { method: "DELETE", query: { organisationId } });
      rules.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <Card
      title="Bank rules"
      description="A rule fills in spend or receive money for statement lines that contain some text, such as a power bill or bank fees. You still check and save each one when reconciling. The first matching rule (lowest priority number) is used."
      actions={
        can("bookkeeper") && editing === null ? <Button onClick={() => setEditing("new")}>Add rule</Button> : null
      }
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {editing !== null ? (
        <RuleForm
          key={editing === "new" ? "new" : editing.id}
          organisationId={organisationId}
          rule={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            rules.reload();
          }}
        />
      ) : null}
      {rules.error ? <Notice tone="error">{rules.error}</Notice> : null}
      {rules.data && rules.data.rules.length === 0 ? (
        <Empty>No rules yet. Add one here, or tick “Save a bank rule” when you reconcile a line.</Empty>
      ) : null}
      {rules.data && rules.data.rules.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Priority</th>
                <th>Rule</th>
                <th>When</th>
                <th>Suggests</th>
                <th>Status</th>
                {can("bookkeeper") ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {rules.data.rules.map((rule) => (
                <tr key={rule.id}>
                  <td>{rule.priority}</td>
                  <td>{rule.name}</td>
                  <td>
                    {DIRECTION_LABELS[rule.direction]} with “{rule.matchText}” in {FIELD_LABELS[rule.matchField].toLowerCase()}
                    <div className={ui.muted}>{rule.accountCode ? `On ${rule.accountCode} only` : "On any bank or card account"}</div>
                  </td>
                  <td>
                    {rule.contactName} → {rule.targetAccountCode} · {rule.targetAccountName}
                    <div className={ui.muted}>
                      {AMOUNTS_MODE_LABELS[rule.amountsMode]}
                      {rule.taxCode ? `, ${rule.taxCode}` : ""}
                    </div>
                  </td>
                  <td>{rule.isActive ? <Badge tone="green">On</Badge> : <Badge>Off</Badge>}</td>
                  {can("bookkeeper") ? (
                    <td style={{ whiteSpace: "nowrap" }}>
                      <Button variant="secondary" size="small" onClick={() => setEditing(rule)}>
                        Edit
                      </Button>{" "}
                      <Button variant="secondary" size="small" onClick={() => void remove(rule)}>
                        Delete
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

export default function BankRulesPage() {
  return (
    <Page>
      <PageHeader title="Bank rules" description="Text to look for in statement lines, and the bank transaction to suggest." />
      <RequireOrganisation>{(organisationId) => <BankRules key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
