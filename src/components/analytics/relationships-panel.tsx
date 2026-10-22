"use client";

import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Button, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import styles from "./chart-format-panel.module.css";

type Relationship = { id: string; table: string; field: string; dimension: string; dimensionField: string; name: string };
type TableInfo = { name: string; columns: Array<{ name: string; type: string; calculated?: true; related?: string }> };

const label = (name: string) => name.replace(/^tohyee_/, "").replaceAll("_", " ");

/**
 * The chart's table's related tables (decision 774): each of its rows
 * matches one row of another table on a key, so the chart can use that
 * table's fields as <name>.<field>. Checked on the data when it's added;
 * a key that isn't different on every row of the other table is refused.
 */
export function RelationshipsPanel({ organisationId, table, tables, canEdit, onChanged }: { organisationId: string; table: string; tables: TableInfo[]; canEdit: boolean; onChanged: () => void }) {
  const listed = useApiData<{ relationships: Relationship[] }>(table ? "/api/analytics/relationships" : null, { organisationId });
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [field, setField] = useState("");
  const [dimension, setDimension] = useState("");
  const [dimensionField, setDimensionField] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const own = (entry: TableInfo | undefined) => (entry?.columns ?? []).filter((column) => !column.calculated && !column.related);
  const relationships = (listed.data?.relationships ?? []).filter((relationship) => relationship.table === table);
  const others = tables.filter((entry) => entry.name !== table);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ relationship: Relationship; note: string | null }>("/api/analytics/relationships", { method: "POST", body: { organisationId, table, field, dimension, dimensionField, name } });
      setMessage(`Saved. Fields from ${label(result.relationship.dimension)} are now ${result.relationship.name}.<field> on this table.${result.note ? ` ${result.note}` : ""}`);
      setAdding(false);
      listed.reload();
      onChanged();
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (relationship: Relationship) => {
    if (!(await confirm("Charts can't use its fields once it's gone. One that's in use can't be removed.", { title: `Remove ${relationship.name}?`, confirmLabel: "Remove", danger: true }))) return;
    try {
      await api(`/api/analytics/relationships/${relationship.id}`, { method: "DELETE", query: { organisationId } });
      setMessage(`Removed ${relationship.name}.`);
      listed.reload();
      onChanged();
    } catch (problem) {
      setMessage(errorMessage(problem));
    }
  };
  if (!table) return null;
  return (
    <details className={styles.meaning} style={{ gridColumn: "1 / -1" }}>
      <summary>Related tables ({relationships.length})</summary>
      <p className={ui.muted}>Use another table&apos;s fields here when each row of this table matches one of its rows, e.g. invoice lines and their invoice. A table with two rows for one match can&apos;t be related (it would count amounts twice).</p>
      {listed.error ? <Notice tone="error">{listed.error}</Notice> : null}
      {message ? <p role="status" className={ui.muted}>{message}</p> : null}
      {relationships.length ? (
        <ul className={styles.fieldList}>
          {relationships.map((relationship) => (
            <li key={relationship.id}>
              <strong>{relationship.name}</strong>
              <span className={ui.muted}>
                {label(relationship.field)} matches {label(relationship.dimension)} › {label(relationship.dimensionField)}
              </span>
              {canEdit ? (
                <span className={styles.fieldActions}>
                  <Button size="small" variant="danger" onClick={() => remove(relationship)} aria-label={`Remove ${relationship.name}`}>Remove</Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canEdit && !adding ? (
        <Button size="small" variant="secondary" onClick={() => { setAdding(true); setMessage(null); }}>
          Add a related table
        </Button>
      ) : null}
      {adding ? (
        <div className={styles.fieldForm}>
          <Field label="This table's column">
            <select value={field} onChange={(event) => setField(event.target.value)}>
              <option value="">Choose a column</option>
              {own(tables.find((entry) => entry.name === table)).map((column) => <option key={column.name} value={column.name}>{label(column.name)}</option>)}
            </select>
          </Field>
          <Field label="Matches one row of">
            <select value={dimension} onChange={(event) => { setDimension(event.target.value); setDimensionField(""); if (!name) setName(event.target.value.replace(/^tohyee_/, "").replace(/s$/, "")); }}>
              <option value="">Choose a table</option>
              {others.map((entry) => <option key={entry.name} value={entry.name}>{label(entry.name)}</option>)}
            </select>
          </Field>
          <Field label="By its column">
            <select value={dimensionField} onChange={(event) => setDimensionField(event.target.value)} disabled={!dimension}>
              <option value="">Choose a column</option>
              {own(tables.find((entry) => entry.name === dimension)).map((column) => <option key={column.name} value={column.name}>{label(column.name)}</option>)}
            </select>
          </Field>
          <Field label="Name" hint="Its fields are then name.field, e.g. customer.region.">
            <input value={name} maxLength={31} onChange={(event) => setName(event.target.value)} />
          </Field>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <div className={styles.fieldActions}>
            <Button size="small" onClick={save} disabled={busy || !field || !dimension || !dimensionField}>
              {busy ? "Checking…" : "Check and save"}
            </Button>
            <Button size="small" variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </details>
  );
}
