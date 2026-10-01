"use client";

import { type FormEvent, type ReactNode, useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import {
  CUSTOM_FIELD_RECORD_LABELS,
  CUSTOM_FIELD_RECORDS,
  CUSTOM_FIELD_TYPE_LABELS,
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_USE_LABELS,
  type CustomField,
  type CustomFieldGroup,
  type CustomFieldRecord,
  type CustomFieldSection,
  type CustomFieldSetup,
  type CustomFieldType,
  type CustomFieldUse,
  type CustomValue,
  type CustomValues,
  customValueText,
  defaultValues,
  fieldsFor,
  groupBySection,
  isSwitchedOn,
  listColumnsFor,
  SECTION_RECORDS,
  type SectionRecord,
  USES_BY_RECORD,
} from "@/lib/custom-fields/values";

/**
 * Custom fields on screen (examples CF1-CF10, CRMF1-CRMF9): the setup hook,
 * inputs for a record or a line, values as text, list columns and the
 * settings screen. Fields on customers, suppliers, documents and lines show
 * while Advanced reporting is on; fields on prospects, people and
 * opportunities while the CRM is on. A record's existing values always show.
 */
export function useCustomFields(organisationId: string | null) {
  return useApiData<CustomFieldSetup>(organisationId ? "/api/custom-fields" : null, { organisationId });
}

/** The fields to show on a record: those for uses whose switch is on, plus values it already has (CRMF8). */
export function visibleFields(
  setup: CustomFieldSetup | null | undefined,
  record: CustomFieldRecord,
  uses: readonly CustomFieldUse[],
  values: CustomValues = {},
): CustomField[] {
  if (!setup) return [];
  return fieldsFor(setup.fields, record, uses, values, setup);
}

/** A new record's values: each field's default, for uses whose switch is on. */
export function startingValues(setup: CustomFieldSetup | null | undefined, record: CustomFieldRecord, uses: readonly CustomFieldUse[]): CustomValues {
  return setup ? defaultValues(setup.fields, record, uses, setup) : {};
}

/** Fields grouped by their sections for a page or form (CRMF6). */
export function fieldGroups(setup: CustomFieldSetup | null | undefined, fields: readonly CustomField[]): CustomFieldGroup[] {
  return groupBySection(fields, setup?.sections ?? []);
}

/** A group of fields: plain for the ones with no section, otherwise a collapsible section, open to start with. */
function SectionGroup({ section, children }: { section: CustomFieldSection | null; children: ReactNode }) {
  if (!section) return <>{children}</>;
  return (
    <details open className={ui.fieldSection}>
      <summary>{section.name}</summary>
      {children}
    </details>
  );
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
  const groups = record === "line" ? [{ section: null, fields }] : fieldGroups(setup, fields);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {groups.map((group) => (
        <SectionGroup key={group.section?.id ?? "none"} section={group.section}>
          <div className={ui.grid3}>
            {group.fields.map((field) => (
              <Field
                key={field.id}
                label={`${field.label}${field.isRequired ? " (required)" : ""}${field.isActive ? "" : " (archived)"}`}
                hint={field.help ?? undefined}
              >
                <FieldInput field={field} value={value[field.id]} disabled={disabled} onChange={(next) => change(field.id, next)} />
              </Field>
            ))}
          </div>
        </SectionGroup>
      ))}
    </div>
  );
}

/** A record's values as labelled rows, grouped by section (CRMF6). Empty fields are left out. */
export function CustomValuesList({
  setup,
  record,
  values,
}: {
  setup: CustomFieldSetup | null | undefined;
  record: CustomFieldRecord;
  values: CustomValues | undefined;
}) {
  if (!setup || !values) return null;
  const fields = setup.fields.filter((field) => field.record === record && values[field.id] !== undefined);
  if (fields.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {fieldGroups(setup, fields).map((group) => (
        <SectionGroup key={group.section?.id ?? "none"} section={group.section}>
          <dl className={ui.fieldValues}>
            {group.fields.map((field) => (
              <div key={field.id} style={{ display: "contents" }}>
                <dt>{field.label}</dt>
                <dd>{customValueText(field, values[field.id])}</dd>
              </div>
            ))}
          </dl>
        </SectionGroup>
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

/** Fields shown as columns on a list of records ("show in list"), for uses whose switch is on (CRMF7). */
export function listColumns(setup: CustomFieldSetup | null | undefined, record: CustomFieldRecord, uses: readonly CustomFieldUse[]): CustomField[] {
  return setup ? listColumnsFor(setup.fields, record, uses, setup) : [];
}

export function CustomValueCell({ field, values }: { field: CustomField; values: CustomValues | undefined }) {
  return <td>{customValueText(field, values?.[field.id])}</td>;
}

// ---------------------------------------------------------------------------
// Settings › Custom fields (CF1, CF7, CRMF1, CRMF6)

const RECORD_CARDS: Record<CustomFieldRecord, { title: string; description: string }> = {
  contact: { title: "Contact fields", description: "On customers, suppliers and CRM prospects (companies)." },
  document: { title: "Document fields", description: "At the top of invoices, bills, credit notes, spend and receive money and journals." },
  line: { title: "Line fields", description: "On each line of those documents." },
  person: { title: "People fields", description: "On people in the CRM." },
  opportunity: { title: "Opportunity fields", description: "On opportunities in the CRM. They never change an opportunity's amount, stage or invoice." },
};

/** The uses a field of this kind can be put on now: those whose switch is on (CRMF1). */
function availableUses(setup: CustomFieldSetup, record: CustomFieldRecord): CustomFieldUse[] {
  return USES_BY_RECORD[record].filter((use) => isSwitchedOn(setup, use));
}

function UsesPicker({
  setup,
  record,
  value,
  onChange,
}: {
  setup: CustomFieldSetup;
  record: CustomFieldRecord;
  value: CustomFieldUse[];
  onChange: (uses: CustomFieldUse[]) => void;
}) {
  // People and opportunity fields have one use each, so there's nothing to choose.
  if (USES_BY_RECORD[record].length === 1) return null;
  const shown = USES_BY_RECORD[record].filter((use) => isSwitchedOn(setup, use) || value.includes(use));
  return (
    <div>
      <span className={ui.muted}>Used on:</span>
      <div className={ui.actions} role="group" aria-label="Used on">
        {shown.map((use) => (
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
    </div>
  );
}

function usesText(field: CustomField): string {
  return field.usedOn.map((use) => CUSTOM_FIELD_USE_LABELS[use]).join(", ");
}

function hasSections(record: CustomFieldRecord): record is SectionRecord {
  return (SECTION_RECORDS as readonly string[]).includes(record);
}

function SectionPicker({
  sections,
  value,
  onChange,
}: {
  sections: readonly CustomFieldSection[];
  value: string;
  onChange: (sectionId: string) => void;
}) {
  return (
    <Field label="Section" hint="Optional. Groups fields on the record's page and form.">
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">No section</option>
        {sections.map((section) => (
          <option key={section.id} value={section.id}>
            {section.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

function requiredText(record: CustomFieldRecord): string {
  if (record === "contact") return " (when the contact is saved)";
  if (record === "person" || record === "opportunity") return " (when it's saved)";
  return " (when approving or posting; lines only on income and expense accounts)";
}

function NewFieldForm({
  organisationId,
  setup,
  records,
  onSaved,
}: {
  organisationId: string;
  setup: CustomFieldSetup;
  records: readonly CustomFieldRecord[];
  onSaved: (setup: CustomFieldSetup, message: string) => void;
}) {
  const [record, setRecord] = useState<CustomFieldRecord>(records[0]);
  const [label, setLabel] = useState("");
  const [type, setType] = useState<CustomFieldType>("text");
  const [usedOn, setUsedOn] = useState<CustomFieldUse[]>(availableUses(setup, records[0]).slice(0, 1));
  const [sectionId, setSectionId] = useState("");
  const [help, setHelp] = useState("");
  const [isRequired, setIsRequired] = useState(false);
  const [showInList, setShowInList] = useState(false);
  const [options, setOptions] = useState("");
  const [defaultValue, setDefaultValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasOptions = type === "list" || type === "multi_select";
  const sections = setup.sections.filter((section) => section.record === record);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const optionNames = options
        .split("\n")
        .map((name) => name.trim())
        .filter(Boolean);
      const next = await api<CustomFieldSetup>("/api/custom-fields", {
        method: "POST",
        body: {
          organisationId,
          record,
          label,
          type,
          usedOn,
          sectionId: sectionId || null,
          help: help || null,
          isRequired: type === "checkbox" ? false : isRequired,
          showInList,
          options: hasOptions ? optionNames : undefined,
          defaultValue: type === "checkbox" ? (defaultValue === "yes" ? true : undefined) : defaultValue || undefined,
        },
      });
      onSaved(next, `Added ${label.trim()}.`);
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
    <Card
      title="Add a custom field"
      description="Extra information on contacts, documents, lines, people or opportunities. It never changes an amount, an account, a stage or a GST box."
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }}>
        <div className={ui.grid3}>
          <Field label="It's on" hint="Can't be changed later.">
            <select
              value={record}
              onChange={(event) => {
                const next = event.target.value as CustomFieldRecord;
                setRecord(next);
                setUsedOn(availableUses(setup, next).slice(0, 1));
                setSectionId("");
              }}
            >
              {records.map((entry) => (
                <option key={entry} value={entry}>
                  {CUSTOM_FIELD_RECORD_LABELS[entry]}
                  {entry === "document" ? " (the top of a document)" : entry === "line" ? " (each line of a document)" : ""}
                  {entry === "person" || entry === "opportunity" ? " (CRM)" : ""}
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
          {hasSections(record) && sections.length > 0 ? <SectionPicker sections={sections} value={sectionId} onChange={setSectionId} /> : null}
        </div>
        <UsesPicker setup={setup} record={record} value={usedOn} onChange={setUsedOn} />
        <div className={ui.actions}>
          {type !== "checkbox" ? (
            <label className={ui.checkbox}>
              <input type="checkbox" checked={isRequired} onChange={(event) => setIsRequired(event.target.checked)} /> Required
              {requiredText(record)}
            </label>
          ) : null}
          <label className={ui.checkbox}>
            <input type="checkbox" checked={showInList} onChange={(event) => setShowInList(event.target.checked)} /> Show in lists
          </label>
          <Button type="submit" disabled={busy || !label.trim() || (USES_BY_RECORD[record].length > 1 && usedOn.length === 0)}>
            {busy ? "Adding…" : "Add field"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function FieldRow({
  organisationId,
  setup,
  field,
  sections,
  canMoveUp,
  canMoveDown,
  onSaved,
}: {
  organisationId: string;
  setup: CustomFieldSetup;
  field: CustomField;
  sections: readonly CustomFieldSection[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  onSaved: (setup: CustomFieldSetup, message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(field.label);
  const [help, setHelp] = useState(field.help ?? "");
  const [usedOn, setUsedOn] = useState<CustomFieldUse[]>(field.usedOn);
  const [sectionId, setSectionId] = useState(field.sectionId ?? "");
  const [isRequired, setIsRequired] = useState(field.isRequired);
  const [showInList, setShowInList] = useState(field.showInList);
  const [defaultValue, setDefaultValue] = useState<CustomValue | undefined>(field.defaultValue ?? undefined);
  const [newOption, setNewOption] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasOptions = field.type === "list" || field.type === "multi_select";
  const sectionName = sections.find((section) => section.id === field.sectionId)?.name ?? "";
  // A field can be changed while one of the places it's on is switched on (CRMF10).
  const live = field.usedOn.some((use) => isSwitchedOn(setup, use));

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
      <td colSpan={editing ? 6 : 1}>
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
              {hasSections(field.record) && (sections.length > 0 || field.sectionId) ? (
                <SectionPicker sections={sections} value={sectionId} onChange={setSectionId} />
              ) : null}
            </div>
            <UsesPicker setup={setup} record={field.record} value={usedOn} onChange={setUsedOn} />
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
                        const next = await api<CustomFieldSetup>(`/api/custom-fields/${field.id}/options`, {
                          method: "POST",
                          body: { organisationId, name: newOption },
                        });
                        setNewOption("");
                        return next;
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
                    {
                      label,
                      help: help || null,
                      usedOn,
                      isRequired,
                      showInList,
                      defaultValue: defaultValue ?? null,
                      ...(hasSections(field.record) ? { sectionId: sectionId || null } : {}),
                    },
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
          <td>{sectionName}</td>
          <td>
            {field.isActive ? <Badge tone="green">Active</Badge> : <Badge>Archived</Badge>} {field.isRequired ? <Badge tone="amber">Required</Badge> : null}{" "}
            {field.showInList ? <Badge tone="blue">In lists</Badge> : null}
          </td>
          <td className={ui.num}>
            {live ? (
              <span className={ui.rowButtons}>
                <Button
                  size="small"
                  variant="secondary"
                  disabled={busy || !canMoveUp}
                  aria-label={`Move ${field.label} up`}
                  onClick={() => void patch({ move: "up" }, `Moved ${field.label} up.`)}
                >
                  ↑
                </Button>
                <Button
                  size="small"
                  variant="secondary"
                  disabled={busy || !canMoveDown}
                  aria-label={`Move ${field.label} down`}
                  onClick={() => void patch({ move: "down" }, `Moved ${field.label} down.`)}
                >
                  ↓
                </Button>
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
            ) : (
              <span className={ui.muted}>
                {isSwitchedOn({ advancedFeatures: true, crmEnabled: false }, field.usedOn[0]) ? "Advanced reporting is off" : "The CRM is off"}
              </span>
            )}
          </td>
        </>
      )}
    </tr>
  );
}

function SectionRow({
  organisationId,
  section,
  first,
  last,
  onSaved,
}: {
  organisationId: string;
  section: CustomFieldSection;
  first: boolean;
  last: boolean;
  onSaved: (setup: CustomFieldSetup, message: string) => void;
}) {
  const [name, setName] = useState(section.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
    run(() => api<CustomFieldSetup>(`/api/custom-fields/sections/${section.id}`, { method: "PATCH", body: { organisationId, ...body } }), message);
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.actions}>
        <input aria-label={`Name of section ${section.name}`} value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
        <Button size="small" variant="secondary" disabled={busy || !name.trim() || name.trim() === section.name} onClick={() => void patch({ name }, `Renamed ${section.name} to ${name.trim()}.`)}>
          Rename
        </Button>
        <Button size="small" variant="secondary" disabled={busy || first} aria-label={`Move ${section.name} up`} onClick={() => void patch({ move: "up" }, `Moved ${section.name} up.`)}>
          ↑
        </Button>
        <Button size="small" variant="secondary" disabled={busy || last} aria-label={`Move ${section.name} down`} onClick={() => void patch({ move: "down" }, `Moved ${section.name} down.`)}>
          ↓
        </Button>
        <Button
          size="small"
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void run(
              () => api<CustomFieldSetup>(`/api/custom-fields/sections/${section.id}`, { method: "DELETE", query: { organisationId } }),
              `Removed ${section.name}.`,
            )
          }
        >
          Remove
        </Button>
      </div>
    </div>
  );
}

/** A kind of record's sections: add, rename, reorder and remove empty ones (CRMF6). */
function SectionsEditor({
  organisationId,
  record,
  sections,
  onSaved,
}: {
  organisationId: string;
  record: SectionRecord;
  sections: readonly CustomFieldSection[];
  onSaved: (setup: CustomFieldSetup, message: string) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function add() {
    setBusy(true);
    setError(null);
    try {
      const next = await api<CustomFieldSetup>("/api/custom-fields/sections", { method: "POST", body: { organisationId, record, name } });
      onSaved(next, `Added the section ${name.trim()}.`);
      setName("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className={ui.fieldSection} open={sections.length > 0}>
      <summary>Sections ({sections.length})</summary>
      <p className={ui.muted}>Sections group fields on the record&apos;s page and form, in this order. Fields with no section come first. A section only groups fields; it doesn&apos;t hide them.</p>
      {sections.map((section, index) => (
        <SectionRow
          key={`${section.id}-${section.name}`}
          organisationId={organisationId}
          section={section}
          first={index === 0}
          last={index === sections.length - 1}
          onSaved={onSaved}
        />
      ))}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.actions}>
        <input aria-label="New section" placeholder="New section, like Admin only" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
        <Button size="small" variant="secondary" disabled={busy || !name.trim()} onClick={() => void add()}>
          Add section
        </Button>
      </div>
    </details>
  );
}

/** Settings › Custom fields (CF1, CF7, CRMF1, CRMF6). */
export function CustomFieldsManager({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const loaded = useCustomFields(organisationId);
  const [current, setCurrent] = useState<CustomFieldSetup | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!loaded.data) return <p className={ui.muted}>Loading…</p>;
  const setup = current ?? loaded.data;
  // Accounting fields need Advanced reporting; prospect, people and opportunity fields need the CRM (CRMF1).
  const records = CUSTOM_FIELD_RECORDS.filter((record) => availableUses(setup, record).length > 0);
  if (records.length === 0) {
    return <Notice tone="info">Advanced reporting and the CRM are both off. Turn one on in Settings › Modules to use custom fields.</Notice>;
  }
  if (!can("admin")) return <Notice tone="warning">Only organisation admins and owners can change custom fields.</Notice>;
  const saved = (next: CustomFieldSetup, text: string) => {
    setCurrent(next);
    setMessage(text);
  };
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      {!setup.advancedFeatures ? (
        <Notice tone="info">Advanced reporting is off, so only CRM fields (on prospects, people and opportunities) can be set up. Turn it on in Settings › Modules for the rest.</Notice>
      ) : null}
      {records.map((record) => {
        const sections = hasSections(record) ? setup.sections.filter((section) => section.record === record) : [];
        const groups = record === "line" ? [{ section: null, fields: setup.fields.filter((field) => field.record === record) }] : groupBySection(
          setup.fields.filter((field) => field.record === record),
          sections,
        );
        const count = groups.reduce((total, group) => total + group.fields.length, 0);
        return (
          <Card key={record} title={RECORD_CARDS[record].title} description={RECORD_CARDS[record].description}>
            {hasSections(record) ? <SectionsEditor organisationId={organisationId} record={record} sections={sections} onSaved={saved} /> : null}
            {count === 0 ? <Empty>None yet.</Empty> : null}
            {count > 0 ? (
              <div className={ui.tableWrap}>
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th>Field</th>
                      <th>Type</th>
                      <th>Used on</th>
                      <th>Section</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {groups.flatMap((group) =>
                      group.fields.map((field, index) => (
                        <FieldRow
                          key={`${field.id}-${field.sectionId ?? ""}-${field.sortOrder}`}
                          organisationId={organisationId}
                          setup={setup}
                          field={field}
                          sections={sections}
                          canMoveUp={index > 0}
                          canMoveDown={index < group.fields.length - 1}
                          onSaved={saved}
                        />
                      )),
                    )}
                  </tbody>
                </table>
              </div>
            ) : null}
          </Card>
        );
      })}
      <NewFieldForm key={records.join()} organisationId={organisationId} setup={setup} records={records} onSaved={saved} />
    </>
  );
}
