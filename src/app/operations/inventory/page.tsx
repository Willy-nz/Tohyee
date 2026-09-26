"use client";

import Link from "next/link";
import { type FormEvent, useMemo, useState } from "react";
import { AccountSelect, Money, RequireOrganisation, useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Account } from "@/lib/accounts/service";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatMoney, formatQuantity, todayInBrowser } from "@/lib/format";
import type { Movement, MovementType } from "@/lib/inventory/movements";

const TYPES: Array<{ value: MovementType; label: string; help: string }> = [
  { value: "receipt", label: "Stock received", help: "Stock bought in. Other account is usually accounts payable or the bank." },
  { value: "issue", label: "Stock sold or used", help: "Valued at the current average cost. Other account is usually cost of goods sold." },
  { value: "adjustment", label: "Stocktake adjustment", help: "Negative to write stock off (at average cost); positive to add found stock at a cost you give." },
  { value: "customer_return", label: "Customer return", help: "Restocks at the cost of the original sale. Pick the sale it came from." },
  { value: "supplier_return", label: "Return to supplier", help: "Takes stock out at the current average cost." },
  { value: "landed_cost", label: "Landed cost", help: "Freight or duty added to the value of the stock on hand." },
];

const TYPE_LABELS = Object.fromEntries(TYPES.map((type) => [type.value, type.label])) as Record<MovementType, string>;

function defaultOffset(type: MovementType, accounts: Account[]): string {
  const bySystem = (key: string) => accounts.find((account) => account.systemKey === key)?.code ?? "";
  if (type === "receipt" || type === "landed_cost" || type === "supplier_return") {
    return accounts.find((account) => account.code === "2000")?.code ?? "";
  }
  return bySystem("cost_of_goods_sold");
}

function MovementForm({
  organisationId,
  accounts,
  recentIssues,
  onPosted,
}: {
  organisationId: string;
  accounts: Account[];
  recentIssues: Movement[];
  onPosted: (movement: Movement) => void;
}) {
  const inventoryDefault = accounts.find((account) => account.systemKey === "inventory")?.code ?? "";
  const [type, setType] = useState<MovementType>("receipt");
  const [fields, setFields] = useState({
    movementDate: todayInBrowser(),
    itemCode: "",
    quantity: "",
    unitCost: "",
    amount: "",
    reference: "",
    description: "",
    originalMovementId: "",
  });
  const [inventoryAccount, setInventoryAccount] = useState(inventoryDefault);
  const [offsetAccount, setOffsetAccount] = useState(() => defaultOffset("receipt", accounts));
  const [key, setKey] = useState(() => newIdempotencyKey("stock"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const help = TYPES.find((entry) => entry.value === type)?.help;

  function set<K extends keyof typeof fields>(name: K, value: string) {
    setFields((current) => ({ ...current, [name]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ movement: Movement }>("/api/inventory/movements", {
        method: "POST",
        body: {
          organisationId,
          source: "ui",
          idempotencyKey: key,
          movementType: type,
          movementDate: fields.movementDate,
          itemCode: fields.itemCode,
          quantity: type === "adjustment" || type === "landed_cost" ? undefined : fields.quantity,
          quantityDelta: type === "adjustment" ? fields.quantity : undefined,
          unitCost: fields.unitCost || undefined,
          amount: type === "landed_cost" ? fields.amount : undefined,
          reference: fields.reference,
          description: fields.description || undefined,
          originalMovementId: type === "customer_return" ? fields.originalMovementId : undefined,
          inventoryAccountCode: inventoryAccount,
          offsetAccountCode: offsetAccount,
        },
      });
      setKey(newIdempotencyKey("stock"));
      setFields((current) => ({ ...current, quantity: "", unitCost: "", amount: "", reference: "", description: "", originalMovementId: "" }));
      onPosted(result.movement);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const needsUnitCost = type === "receipt" || (type === "adjustment" && fields.quantity !== "" && !fields.quantity.trim().startsWith("-"));

  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid3}>
        <Field label="What happened" hint={help}>
          <select
            value={type}
            onChange={(event) => {
              const next = event.target.value as MovementType;
              setType(next);
              setOffsetAccount(defaultOffset(next, accounts));
            }}
          >
            {TYPES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Date">
          <input type="date" value={fields.movementDate} onChange={(event) => set("movementDate", event.target.value)} required />
        </Field>
        <Field label="Item code">
          <input value={fields.itemCode} onChange={(event) => set("itemCode", event.target.value)} maxLength={50} required />
        </Field>
      </div>
      <div className={ui.grid4}>
        {type !== "landed_cost" ? (
          <Field label={type === "adjustment" ? "Quantity change (+/-)" : "Quantity"}>
            <input inputMode="decimal" value={fields.quantity} onChange={(event) => set("quantity", event.target.value)} required />
          </Field>
        ) : (
          <Field label="Amount">
            <input inputMode="decimal" value={fields.amount} onChange={(event) => set("amount", event.target.value)} required />
          </Field>
        )}
        {needsUnitCost ? (
          <Field label="Unit cost (excl. GST)">
            <input inputMode="decimal" value={fields.unitCost} onChange={(event) => set("unitCost", event.target.value)} required />
          </Field>
        ) : null}
        {type === "customer_return" ? (
          <Field label="Original sale">
            <select value={fields.originalMovementId} onChange={(event) => set("originalMovementId", event.target.value)} required>
              <option value="">Choose the sale</option>
              {recentIssues
                .filter((issue) => !fields.itemCode || issue.itemCode === fields.itemCode)
                .map((issue) => (
                  <option key={issue.id} value={issue.id}>
                    #{issue.id} · {formatDate(issue.movementDate)} · {issue.itemCode} × {formatQuantity(issue.quantityDelta.replace("-", ""))}
                  </option>
                ))}
            </select>
          </Field>
        ) : null}
        <Field label="Reference">
          <input value={fields.reference} onChange={(event) => set("reference", event.target.value)} maxLength={100} required />
        </Field>
      </div>
      <div className={ui.grid3}>
        <Field label="Inventory account">
          <AccountSelect
            accounts={accounts}
            value={inventoryAccount}
            onChange={setInventoryAccount}
            filter={(account) => account.accountClass === "asset"}
            required
          />
        </Field>
        <Field label="Other account">
          <AccountSelect accounts={accounts} value={offsetAccount} onChange={setOffsetAccount} required />
        </Field>
        <Field label="Description">
          <input value={fields.description} onChange={(event) => set("description", event.target.value)} maxLength={500} />
        </Field>
      </div>
      <div className={ui.actions}>
        <Button type="submit" disabled={busy}>
          {busy ? "Posting…" : "Post stock movement"}
        </Button>
        <span className={ui.muted}>Posts the stock change and its journal together.</span>
      </div>
    </form>
  );
}

function Inventory({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const accounts = useAccounts(organisationId);
  const movements = useApiData<{ movements: Movement[] }>("/api/inventory/movements", { organisationId });
  const [message, setMessage] = useState<string | null>(null);
  const recentIssues = useMemo(
    () => (movements.data?.movements ?? []).filter((movement) => movement.movementType === "issue"),
    [movements.data],
  );

  return (
    <>
      <Notice tone="info">
        Stock is costed at weighted average and always matches the inventory account to the cent. Movements dated before an
        item&apos;s latest movement aren&apos;t accepted yet, because every later sale would need re-costing.
      </Notice>
      {message ? <Notice tone="success">{message}</Notice> : null}
      {can("bookkeeper") ? (
        <Card title="Record a stock movement">
          {accounts.data ? (
            <MovementForm
              organisationId={organisationId}
              accounts={accounts.data.accounts}
              recentIssues={recentIssues}
              onPosted={(movement) => {
                setMessage(
                  `Posted ${TYPE_LABELS[movement.movementType].toLowerCase()} for ${movement.itemCode}: ${formatMoney(movement.valueDelta)} (journal #${movement.ledgerJournalId}).`,
                );
                movements.reload();
              }}
            />
          ) : (
            <p className={ui.muted}>{accounts.error ?? "Loading accounts…"}</p>
          )}
        </Card>
      ) : null}
      <Card title="Recent movements">
        {movements.error ? <Notice tone="error">{movements.error}</Notice> : null}
        {movements.data && movements.data.movements.length === 0 ? (
          <Empty>No stock movements yet.</Empty>
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Date</th>
                  <th>Item</th>
                  <th>What</th>
                  <th className={ui.num}>Qty</th>
                  <th className={ui.num}>Unit cost</th>
                  <th className={ui.num}>Value</th>
                  <th className={ui.num}>On hand after</th>
                  <th>Journal</th>
                </tr>
              </thead>
              <tbody>
                {(movements.data?.movements ?? []).map((movement) => (
                  <tr key={movement.id}>
                    <td>{movement.id}</td>
                    <td>{formatDate(movement.movementDate)}</td>
                    <td>{movement.itemCode}</td>
                    <td>
                      <Badge tone={movement.valueDelta.startsWith("-") ? "amber" : "green"}>{TYPE_LABELS[movement.movementType]}</Badge>
                    </td>
                    <td className={ui.num}>{formatQuantity(movement.quantityDelta)}</td>
                    <td className={ui.num}>{movement.unitCost ? formatMoney(movement.unitCost, 4) : ""}</td>
                    <td className={ui.num}>
                      <Money value={movement.valueDelta} />
                    </td>
                    <td className={ui.num}>
                      {formatQuantity(movement.quantityAfter)} · <Money value={movement.valueAfter} />
                    </td>
                    <td>
                      <Link href={`/operations/ledger-journals?journal=${movement.ledgerJournalId}`}>#{movement.ledgerJournalId}</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

export default function InventoryPage() {
  return (
    <Page>
      <PageHeader title="Stock" description="Stock movements and their journals, posted together." />
      <RequireOrganisation>{(organisationId) => <Inventory key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
