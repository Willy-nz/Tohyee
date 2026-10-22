"use client";

import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Button, Field, Notice, ui } from "@/components/ui";
import type { NumberFormat } from "@/lib/analytics/chart-format";
import { definitionToSave, measureFromSaved, type SavedMeasure } from "@/lib/analytics/measure-library";
import { describeMeasure } from "@/lib/analytics/measure-definition";
import { describeQuickCalc, quickTotalsText, quickUnit } from "@/lib/analytics/quick-calcs";
import { formatOfType, type ColumnInfo, type Filter, type Measure } from "@/lib/analytics/query";
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
    ...(measure.snapshot ? [`the latest balance in each period${measure.snapshot.per ? ` for each ${measure.snapshot.per.replaceAll("_", " ")}` : ""}`] : []),
    ...(measure.inputs?.length ? [`uses ${measure.inputs.map((input) => input.name).join(", ")}`] : []),
  ];
  if (!rules.length) return null;
  return <p className={ui.muted}>Only counts: {rules.join(" · ")}</p>;
}

/** What a value means (decision 696), worked out from its definition: shown folded under the value. */
export function ValueMeaning({
  measure,
  table,
  columns,
  dateField,
  place,
}: {
  measure: Measure;
  table: string;
  columns: ColumnInfo[];
  dateField: string | null;
  /** Where the value is, for what its quick calculation (decision 770) is of. */
  place?: { dated: boolean; breakdown: boolean; pivot: boolean };
}) {
  if (!table) return null;
  const meaning = describeMeasure(measure, table, columns, dateField);
  const shown = measure.quick ? describeQuickCalc(measure.quick, place ?? { dated: false, breakdown: false, pivot: false }) : null;
  return (
    <details className={styles.meaning}>
      <summary>What {measure.label || "this value"} means</summary>
      <dl>
        <dt>One row is</dt>
        <dd>{meaning.row}</dd>
        <dt>Worked out as</dt>
        <dd>{meaning.aggregation}</dd>
        <dt>Unit</dt>
        <dd>{measure.quick ? quickUnit(measure.quick, meaning.unit) : meaning.unit}</dd>
        <dt>Movement or balance</dt>
        <dd>{meaning.kind}</dd>
        <dt>Dates</dt>
        <dd>{meaning.date}</dd>
        <dt>Blanks and zero</dt>
        <dd>{meaning.blanks}</dd>
        <dt>Totals</dt>
        <dd>{shown ? quickTotalsText(measure.quick!.kind) : meaning.totals}</dd>
        {shown ? (
          <>
            <dt>Shown as</dt>
            <dd>{shown}</dd>
          </>
        ) : null}
      </dl>
    </details>
  );
}

/**
 * A value's currency column and whether each row is a balance recorded on
 * its date (decisions 694-695), folded away under the value.
 */
export function ValueKindFields({
  index,
  measure,
  columns,
  pivot,
  onChange,
}: {
  index: number;
  measure: Measure;
  columns: ColumnInfo[];
  pivot: boolean;
  onChange: (patch: Partial<Measure>) => void;
}) {
  if (!["sum", "avg", "min", "max"].includes(measure.aggregate)) return null;
  const texts = columns.filter((column) => formatOfType(column.type) === "text");
  return (
    <details className={styles.meaning}>
      <summary>Currency and balances</summary>
      <Field label="Amounts are in the currency named in" hint="Amounts in different currencies are never added together. Leave as one currency when every row is in the same one.">
        <select aria-label={`Value ${index + 1} currency column`} value={measure.currencyField ?? ""} onChange={(event) => onChange({ currencyField: event.target.value || undefined })}>
          <option value="">One currency (or the table&apos;s own currency column)</option>
          {texts.map((column) => (
            <option key={column.name} value={column.name}>
              {column.name.replaceAll("_", " ")}
            </option>
          ))}
        </select>
      </Field>
      {measure.aggregate === "sum" && !pivot ? (
        <>
          <label className={ui.checkbox}>
            <input
              type="checkbox"
              checked={Boolean(measure.snapshot)}
              onChange={(event) => onChange({ snapshot: event.target.checked ? {} : undefined, ...(event.target.checked ? { asAt: undefined } : {}) })}
            />{" "}
            Each row is a balance on its date (use the latest in each period; don&apos;t add dates up)
          </label>
          {measure.snapshot ? (
            <Field label="Latest balance for each" hint="E.g. each account. Leave blank when there's one balance a date.">
              <select aria-label={`Value ${index + 1} balance for each`} value={measure.snapshot.per ?? ""} onChange={(event) => onChange({ snapshot: event.target.value ? { per: event.target.value } : {} })}>
                <option value="">One balance a date</option>
                {texts.map((column) => (
                  <option key={column.name} value={column.name}>
                    {column.name.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
        </>
      ) : null}
    </details>
  );
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
