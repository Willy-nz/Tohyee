"use client";

import { type FormEvent, useState } from "react";
import { AccountSelect, useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import type { Account } from "@/lib/accounts/service";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { PayItem, PayItemKind, PayrollSettings } from "@/lib/payroll/pay-items";
import styles from "./payroll-employees.module.css";

export const PAY_ITEM_KIND_NAMES: Record<PayItemKind, string> = {
  ordinary_time: "Ordinary time",
  overtime: "Overtime",
  allowance: "Allowance",
  holiday_pay: "Holiday pay (typed amount)",
  reimbursement: "Reimbursement",
  after_tax_deduction: "After-tax deduction",
  kiwisaver_employer: "KiwiSaver employer contribution",
};

const ADDABLE: PayItemKind[] = ["overtime", "allowance", "holiday_pay", "reimbursement", "after_tax_deduction"];

/** Where a pay item's amounts go: earnings to an expense, deductions to a liability (PRUN10). */
function accountFilter(kind: PayItemKind | "") {
  return (account: Account) =>
    kind === "after_tax_deduction"
      ? account.accountClass === "liability" && (account.systemKey === null || account.systemKey === "payroll_deductions_payable")
      : account.accountClass === "expense" && account.systemKey === null;
}

/** What a pay item is subject to, in words (spec 5.7, 5.11 and 4.5.1). */
export function describeTreatment(item: PayItem): string {
  if (item.category === "deduction") return "Taken from net pay";
  if (item.category === "employer_contribution") return "ESCT is deducted";
  const parts = [item.subjectToPaye ? "PAYE, ACC levy and student loan" : "Not taxed"];
  parts.push(item.subjectToKiwiSaver ? "KiwiSaver" : "no KiwiSaver");
  return parts.join("; ");
}

type Editing = { item: PayItem; name: string; accountCode: string; rateMultiplier: string };

/** Payroll › Pay items (PRUN10) and the approver setting (PRUN7). */
export function PayrollPayItems({ organisationId }: { organisationId: string }) {
  const [includeArchived, setIncludeArchived] = useState(false);
  const items = useApiData<{ payItems: PayItem[] }>("/api/payroll/pay-items", { organisationId, includeArchived: includeArchived ? "true" : null });
  const me = useApiData<{ canManagePayrollAccess: boolean }>("/api/payroll/access/me", { organisationId });
  const settings = useApiData<{ settings: PayrollSettings }>("/api/payroll/settings", { organisationId });
  const accounts = useAccounts(organisationId);
  const isAdmin = me.data?.canManagePayrollAccess ?? false;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<PayItemKind | "">("");
  const [accountCode, setAccountCode] = useState("");
  const [rateMultiplier, setRateMultiplier] = useState("1.5");
  const [taxable, setTaxable] = useState(true);
  const [countsForKiwiSaver, setCountsForKiwiSaver] = useState(true);
  const [editing, setEditing] = useState<Editing | null>(null);

  const run = async (work: () => Promise<unknown>, success: string, reload: () => void) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      setMessage({ tone: "success", text: success });
      reload();
      return true;
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    const body: Record<string, unknown> = { organisationId, idempotencyKey: newIdempotencyKey("pay-item"), name: trimmed, kind, accountCode };
    if (kind === "overtime") body.rateMultiplier = rateMultiplier;
    if (kind === "allowance") {
      body.taxable = taxable;
      body.countsForKiwiSaver = taxable && countsForKiwiSaver;
    }
    const saved = await run(() => api("/api/payroll/pay-items", { method: "POST", body }), `${trimmed} added.`, items.reload);
    if (saved) {
      setName("");
      setKind("");
      setAccountCode("");
    }
  };

  const saveEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing) return;
    const body: Record<string, unknown> = { organisationId };
    if (editing.name.trim() !== editing.item.name) body.name = editing.name.trim();
    if (editing.accountCode !== (editing.item.accountCode ?? "")) body.accountCode = editing.accountCode;
    if (editing.item.kind === "overtime" && editing.rateMultiplier !== editing.item.rateMultiplier) body.rateMultiplier = editing.rateMultiplier;
    const saved = await run(
      () => api(`/api/payroll/pay-items/${editing.item.id}`, { method: "PATCH", body }),
      `${editing.name.trim()} saved.`,
      items.reload,
    );
    if (saved) setEditing(null);
  };

  const archive = (item: PayItem) =>
    void run(
      () => api(`/api/payroll/pay-items/${item.id}`, { method: "PATCH", body: { organisationId, isArchived: !item.isArchived } }),
      item.isArchived ? `${item.name} restored.` : `${item.name} archived.`,
      items.reload,
    );

  const changeApprover = (approverMustDiffer: boolean) =>
    void run(
      () => api("/api/payroll/settings", { method: "PUT", body: { organisationId, approverMustDiffer } }),
      approverMustDiffer ? "Pay runs now need a different person to approve them." : "Whoever prepares a pay run can now approve it.",
      settings.reload,
    );

  const accountList = accounts.data?.accounts ?? [];

  return (
    <div className={styles.stack}>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {items.error ? <Notice tone="error">{items.error}</Notice> : null}

      <Card title="Pay items">
        <p>
          Earnings, after-tax deductions and the employer&apos;s KiwiSaver contribution. Each goes to its own account. Taxable items are
          subject to PAYE, the ACC earners&apos; levy and student loan together (IRD&apos;s payroll specification 5.7 and 5.11).
        </p>
        <label className={ui.checkbox}>
          <input checked={includeArchived} type="checkbox" onChange={(event) => setIncludeArchived(event.target.checked)} />
          Include archived
        </label>
        {items.loading ? <Empty>Loading…</Empty> : items.data?.payItems.length ? (
          <div className={ui.tableWrap}>
            <table className={ui.stackOnPhone}>
              <thead><tr><th>Pay item</th><th>Kind</th><th>Account</th><th>Tax treatment</th>{isAdmin ? <th>Actions</th> : null}</tr></thead>
              <tbody>
                {items.data.payItems.map((item) => (
                  <tr key={item.id}>
                    <td data-label="Pay item">
                      {item.name} {item.isSystem ? <Badge tone="neutral">Built in</Badge> : null}{" "}
                      {item.isArchived ? <Badge tone="neutral">Archived</Badge> : null}
                    </td>
                    <td data-label="Kind">
                      {PAY_ITEM_KIND_NAMES[item.kind]}
                      {item.rateMultiplier ? ` × ${item.rateMultiplier}` : ""}
                    </td>
                    <td data-label="Account">{item.accountCode ? `${item.accountCode} · ${item.accountName}` : "Calculated"}</td>
                    <td data-label="Tax treatment">{describeTreatment(item)}</td>
                    {isAdmin ? (
                      <td data-label="Actions">
                        {item.kind === "kiwisaver_employer" && !item.accountCode ? null : (
                          <div className={ui.actions}>
                            <Button
                              disabled={busy}
                              size="small"
                              variant="secondary"
                              onClick={() => setEditing({ item, name: item.name, accountCode: item.accountCode ?? "", rateMultiplier: item.rateMultiplier ?? "" })}
                            >
                              Change
                            </Button>
                            {item.isSystem ? null : (
                              <Button disabled={busy} size="small" variant="secondary" onClick={() => archive(item)}>
                                {item.isArchived ? "Restore" : "Archive"}
                              </Button>
                            )}
                          </div>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>No pay items.</Empty>}
      </Card>

      {editing ? (
        <Card title={`Change ${editing.item.name}`}>
          <form className={styles.stack} onSubmit={saveEdit}>
            <div className={ui.grid2}>
              <Field label="Name">
                <input maxLength={100} required value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} />
              </Field>
              <Field label="Account">
                <AccountSelect
                  accounts={accountList}
                  filter={accountFilter(editing.item.kind)}
                  required
                  value={editing.accountCode}
                  onChange={(code) => setEditing({ ...editing, accountCode: code })}
                />
              </Field>
              {editing.item.kind === "overtime" ? (
                <Field label="Times the hourly rate">
                  <input inputMode="decimal" required value={editing.rateMultiplier} onChange={(event) => setEditing({ ...editing, rateMultiplier: event.target.value })} />
                </Field>
              ) : null}
            </div>
            <p className={ui.muted}>The kind and tax treatment can&apos;t change; add a new pay item and archive this one instead.</p>
            <div className={ui.actions}>
              <Button disabled={busy} type="submit">Save</Button>
              <Button disabled={busy} variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
            </div>
          </form>
        </Card>
      ) : null}

      {isAdmin ? (
        <Card title="Add a pay item">
          <form className={styles.stack} onSubmit={add}>
            <div className={ui.grid2}>
              <Field label="Name">
                <input maxLength={100} placeholder="Tool allowance" required value={name} onChange={(event) => setName(event.target.value)} />
              </Field>
              <Field label="Kind">
                <select required value={kind} onChange={(event) => { setKind(event.target.value as PayItemKind | ""); setAccountCode(""); }}>
                  <option value="">Choose a kind</option>
                  {ADDABLE.map((value) => <option key={value} value={value}>{PAY_ITEM_KIND_NAMES[value]}</option>)}
                </select>
              </Field>
              <Field label="Account">
                <AccountSelect accounts={accountList} filter={accountFilter(kind)} required value={accountCode} onChange={setAccountCode} />
              </Field>
              {kind === "overtime" ? (
                <Field label="Times the hourly rate">
                  <input inputMode="decimal" required value={rateMultiplier} onChange={(event) => setRateMultiplier(event.target.value)} />
                </Field>
              ) : null}
            </div>
            {kind === "allowance" ? (
              <div className={ui.actions}>
                <label className={ui.checkbox}>
                  <input checked={taxable} type="checkbox" onChange={(event) => setTaxable(event.target.checked)} />
                  Taxable (PAYE, ACC levy and student loan)
                </label>
                <label className={ui.checkbox}>
                  <input checked={taxable && countsForKiwiSaver} disabled={!taxable} type="checkbox" onChange={(event) => setCountsForKiwiSaver(event.target.checked)} />
                  Counts for KiwiSaver
                </label>
              </div>
            ) : null}
            {kind === "reimbursement" ? <p className={ui.muted}>Reimbursements of actual costs aren&apos;t taxed and don&apos;t count for KiwiSaver.</p> : null}
            {kind === "overtime" || kind === "holiday_pay" ? <p className={ui.muted}>Taxable, and counts for KiwiSaver.</p> : null}
            {kind === "after_tax_deduction" ? <p className={ui.muted}>Taken from net pay after tax, for example union fees.</p> : null}
            <p className={ui.muted}>
              Bonuses, back pay, leave, child support and payroll giving aren&apos;t supported yet.
            </p>
            <div className={ui.actions}>
              <Button disabled={busy} type="submit">Add pay item</Button>
            </div>
          </form>
        </Card>
      ) : null}

      <Card title="Approving pay runs">
        {settings.loading ? <Empty>Loading…</Empty> : settings.error ? <Notice tone="error">{settings.error}</Notice> : (
          <label className={ui.checkbox}>
            <input
              checked={settings.data?.settings.approverMustDiffer ?? false}
              disabled={!isAdmin || busy}
              type="checkbox"
              onChange={(event) => changeApprover(event.target.checked)}
            />
            Someone other than the person who prepared a pay run must approve it
          </label>
        )}
        {isAdmin ? null : <p className={ui.muted}>Only admins can change this.</p>}
      </Card>
    </div>
  );
}
