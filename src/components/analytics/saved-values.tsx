"use client";

import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Button, Field, Notice, ui } from "@/components/ui";
import type { NumberFormat } from "@/lib/analytics/chart-format";
import { definitionToSave, measureFromSaved, type SavedMeasure } from "@/lib/analytics/measure-library";
import type { Filter, Measure } from "@/lib/analytics/query";
import { api, errorMessage } from "@/lib/client/api";
import styles from "./chart-format-panel.module.css";

const OP_WORDS: Record<string, string> = {
  eq: "is",
  neq: "is not",
  in: "is one of",
  not_in: "is not one of",
  contains: "contains",
  gt: "more than",
  gte: "at least",
  lt: "less than",
  lte: "at most",
  blank: "is blank",
  not_blank: "is not blank",
  between: "is between",
  last_days: "is in the last days:",
  last_months: "is in the last months:",
  this_financial_year: "is this financial year",
  last_financial_year: "is last financial year",
};

function describeFilter(filter: Filter): string {
  const value = Array.isArray(filter.value) ? filter.value.join(filter.op === "between" ? " and " : ", ") : filter.value;
  return `${filter.field.replaceAll("_", " ")} ${OP_WORDS[filter.op] ?? filter.op}${value ? ` ${value}` : ""}`;
}

/** What a value from a saved or built-in value counts, in words (its conditions can't be changed here). */
export function ValueRules({ measure }: { measure: Measure }) {
  const rules = [
    ...(measure.where ?? []).map(describeFilter),
    ...(measure.asAt ? ["a balance as at the To date"] : []),
    ...(measure.inputs?.length ? [`uses ${measure.inputs.map((input) => input.name).join(", ")}`] : []),
  ];
  if (!rules.length) return null;
  return <p className={ui.muted}>Only counts: {rules.join(" · ")}</p>;
}

/** A calculated value's formula (#337): the other values by name in square brackets, + - * / and brackets. */
export function FormulaField({ index, measure, siblings, onChange }: { index: number; measure: Measure; siblings: Measure[]; onChange: (formula: string) => void }) {
  const names = siblings.filter((other) => other !== measure && other.aggregate !== "formula").map((other) => `[${other.label}]`);
  return (
    <Field
      label="Formula"
      hint={
        <>
          Use {names.length ? names.join(", ") : "the chart's other values by name in square brackets"}
          {measure.inputs?.length ? `, ${measure.inputs.map((input) => `[${input.name}]`).join(", ")}` : ""}, numbers, + - * / and brackets, and
          {" "}<code>days</code> (the days in the dashboard&apos;s dates). For a percentage, choose it in Format.
        </>
      }
    >
      <textarea aria-label={`Value ${index + 1} formula`} rows={2} maxLength={500} value={measure.formula ?? ""} placeholder="[Sales] - [Costs]" onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

/**
 * Adding a saved value (the books copy's built-in ones, or values saved on
 * this data source), and removing saved ones.
 */
export function SavedValuesPicker({
  organisationId,
  table,
  disabled,
  version,
  onAdd,
}: {
  organisationId: string;
  table: string;
  disabled: boolean;
  /** Changes when a value is saved, to load the list again. */
  version: number;
  onAdd: (measure: Measure, number?: NumberFormat) => void;
}) {
  const confirm = useConfirm();
  const list = useApiData<{ measures: SavedMeasure[] }>("/api/analytics/measures", { organisationId, version });
  const [chosen, setChosen] = useState("");
  const [error, setError] = useState<string | null>(null);
  const measures = (list.data?.measures ?? []).filter((measure) => measure.table === table);
  const builtIn = measures.filter((measure) => measure.id === null);
  const saved = measures.filter((measure) => measure.id !== null);
  if (!measures.length) return null;
  const key = (measure: SavedMeasure) => measure.id ?? `built-in:${measure.name}`;
  return (
    <div className={styles.group}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={styles.pair}>
        <Field label="Add a saved value">
          <select value={chosen} onChange={(event) => setChosen(event.target.value)}>
            <option value="">Choose…</option>
            {builtIn.length ? (
              <optgroup label="Built in (as on the profit and loss)">
                {builtIn.map((measure) => <option key={key(measure)} value={key(measure)}>{measure.name}</option>)}
              </optgroup>
            ) : null}
            {saved.length ? (
              <optgroup label="Saved on this data source">
                {saved.map((measure) => <option key={key(measure)} value={key(measure)}>{measure.name}</option>)}
              </optgroup>
            ) : null}
          </select>
        </Field>
        <Button
          size="small"
          variant="secondary"
          disabled={disabled || !chosen}
          onClick={() => {
            const measure = measures.find((entry) => key(entry) === chosen);
            if (!measure) return;
            onAdd(measureFromSaved(measure), measure.number);
            setChosen("");
          }}
        >
          Add
        </Button>
      </div>
      {chosen ? <p className={ui.muted}>{measures.find((entry) => key(entry) === chosen)?.description}</p> : null}
      {saved.length ? (
        <details>
          <summary>Saved values on this data source</summary>
          <ul className={styles.savedList}>
            {saved.map((measure) => (
              <li key={key(measure)}>
                <span>{measure.name}</span>
                <Button
                  size="small"
                  variant="danger"
                  onClick={async () => {
                    const ok = await confirm(`Remove the saved value ${measure.name}? Charts already using it keep working.`, { title: "Remove saved value?", confirmLabel: "Remove", danger: true });
                    if (!ok) return;
                    try {
                      await api(`/api/analytics/measures/${measure.id}`, { method: "DELETE", query: { organisationId } });
                      list.reload();
                    } catch (caught) {
                      setError(errorMessage(caught));
                    }
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** Saves one of the chart's values on its data source, under its name, for other charts to use. */
export function SaveValueButton({
  organisationId,
  table,
  measure,
  siblings,
  number,
  onSaved,
}: {
  organisationId: string;
  table: string;
  measure: Measure;
  siblings: Measure[];
  number?: NumberFormat;
  onSaved: () => void;
}) {
  const [state, setState] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button
        size="small"
        variant="secondary"
        disabled={busy || !measure.label.trim()}
        onClick={async () => {
          setBusy(true);
          setState(null);
          try {
            const definition = definitionToSave(measure, siblings);
            await api("/api/analytics/measures", { method: "POST", body: { organisationId, table, name: measure.label.trim(), definition, ...(number ? { number } : {}) } });
            setState({ tone: "success", text: `Saved as ${measure.label.trim()} on this data source.` });
            onSaved();
          } catch (caught) {
            setState({ tone: "error", text: errorMessage(caught) });
          } finally {
            setBusy(false);
          }
        }}
      >
        Save for other charts
      </Button>
      {state ? <span role="status" className={state.tone === "error" ? styles.error : ui.muted}>{state.text}</span> : null}
    </>
  );
}
