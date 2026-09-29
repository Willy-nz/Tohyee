"use client";

import { type FormEvent, useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import {
  CONTACT_USES,
  CUSTOM_FIELD_RECORD_LABELS,
  CUSTOM_FIELD_RECORDS,
  CUSTOM_FIELD_TYPE_LABELS,
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_USE_LABELS,
  type CustomField,
  type CustomFieldRecord,
  type CustomFieldSetup,
  type CustomFieldType,
  type CustomFieldUse,
  type CustomValue,
  type CustomValues,
  customValueText,
  defaultValues,
  DOCUMENT_KINDS,
  fieldsFor,
} from "@/lib/custom-fields/values";

/**
 * Custom fields on screen (examples CF1-CF10): the setup hook, inputs for a
 * record or a line, values as text, list columns and the settings screen.
 * Nothing shows unless advanced features are on (or a record already has
 * values).
 */
export function useCustomFields(organisationId: string | null) {
  return useApiData<CustomFieldSetup>(organisationId ? "/api/custom-fields" : null, { organisationId });
}

/** The fields to show on a record: none unless advanced features are on, except values it already has. */
export function visibleFields(
  setup: CustomFieldSetup | null | undefined,
  record: CustomFieldRecord,
  uses: readonly CustomFieldUse[],
  values: CustomValues = {},
): CustomField[] {
  if (!setup) return [];
  if (!setup.advancedFeatures) return setup.fields.filter((field) => field.record === record && values[field.id] !== undefined);
  return fieldsFor(setup.fields, record, uses, values);
}

/** A new record's values: each field's default, while advanced features are on. */
export function startingValues(setup: CustomFieldSetup | null | undefined, record: CustomFieldRecord, uses: readonly CustomFieldUse[]): CustomValues {
  return setup?.advancedFeatures ? defaultValues(setup.fields, record, uses) : {};
}

function isBlank(value: CustomValue | undefined): boolean {
  return value === undefined || value === "" || value === false || (Array.isArray(value) && value.length === 0);
}

function FieldInput({
  field,
  value,
  onChange,
  disabled,
  ariaLabel,
  compact,
  id,
  "aria-describedby": describedBy,
}: {
  field: CustomField;
  value: CustomValue | undefined;
  onChange: (value: CustomValue | undefined) => void;
  disabled?: boolean;
  ariaLabel?: string;
  compact?: boolean;
  /** Set by Field, so its label and hint belong to the input. */
  id?: string;
  "aria-describedby"?: string;
}) {
  const set = (next: CustomValue | undefined) => onChange(isBlank(next) ? undefined : next);
  const text = typeof value === "string" ? value : "";
  const common = {
    id,
    "aria-label": ariaLabel,
    "aria-describedby": describedBy,
    disabled,
    title: field.help ?? field.label,
    placeholder: compact ? field.label : undefined,
  };
  switch (field.type) {
    case "checkbox":
      return (
        <label className={ui.checkbox} title={field.help ?? field.label}>
          <input
            type="checkbox"
            id={id}
            aria-label={ariaLabel}
            aria-describedby={describedBy}
            disabled={disabled}
            checked={value === true}
            onChange={(event) => set(event.target.checked)}
          />
          {compact ? ` ${field.label}` : " Yes"}
        </label>
      );
    case "list":
      return (
        <select {...common} value={text} onChange={(event) => set(event.target.value)}>
          <option value="">{compact ? `${field.label}${field.isRequired ? " (required)" : ""}` : "Choose"}</option>
          {field.options
            .filter((option) => option.isActive || option.id === text)
            .map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
                {option.isActive ? "" : " (archived)"}
              </option>
            ))}
        </select>
      );
    case "multi_select": {
      const chosen = Array.isArray(value) ? value : [];
      return (
        <select
          {...common}
          multiple
          size={Math.min(4, Math.max(2, field.options.length))}
          value={chosen}
          onChange={(event) => set(Array.from(event.target.selectedOptions).map((option) => option.value))}
        >
          {field.options
            .filter((option) => option.isActive || chosen.includes(option.id))
            .map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
                {option.isActive ? "" : " (archived)"}
              </option>
            ))}
        </select>
      );
    }
    case "long_text":
      return compact ? (
        <input {...common} value={text} maxLength={4000} onChange={(event) => set(event.target.value)} />
      ) : (
        <textarea {...common} rows={3} value={text} maxLength={4000} onChange={(event) => set(event.target.value)} />
      );
    case "date":
      return <input {...common} type="date" value={text} onChange={(event) => set(event.target.value)} />;
    case "integer":
    case "decimal":
    case "money":
    case "percent":
      return <input {...common} inputMode="decimal" value={text} onChange={(event) => set(event.target.value)} />;
    case "email":
      return <input {...common} type="email" value={text} maxLength={254} onChange={(event) => set(event.target.value)} />;
    case "phone":
      return <input {...common} type="tel" value={text} maxLength={32} onChange={(event) => set(event.target.value)} />;
    case "url":
      return <input {...common} type="url" value={text} maxLength={999} onChange={(event) => set(event.target.value)} />;
    default:
      return <input {...common} value={text} maxLength={300} onChange={(event) => set(event.target.value)} />;
  }
}

/**
 * Inputs for a record's custom fields. `compact` is for a line: small inputs
 * in a row, labelled by placeholder; otherwise each field is a labelled
 * field in a grid.
 */
export function CustomFieldInputs({
  setup,
  record,
  uses,
  value,
  onChange,
  disabled,
  labelPrefix,
  compact,
}: {
  setup: CustomFieldSetup | null | undefined;
  record: CustomFieldRecord;
  uses: readonly CustomFieldUse[];
  value: CustomValues;
  onChange: (values: CustomValues) => void;
  disabled?: boolean;
  labelPrefix?: string;
  compact?: boolean;
}) {
  const fields = visibleFields(setup, record, uses, value);
  if (fields.length === 0) return null;
  const change = (id: string, next: CustomValue | undefined) => {
    const copy = { ...value };
    if (next === undefined) delete copy[id];
    else copy[id] = next;
    onChange(copy);
  };
  if (compact) {
    return (
      <div className={ui.trackingSelects}>
        {fields.map((field) => (
          <FieldInput
            key={field.id}
            compact
            field={field}
            value={value[field.id]}
            disabled={disabled}
            ariaLabel={`${labelPrefix ? `${labelPrefix} ` : ""}${field.label}`}
            onChange={(next) => change(field.id, next)}
          />
        ))}
      </div>
    );
  }
  return (
    <div className={ui.grid3}>
      {fields.map((field) => (
        <Field
          key={field.id}
          label={`${field.label}${field.isRequired ? " (required)" : ""}${field.isActive ? "" : " (archived)"}`}
          hint={field.help ?? undefined}
        >
          <FieldInput field={field} value={value[field.id]} disabled={disabled} onChange={(next) => change(field.id, next)} />
        </Field>
      ))}
    </div>
  );
}

/** "Pet name: Rex · Channel: Market", or nothing. */
export function customValuesText(setup: CustomFieldSetup | null | undefined, values: CustomValues | undefined): string {
  if (!setup || !values) return "";
  return setup.fields
    .filter((field) => values[field.id] !== undefined)
    .map((field) => `${field.label}: ${customValueText(field, values[field.id])}`)
    .join(" · ");
}

export function CustomValuesText({ setup, values }: { setup: CustomFieldSetup | null | undefined; values: CustomValues | undefined }) {
  const text = customValuesText(setup, values);
  return text ? <div className={ui.muted}>{text}</div> : null;
}

/** Fields shown as columns on a list of records ("show in list"). */
export function listColumns(setup: CustomFieldSetup | null | undefined, record: CustomFieldRecord, uses: readonly CustomFieldUse[]): CustomField[] {
  if (!setup?.advancedFeatures) return [];
  return setup.fields.filter((field) => field.record === record && field.isActive && field.showInList && field.usedOn.some((use) => uses.includes(use)));
}

export function CustomValueCell({ field, values }: { field: CustomField; values: CustomValues | undefined }) {
  return <td>{customValueText(field, values?.[field.id])}</td>;
}

// ---------------------------------------------------------------------------
// Settings › Custom fields (CF1, CF7)

const USES_BY_RECORD: Record<CustomFieldRecord, readonly CustomFieldUse[]> = {
  contact: CONTACT_USES,
  document: DOCUMENT_KINDS,
  line: DOCUMENT_KINDS,
};

function UsesPicker({ record, value, onChange }: { record: CustomFieldRecord; value: CustomFieldUse[]; onChange: (uses: CustomFieldUse[]) => void }) {
  return (
    <div className={ui.actions} role="group" aria-label="Used on">
      {USES_BY_RECORD[record].map((use) => (
        <label key={use} className={ui.checkbox}>
          <input
            type="checkbox"
            checked={value.includes(use)}
            onChange={(event) => onChange(event.target.checked ? [...value, use] : value.filter((entry) => entry !== use))}
          />{" "}
          {CUSTOM_FIELD_USE_LABELS[use]}
        </label>
      ))}
    </div>
  );
}

function usesText(field: CustomField): string {
  return field.usedOn.map((use) => CUSTOM_FIELD_USE_LABELS[use]).join(", ");
}

function NewFieldForm({ organisationId, onSaved }: { organisationId: string; onSaved: (setup: CustomFieldSetup, message: string) => void }) {
  const [record, setRecord] = useState<CustomFieldRecord>("contact");
  const [label, setLabel] = useState("");
  const [type, setType] = useState<CustomFieldType>("text");
  const [usedOn, setUsedOn] = useState<CustomFieldUse[]>(["customer"]);
  const [help, setHelp] = useState("");
  const [isRequired, setIsRequired] = useState(false);
  const [showInList, setShowInList] = useState(false);
  const [options, setOptions] = useState("");
  const [defaultValue, setDefaultValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasOptions = type === "list" || type === "multi_select";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const optionNames = options
        .split("\n")
        .map((name) => name.trim())
        .filter(Boolean);
      const setup = await api<CustomFieldSetup>("/api/custom-fields", {
        method: "POST",
        body: {
          organisationId,
          record,
          label,
          type,
          usedOn,
          help: help || null,
          isRequired: type === "checkbox" ? false : isRequired,
          showInList,
          options: hasOptions ? optionNames : undefined,
          defaultValue: type === "checkbox" ? (defaultValue === "yes" ? true : undefined) : defaultValue || undefined,
        },
      });
      onSaved(setup, `Added ${label.trim()}.`);
      setLabel("");
      setHelp("");
      setOptions("");
      setDefaultValue("");
      setIsRequired(false);
      setShowInList(false);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Add a custom field" description="Extra information on contacts, documents or lines. It never changes an amount, an account or a GST box.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }}>
        <div className={ui.grid3}>
          <Field label="It's on" hint="Can't be changed later.">
            <select
              value={record}
              onChange={(event) => {
                const next = event.target.value as CustomFieldRecord;
                setRecord(next);
                setUsedOn(next === "contact" ? ["customer"] : ["invoice"]);
              }}
            >
              {CUSTOM_FIELD_RECORDS.map((entry) => (
                <option key={entry} value={entry}>
                  {CUSTOM_FIELD_RECORD_LABELS[entry]}
                  {entry === "document" ? " (the top of a document)" : entry === "line" ? " (each line of a document)" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Label">
            <input value={label} maxLength={60} onChange={(event) => setLabel(event.target.value)} required />
          </Field>
          <Field label="Type" hint="Can't be changed later.">
            <select value={type} onChange={(event) => setType(event.target.value as CustomFieldType)}>
              {CUSTOM_FIELD_TYPES.map((entry) => (
                <option key={entry} value={entry}>
                  {CUSTOM_FIELD_TYPE_LABELS[entry]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Help text" hint="Optional. Shown next to the field.">
            <input value={help} maxLength={300} onChange={(event) => setHelp(event.target.value)} />
          </Field>
          {type === "checkbox" ? (
            <Field label="Ticked on new records">
              <select value={defaultValue} onChange={(event) => setDefaultValue(event.target.value)}>
                <option value="">No</option>
                <option value="yes">Yes</option>
              </select>
            </Field>
          ) : (
            <Field label="Default value" hint={hasOptions ? "Optional: one of the options' names." : "Optional. Filled in on new records."}>
              <input value={defaultValue} onChange={(event) => setDefaultValue(event.target.value)} />
            </Field>
          )}
          {hasOptions ? (
            <Field label="Options" hint="One per line.">
              <textarea rows={4} value={options} onChange={(event) => setOptions(event.target.value)} required />
            </Field>
          ) : null}
        </div>
        <div>
          <span className={ui.muted}>Used on:</span>
          <UsesPicker record={record} value={usedOn} onChange={setUsedOn} />
        </div>
        <div className={ui.actions}>
          {type !== "checkbox" ? (
            <label className={ui.checkbox}>
              <input type="checkbox" checked={isRequired} onChange={(event) => setIsRequired(event.target.checked)} /> Required
              {record === "contact" ? " (when the contact is saved)" : " (when approving or posting; lines only on income and expense accounts)"}
            </label>
          ) : null}
          <label className={ui.checkbox}>
            <input type="checkbox" checked={showInList} onChange={(event) => setShowInList(event.target.checked)} /> Show in lists
          </label>
          <Button type="submit" disabled={busy || !label.trim() || usedOn.length === 0}>
            {busy ? "Adding…" : "Add field"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function FieldRow({ organisationId, field, onSaved }: { organisationId: string; field: CustomField; onSaved: (setup: CustomFieldSetup, message: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(field.label);
  const [help, setHelp] = useState(field.help ?? "");
  const [usedOn, setUsedOn] = useState<CustomFieldUse[]>(field.usedOn);
  const [isRequired, setIsRequired] = useState(field.isRequired);
  const [showInList, setShowInList] = useState(field.showInList);
  const [defaultValue, setDefaultValue] = useState<CustomValue | undefined>(field.defaultValue ?? undefined);
  const [newOption, setNewOption] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasOptions = field.type === "list" || field.type === "multi_select";

  async function run(work: () => Promise<CustomFieldSetup>, message: string) {
    setBusy(true);
    setError(null);
    try {
      onSaved(await work(), message);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  const patch = (body: Record<string, unknown>, message: string) =>
    run(() => api<CustomFieldSetup>(`/api/custom-fields/${field.id}`, { method: "PATCH", body: { organisationId, ...body } }), message);

  return (
    <tr>
      <td colSpan={editing ? 5 : 1}>
        {editing ? (
          <div style={{ display: "grid", gap: 10 }}>
            {error ? <Notice tone="error">{error}</Notice> : null}
            <div className={ui.grid3}>
              <Field label="Label">
                <input value={label} maxLength={60} onChange={(event) => setLabel(event.target.value)} />
              </Field>
              <Field label="Help text">
                <input value={help} maxLength={300} onChange={(event) => setHelp(event.target.value)} />
              </Field>
              <Field label="Default value">
                <FieldInput field={{ ...field, isRequired: false }} value={defaultValue} onChange={setDefaultValue} />
              </Field>
            </div>
            <UsesPicker record={field.record} value={usedOn} onChange={setUsedOn} />
            <div className={ui.actions}>
              {field.type !== "checkbox" ? (
                <label className={ui.checkbox}>
                  <input type="checkbox" checked={isRequired} onChange={(event) => setIsRequired(event.target.checked)} /> Required
                </label>
              ) : null}
              <label className={ui.checkbox}>
                <input type="checkbox" checked={showInList} onChange={(event) => setShowInList(event.target.checked)} /> Show in lists
              </label>
            </div>
            {hasOptions ? (
              <div style={{ display: "grid", gap: 6 }}>
                <span className={ui.muted}>Options</span>
                {field.options.map((option) => (
                  <div key={option.id} className={ui.actions}>
                    <span>{option.name}</span>
                    {option.isActive ? null : <Badge>Archived</Badge>}
                    <Button
                      size="small"
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            api<CustomFieldSetup>(`/api/custom-fields/options/${option.id}`, {
                              method: "PATCH",
                              body: { organisationId, isActive: !option.isActive },
                            }),
                          option.isActive ? `Archived ${option.name}.` : `Restored ${option.name}.`,
                        )
                      }
                    >
                      {option.isActive ? "Archive" : "Restore"}
                    </Button>
                  </div>
                ))}
                <div className={ui.actions}>
                  <input aria-label="New option" placeholder="New option" value={newOption} maxLength={100} onChange={(event) => setNewOption(event.target.value)} />
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={busy || !newOption.trim()}
                    onClick={() =>
                      void run(async () => {
                        const setup = await api<CustomFieldSetup>(`/api/custom-fields/${field.id}/options`, {
                          method: "POST",
                          body: { organisationId, name: newOption },
                        });
                        setNewOption("");
                        return setup;
                      }, `Added ${newOption.trim()}.`)
                    }
                  >
                    Add option
                  </Button>
                </div>
              </div>
            ) : null}
            <div className={ui.actions}>
              <Button
                size="small"
                disabled={busy || usedOn.length === 0}
                onClick={() =>
                  void patch(
                    { label, help: help || null, usedOn, isRequired, showInList, defaultValue: defaultValue ?? null },
                    `Saved ${label.trim()}.`,
                  ).then(() => setEditing(false))
                }
              >
                Save
              </Button>
              <Button size="small" variant="secondary" onClick={() => setEditing(false)}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          <>
            <strong>{field.label}</strong>
            {field.help ? <div className={ui.muted}>{field.help}</div> : null}
            {error ? <Notice tone="error">{error}</Notice> : null}
          </>
        )}
      </td>
      {editing ? null : (
        <>
          <td>{CUSTOM_FIELD_TYPE_LABELS[field.type]}</td>
          <td>{usesText(field)}</td>
          <td>
            {field.isActive ? <Badge tone="green">Active</Badge> : <Badge>Archived</Badge>} {field.isRequired ? <Badge tone="amber">Required</Badge> : null}{" "}
            {field.showInList ? <Badge tone="blue">In lists</Badge> : null}
          </td>
          <td className={ui.num}>
            <span className={ui.rowButtons}>
              <Button size="small" variant="secondary" disabled={busy} onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button
                size="small"
                variant="secondary"
                disabled={busy}
                onClick={() => void patch({ isActive: !field.isActive }, field.isActive ? `Archived ${field.label}.` : `Restored ${field.label}.`)}
              >
                {field.isActive ? "Archive" : "Restore"}
              </Button>
            </span>
          </td>
        </>
      )}
    </tr>
  );
}

/** Settings › Custom fields (CF1, CF7). */
export function CustomFieldsManager({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const loaded = useCustomFields(organisationId);
  const [current, setCurrent] = useState<CustomFieldSetup | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!loaded.data) return <p className={ui.muted}>Loading…</p>;
  const setup = current ?? loaded.data;
  if (!setup.advancedFeatures) {
    return <Notice tone="info">Advanced reporting is off. Turn it on in Settings › Modules to use custom fields.</Notice>;
  }
  if (!can("admin")) return <Notice tone="warning">Only organisation admins and owners can change custom fields.</Notice>;
  const saved = (next: CustomFieldSetup, text: string) => {
    setCurrent(next);
    setMessage(text);
  };
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      {CUSTOM_FIELD_RECORDS.map((record) => {
        const fields = setup.fields.filter((field) => field.record === record);
        return (
          <Card
            key={record}
            title={record === "contact" ? "Contact fields" : record === "document" ? "Document fields" : "Line fields"}
            description={
              record === "contact"
                ? "On customers and suppliers."
                : record === "document"
                  ? "At the top of invoices, bills, credit notes, spend and receive money and journals."
                  : "On each line of those documents."
            }
          >
            {fields.length === 0 ? <Empty>None yet.</Empty> : null}
            {fields.length > 0 ? (
              <div className={ui.tableWrap}>
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th>Field</th>
                      <th>Type</th>
                      <th>Used on</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {fields.map((field) => (
                      <FieldRow key={field.id} organisationId={organisationId} field={field} onSaved={saved} />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </Card>
        );
      })}
      <NewFieldForm organisationId={organisationId} onSaved={saved} />
    </>
  );
}
