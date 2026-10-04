"use client";

import { type FormEvent, useState } from "react";
import { takesBankTransactionLines } from "@/components/bank/common";
import { AccountSelect, RequireOrganisation, useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { formatRate } from "@/components/invoices/invoice-editor";
import { Badge, Button, Card, Empty, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { BankAccount } from "@/lib/bank/accounts";
import type { BankRule, RuleCondition, RuleLine, RuleTextField } from "@/lib/bank/rules";
import type { TrackingTags } from "@/lib/tracking/service";
import { api, errorMessage } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";
import type { TaxCode } from "@/lib/tax/codes";
import { isAvailableOn, onlyWords, ruleSides } from "@/lib/tax/available-on";
import { useConfirm } from "@/components/confirm-dialog";
import { TrackingSelects, TrackingTagsText, useTracking } from "@/components/tracking";

const DIRECTION_LABELS: Record<BankRule["direction"], string> = { any: "Money in or out", in: "Money in", out: "Money out" };
const FIELD_LABELS: Record<RuleTextField | "amount", string> = {
  any: "Any detail",
  description: "Description",
  payee: "Payee",
  particulars: "Particulars",
  code: "Code",
  reference: "Reference",
  amount: "Amount",
};
const OPERATOR_LABELS: Record<string, string> = {
  contains: "contains",
  equals: "equals",
  starts_with: "starts with",
  at_least: "is at least",
  at_most: "is at most",
  between: "is between",
};
const TEXT_OPERATORS = ["contains", "equals", "starts_with"] as const;
const AMOUNT_OPERATORS = ["equals", "at_least", "at_most", "between"] as const;

type DraftCondition = { field: RuleTextField | "amount"; operator: string; text: string; amount: string; amountTo: string };
type DraftLine = {
  kind: "fixed" | "percentage";
  value: string;
  accountCode: string;
  taxCode: string;
  description: string;
  tracking: TrackingTags;
};

type Draft = {
  name: string;
  isActive: boolean;
  priority: string;
  accountId: string;
  direction: BankRule["direction"];
  matchMode: BankRule["matchMode"];
  conditions: DraftCondition[];
  contactMode: BankRule["contactMode"];
  contactId: string;
  lines: DraftLine[];
};

const blankCondition = (): DraftCondition => ({ field: "payee", operator: "contains", text: "", amount: "", amountTo: "" });
const blankLine = (taxCode: string, percentage = "100"): DraftLine => ({
  kind: "percentage",
  value: percentage,
  accountCode: "",
  taxCode,
  description: "",
  tracking: {},
});

function toDraft(rule: BankRule | null, defaultTaxCode: string): Draft {
  return {
    name: rule?.name ?? "",
    isActive: rule?.isActive ?? true,
    priority: String(rule?.priority ?? 100),
    accountId: rule?.accountId ?? "",
    direction: rule?.direction ?? "out",
    matchMode: rule?.matchMode ?? "all",
    conditions: rule
      ? rule.conditions.map((condition) =>
          condition.field === "amount"
            ? { field: "amount", operator: condition.operator, text: "", amount: condition.amount, amountTo: condition.amountTo ?? "" }
            : { field: condition.field, operator: condition.operator, text: condition.text, amount: "", amountTo: "" },
        )
      : [blankCondition()],
    contactMode: rule?.contactMode ?? "chosen",
    contactId: rule?.contactId ?? "",
    lines: rule
      ? rule.lines.map((line) => ({
          kind: line.fixedAmount !== null ? "fixed" : "percentage",
          value: line.fixedAmount ?? line.percentage ?? "",
          accountCode: line.accountCode,
          taxCode: line.taxCode ?? "",
          description: line.description ?? "",
          tracking: line.tracking,
        }))
      : [blankLine(defaultTaxCode)],
  };
}

/** The percentage lines' total in hundredths, so 33.33 + 33.33 + 33.34 is exactly 100 (no floating point). */
function percentTotalText(lines: DraftLine[]): string {
  let hundredths = BigInt(0);
  for (const line of lines) {
    if (line.kind !== "percentage") continue;
    const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(line.value.trim());
    if (!match) return "?";
    hundredths += BigInt(match[1]) * BigInt(100) + BigInt((match[2] ?? "").padEnd(2, "0"));
  }
  const whole = hundredths / BigInt(100);
  const rest = (hundredths % BigInt(100)).toString().padStart(2, "0");
  return `${whole}.${rest}`;
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
  const tracking = useTracking(organisationId);
  const active = (taxCodes.data?.taxCodes ?? []).filter((taxCode) => taxCode.isActive);
  const defaultTaxCode = (active.find((taxCode) => taxCode.category === "standard") ?? active[0])?.code ?? "";
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadError = accounts.error ?? contacts.error ?? taxCodes.error ?? bankAccounts.error ?? tracking.error;
  if (loadError) return <Notice tone="error">{loadError}</Notice>;
  if (!accounts.data || !contacts.data || !taxCodes.data || !bankAccounts.data || !tracking.data) return <p className={ui.muted}>Loading…</p>;
  const current = draft ?? toDraft(rule, defaultTaxCode);
  const accountList = accounts.data.accounts;
  const set = (patch: Partial<Draft>) => setDraft({ ...current, ...patch });
  const setCondition = (index: number, patch: Partial<DraftCondition>) =>
    set({ conditions: current.conditions.map((condition, at) => (at === index ? { ...condition, ...patch } : condition)) });
  const setLine = (index: number, patch: Partial<DraftLine>) =>
    set({ lines: current.lines.map((line, at) => (at === index ? { ...line, ...patch } : line)) });
  const percentTotal = percentTotalText(current.lines);
  const usableTaxCodes = (chosen: string) =>
    taxCodes.data!.taxCodes.filter(
      // Money in is receive money (sales), out spend money (purchases); either needs a code for both (TAO8).
      (taxCode) => (taxCode.isActive && ruleSides(current.direction).every((side) => isAvailableOn(taxCode.availableOn, side))) || taxCode.code === chosen,
    );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      organisationId,
      name: current.name,
      isActive: current.isActive,
      priority: current.priority,
      accountId: current.accountId || null,
      direction: current.direction,
      matchMode: current.matchMode,
      conditions: current.conditions.map((condition) =>
        condition.field === "amount"
          ? { field: "amount", operator: condition.operator, amount: condition.amount, ...(condition.operator === "between" ? { amountTo: condition.amountTo } : {}) }
          : { field: condition.field, operator: condition.operator, text: condition.text },
      ),
      contactMode: current.contactMode,
      contactId: current.contactMode === "chosen" ? current.contactId : null,
      lines: current.lines.map((line) => ({
        ...(line.kind === "fixed" ? { fixedAmount: line.value } : { percentage: line.value }),
        accountCode: line.accountCode,
        taxCode: line.taxCode || null,
        description: line.description || null,
        tracking: line.tracking,
      })),
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
        <Field label="And meets" hint="Text ignores case and extra spaces; amounts ignore the sign.">
          <select value={current.matchMode} onChange={(event) => set({ matchMode: event.target.value as Draft["matchMode"] })}>
            <option value="all">All of these conditions</option>
            <option value="any">Any of these conditions</option>
          </select>
        </Field>
      </div>
      <div className={ui.tableWrap}>
        <table className={ui.table} style={{ minWidth: 640 }}>
          <thead>
            <tr>
              <th>Field</th>
              <th>Condition</th>
              <th>Value</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {current.conditions.map((condition, index) => (
              <tr key={index}>
                <td>
                  <select
                    aria-label={`Condition ${index + 1} field`}
                    value={condition.field}
                    onChange={(event) => {
                      const field = event.target.value as DraftCondition["field"];
                      const wasAmount = condition.field === "amount";
                      const isAmount = field === "amount";
                      setCondition(index, { field, ...(wasAmount !== isAmount ? { operator: isAmount ? "equals" : "contains" } : {}) });
                    }}
                  >
                    {Object.entries(FIELD_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    aria-label={`Condition ${index + 1} operator`}
                    value={condition.operator}
                    onChange={(event) => setCondition(index, { operator: event.target.value })}
                  >
                    {(condition.field === "amount" ? AMOUNT_OPERATORS : TEXT_OPERATORS).map((operator) => (
                      <option key={operator} value={operator}>
                        {OPERATOR_LABELS[operator]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  {condition.field === "amount" ? (
                    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                      <input
                        aria-label={`Condition ${index + 1} amount`}
                        inputMode="decimal"
                        value={condition.amount}
                        onChange={(event) => setCondition(index, { amount: event.target.value })}
                        required
                        style={{ width: 110 }}
                      />
                      {condition.operator === "between" ? (
                        <>
                          and
                          <input
                            aria-label={`Condition ${index + 1} second amount`}
                            inputMode="decimal"
                            value={condition.amountTo}
                            onChange={(event) => setCondition(index, { amountTo: event.target.value })}
                            required
                            style={{ width: 110 }}
                          />
                        </>
                      ) : null}
                    </span>
                  ) : (
                    <input
                      aria-label={`Condition ${index + 1} text`}
                      value={condition.text}
                      onChange={(event) => setCondition(index, { text: event.target.value })}
                      maxLength={200}
                      required
                    />
                  )}
                </td>
                <td>
                  {current.conditions.length > 1 ? (
                    <Button
                      variant="secondary"
                      size="small"
                      onClick={() => set({ conditions: current.conditions.filter((_, at) => at !== index) })}
                    >
                      Remove
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {current.conditions.length < 10 ? (
        <div>
          <Button variant="secondary" size="small" onClick={() => set({ conditions: [...current.conditions, blankCondition()] })}>
            Add condition
          </Button>
        </div>
      ) : null}

      <h3 className={ui.cardTitle}>…suggest spend or receive money</h3>
      <div className={ui.grid4}>
        <Field label="Contact">
          <select
            value={current.contactMode === "payee" ? "__payee" : current.contactId}
            onChange={(event) =>
              event.target.value === "__payee" ? set({ contactMode: "payee", contactId: "" }) : set({ contactMode: "chosen", contactId: event.target.value })
            }
            required
          >
            <option value="">Choose a contact</option>
            <option value="__payee">The contact named like the payee</option>
            {contacts.data.contacts
              .filter((contact) => !contact.isArchived || contact.id === current.contactId)
              .map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.name}
                </option>
              ))}
          </select>
        </Field>
      </div>
      <p className={ui.muted}>
        Fixed amounts come off first; percentage lines share what&apos;s left and must add up to 100%. Amounts include GST when a line has a GST code.
      </p>
      <div className={ui.tableWrap}>
        <table className={ui.table} style={{ minWidth: 820 }}>
          <thead>
            <tr>
              <th>Amount</th>
              <th>Account</th>
              <th>GST</th>
              <th>Description</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {current.lines.map((line, index) => (
              <tr key={index}>
                <td>
                  <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  <select
                    aria-label={`Line ${index + 1} kind`}
                    value={line.kind}
                    onChange={(event) => setLine(index, { kind: event.target.value as DraftLine["kind"] })}
                    style={{ width: 96 }}
                  >
                    <option value="percentage">%</option>
                    <option value="fixed">Fixed $</option>
                  </select>
                  <input
                    aria-label={line.kind === "fixed" ? `Line ${index + 1} fixed amount` : `Line ${index + 1} percentage`}
                    inputMode="decimal"
                    value={line.value}
                    onChange={(event) => setLine(index, { value: event.target.value })}
                    required
                    style={{ width: 90 }}
                  />
                  </span>
                </td>
                <td>
                  <AccountSelect
                    accounts={accountList}
                    filter={takesBankTransactionLines}
                    value={line.accountCode}
                    onChange={(code) => setLine(index, { accountCode: code })}
                    required
                  />
                  <TrackingSelects
                    setup={tracking.data}
                    labelPrefix={`Line ${index + 1}`}
                    value={line.tracking}
                    onChange={(tags) => setLine(index, { tracking: tags })}
                  />
                </td>
                <td>
                  <select aria-label={`Line ${index + 1} GST code`} value={line.taxCode} onChange={(event) => setLine(index, { taxCode: event.target.value })}>
                    <option value="">No GST</option>
                    {usableTaxCodes(line.taxCode).map((taxCode) => (
                      <option key={taxCode.id} value={taxCode.code}>
                        {taxCode.code} ({formatRate(taxCode.rate)}){taxCode.availableOn === "both" ? "" : ` (${onlyWords(taxCode.availableOn)})`}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    aria-label={`Line ${index + 1} description`}
                    placeholder="The statement line's"
                    value={line.description}
                    onChange={(event) => setLine(index, { description: event.target.value })}
                    maxLength={500}
                  />
                </td>
                <td>
                  {current.lines.length > 1 ? (
                    <Button variant="secondary" size="small" onClick={() => set({ lines: current.lines.filter((_, at) => at !== index) })}>
                      Remove
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        {current.lines.length < 20 ? (
          <Button variant="secondary" size="small" onClick={() => set({ lines: [...current.lines, blankLine(defaultTaxCode, "")] })}>
            Add line
          </Button>
        ) : null}
        <span className={percentTotal === "100.00" ? ui.muted : undefined} role="status">
          Percentage lines: {percentTotal}%{percentTotal === "100.00" ? "" : " (must be 100%)"}
        </span>
      </div>
      <div className={ui.grid4}>
        <Field label="Rule name">
          <input value={current.name} onChange={(event) => set({ name: event.target.value })} maxLength={100} required />
        </Field>
        <Field label="Priority" hint="Lower is checked first.">
          <input type="number" min={0} max={10000} value={current.priority} onChange={(event) => set({ priority: event.target.value })} />
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

function conditionText(condition: RuleCondition): string {
  if (condition.field === "amount") {
    return `amount ${OPERATOR_LABELS[condition.operator]} ${condition.amount}${condition.amountTo ? ` and ${condition.amountTo}` : ""}`;
  }
  return `${FIELD_LABELS[condition.field].toLowerCase()} ${OPERATOR_LABELS[condition.operator]} “${condition.text}”`;
}

function lineText(line: RuleLine): string {
  const share = line.fixedAmount !== null ? line.fixedAmount : `${line.percentage}%`;
  return `${share} ${line.accountCode} · ${line.accountName}${line.taxCode ? `, ${line.taxCode}` : ", no GST"}`;
}

function BankRules({ organisationId }: { organisationId: string }) {
  const confirm = useConfirm();
  const { can } = useWorkspace();
  const rules = useApiData<{ rules: BankRule[] }>("/api/bank-rules", { organisationId });
  const trackingSetup = useTracking(organisationId);
  const [editing, setEditing] = useState<BankRule | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(rule: BankRule) {
    if (!(await confirm(`Delete the rule “${rule.name}”? Nothing already reconciled changes.`))) return;
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
      description="A rule fills in spend or receive money for statement lines that meet its conditions, such as a power bill or bank fees, split across lines if you like. You still check and OK each one when reconciling. The first rule that matches and fits (lowest priority number) is used."
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
                    {DIRECTION_LABELS[rule.direction]} where {rule.conditions.map(conditionText).join(rule.matchMode === "any" ? " or " : " and ")}
                    <div className={ui.muted}>{rule.accountCode ? `On ${rule.accountCode} only` : "On any bank or card account"}</div>
                  </td>
                  <td>
                    {rule.contactMode === "payee" ? "The contact named like the payee" : rule.contactName}
                    {rule.lines.map((line, index) => (
                      <div key={index} className={ui.muted}>
                        {lineText(line)}
                        <TrackingTagsText setup={trackingSetup.data} tags={line.tracking} />
                      </div>
                    ))}
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
      <PageHeader title="Bank rules" description="Conditions to look for in statement lines, and the bank transaction to suggest." />
      <RequireOrganisation>{(organisationId) => <BankRules key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
