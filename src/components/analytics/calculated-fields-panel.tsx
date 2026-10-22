"use client";

import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Button, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import styles from "./chart-format-panel.module.css";

type Field = { id: string; table: string; name: string; formula: string; description: string | null; type: string | null; error?: string };

const TYPE_WORDS: Record<string, string> = {
  "DECIMAL(38,2)": "money",
  "DECIMAL(38,6)": "number",
  BIGINT: "whole number",
  VARCHAR: "text",
  DATE: "date",
  BOOLEAN: "yes or no",
};

/**
 * A data source's calculated fields (decision 772), under the chart's data
 * source: each one's formula and kind, and adding, changing or removing
 * one. A field is shared by every report on the table, so a change says
 * which reports use it.
 */
export function CalculatedFieldsPanel({ organisationId, table, canEdit, onChanged }: { organisationId: string; table: string; canEdit: boolean; onChanged: () => void }) {
  const listed = useApiData<{ fields: Field[]; functions: string[] }>(table ? "/api/analytics/fields" : null, { organisationId });
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Field | "new" | null>(null);
  const [name, setName] = useState("");
  const [formula, setFormula] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fields = (listed.data?.fields ?? []).filter((field) => field.table === table);

  const open = (field: Field | "new") => {
    setEditing(field);
    setName(field === "new" ? "" : field.name);
    setFormula(field === "new" ? "" : field.formula);
    setDescription(field === "new" ? "" : field.description ?? "");
    setError(null);
    setMessage(null);
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (editing === "new") {
        await api("/api/analytics/fields", { method: "POST", body: { organisationId, table, name, formula, description } });
        setMessage(`Saved ${name}. It's now one of ${table}'s fields for every report.`);
      } else if (editing) {
        const result = await api<{ field: { usedBy: string[] } }>(`/api/analytics/fields/${editing.id}`, { method: "PATCH", body: { organisationId, name, formula, description } });
        setMessage(result.field.usedBy.length ? `Saved. ${result.field.usedBy.join(", ")} now use${result.field.usedBy.length === 1 ? "s" : ""} the new formula.` : "Saved.");
      }
      setEditing(null);
      listed.reload();
      onChanged();
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (field: Field) => {
    if (!(await confirm("Reports can't use it once it's gone. One that's in use can't be removed.", { title: `Remove ${field.name}?`, confirmLabel: "Remove", danger: true }))) return;
    try {
      await api(`/api/analytics/fields/${field.id}`, { method: "DELETE", query: { organisationId } });
      setMessage(`Removed ${field.name}.`);
      listed.reload();
      onChanged();
    } catch (problem) {
      setMessage(errorMessage(problem));
    }
  };

  if (!table) return null;
  return (
    <details className={styles.meaning} style={{ gridColumn: "1 / -1" }}>
      <summary>Calculated fields on this data source ({fields.length})</summary>
      <p className={ui.muted}>A formula worked out on each row, e.g. IF([amount] &gt;= 1000, &quot;Large&quot;, &quot;Small&quot;). It&apos;s then one of the table&apos;s fields for every report.</p>
      {listed.error ? <Notice tone="error">{listed.error}</Notice> : null}
      {message ? <p role="status" className={ui.muted}>{message}</p> : null}
      {fields.length ? (
        <ul className={styles.fieldList}>
          {fields.map((field) => (
            <li key={field.id}>
              <strong>{field.name.replaceAll("_", " ")}</strong> <span className={ui.muted}>({field.type ? TYPE_WORDS[field.type] ?? field.type : "not working"})</span>
              <code className={styles.fieldFormula}>{field.formula}</code>
              {field.description ? <span className={ui.muted}>{field.description}</span> : null}
              {field.error ? <Notice tone="warning">{field.error}</Notice> : null}
              {canEdit ? (
                <span className={styles.fieldActions}>
                  <Button size="small" variant="secondary" onClick={() => open(field)} aria-label={`Change ${field.name}`}>Change</Button>
                  <Button size="small" variant="danger" onClick={() => remove(field)} aria-label={`Remove ${field.name}`}>Remove</Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canEdit && !editing ? (
        <Button size="small" variant="secondary" onClick={() => open("new")}>
          Add a calculated field
        </Button>
      ) : null}
      {editing ? (
        <div className={styles.fieldForm}>
          <Field label="Name" hint="Small letters, numbers and underscores, e.g. size_band.">
            <input value={name} maxLength={63} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Formula" hint="Columns in square brackets, text in quotes.">
            <textarea value={formula} rows={3} maxLength={1000} onChange={(event) => setFormula(event.target.value)} spellCheck={false} />
          </Field>
          <Field label="Description (optional)">
            <input value={description} maxLength={300} onChange={(event) => setDescription(event.target.value)} />
          </Field>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <details>
            <summary>What a formula can use</summary>
            <ul>
              {(listed.data?.functions ?? []).map((entry) => (
                <li key={entry}>
                  <code>{entry}</code>
                </li>
              ))}
            </ul>
          </details>
          <div className={styles.fieldActions}>
            <Button size="small" onClick={save} disabled={busy || !name.trim() || !formula.trim()}>
              {busy ? "Saving…" : "Save field"}
            </Button>
            <Button size="small" variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </details>
  );
}
