"use client";

import Link from "next/link";
import { useState } from "react";
import { useBusy } from "@/components/crm";
import { useCustomFields } from "@/components/custom-fields";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api } from "@/lib/client/api";
import {
  customIdOf,
  customKey,
  LAYOUT_RECORD_NAMES,
  LAYOUT_RECORDS,
  type LayoutField,
  layoutFieldLabel,
  layoutFields,
  type LayoutRecord,
  MAX_LAYOUT_SECTIONS,
  MAX_RECORD_TYPE_DESCRIPTION,
  MAX_RECORD_TYPE_NAME,
  type PageLayout,
  type RecordType,
  STANDARD_FIELDS,
  standardField,
} from "@/lib/crm/record-types/layout";
import type { CustomField } from "@/lib/custom-fields/values";

/**
 * CRM › Record types (examples CRT1-CRT4, CRT9): an organisation's record
 * types for companies, people and opportunities, each with its page layout
 * (sections, fields, their order, and which are required or read-only),
 * after Salesforce's record types and page layouts (NetSuite's custom
 * forms). Admins and owners only; the server checks again.
 */

const RECORD_DESCRIPTIONS: Record<LayoutRecord, string> = {
  contact: "Companies in the CRM: prospects, customers and suppliers.",
  person: "The people at those companies.",
  opportunity: "Deals in the pipeline. A record type never changes an amount, a stage or an invoice.",
};

function NewRecordTypeForm({ organisationId, record, types, onSaved }: { organisationId: string; record: LayoutRecord; types: RecordType[]; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [copyFromId, setCopyFromId] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const { busy, error, run } = useBusy();
  return (
    <form
      style={{ display: "grid", gap: 10 }}
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          await api("/api/crm/record-types", {
            method: "POST",
            body: { organisationId, record, name, description: description || null, copyFromId: copyFromId || null, isDefault },
          });
          setName("");
          setDescription("");
          setIsDefault(false);
          onSaved();
        });
      }}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid3}>
        <Field label="Name">
          <input value={name} maxLength={MAX_RECORD_TYPE_NAME} onChange={(event) => setName(event.target.value)} required />
        </Field>
        <Field label="Description">
          <input value={description} maxLength={MAX_RECORD_TYPE_DESCRIPTION} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        <Field label="Start the layout from">
          <select value={copyFromId} onChange={(event) => setCopyFromId(event.target.value)}>
            <option value="">The default</option>
            {types.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <label className={ui.checkbox}>
        <input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} /> Make it the default for new {LAYOUT_RECORD_NAMES[record].many}
      </label>
      <div className={ui.actions}>
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy ? "Adding…" : "Add record type"}
        </Button>
      </div>
    </form>
  );
}

/** Moves an item in a list by one place. */
function moved<T>(items: readonly T[], index: number, by: -1 | 1): T[] {
  const next = [...items];
  const target = index + by;
  if (target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** A record type's page layout, changed here and saved at once; the server checks the rules (CRT3). */
function LayoutEditor({
  organisationId,
  type,
  customFields,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  type: RecordType;
  customFields: CustomField[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [layout, setLayout] = useState<PageLayout>(type.layout);
  const [adding, setAdding] = useState("");
  const { busy, error, run } = useBusy();
  const record = type.record;
  const label = (key: string) => {
    const field = customFields.find((entry) => entry.id === customIdOf(key));
    return `${layoutFieldLabel(record, key, customFields)}${field && !field.isActive ? " (archived)" : ""}`;
  };
  const onLayout = new Set(layoutFields(layout).map((field) => field.key));
  const available = [
    ...STANDARD_FIELDS[record].map((field) => field.key),
    ...customFields.filter((field) => field.record === record && field.isActive).map((field) => customKey(field.id)),
  ].filter((key) => !onLayout.has(key));
  const setSection = (index: number, change: Partial<PageLayout["sections"][number]>) =>
    setLayout({ sections: layout.sections.map((section, i) => (i === index ? { ...section, ...change } : section)) });
  const setField = (sectionIndex: number, fieldIndex: number, change: Partial<LayoutField>) =>
    setSection(sectionIndex, { fields: layout.sections[sectionIndex].fields.map((field, i) => (i === fieldIndex ? { ...field, ...change } : field)) });
  const moveFieldTo = (sectionIndex: number, fieldIndex: number, target: number) => {
    const field = layout.sections[sectionIndex].fields[fieldIndex];
    setLayout({
      sections: layout.sections.map((section, i) => {
        if (i === sectionIndex) return { ...section, fields: section.fields.filter((_, j) => j !== fieldIndex) };
        if (i === target) return { ...section, fields: [...section.fields, field] };
        return section;
      }),
    });
  };
  return (
    <form
      style={{ display: "grid", gap: 12 }}
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          await api(`/api/crm/record-types/${type.id}`, { method: "PATCH", body: { organisationId, layout } });
          onSaved();
        });
      }}
    >
      <p className={ui.muted}>
        Required fields must be filled in to save a {LAYOUT_RECORD_NAMES[record].one} of this type. Read-only fields can only be changed by admins and owners. A field taken off the layout
        keeps its values.
      </p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {layout.sections.map((section, sectionIndex) => (
        <fieldset key={sectionIndex} className={ui.fieldSection}>
          <legend className={ui.actions}>
            <input
              aria-label={`Section ${sectionIndex + 1} name`}
              value={section.name}
              maxLength={60}
              onChange={(event) => setSection(sectionIndex, { name: event.target.value })}
              required
            />
            <Button size="small" variant="secondary" disabled={sectionIndex === 0} onClick={() => setLayout({ sections: moved(layout.sections, sectionIndex, -1) })}>
              Up
            </Button>
            <Button
              size="small"
              variant="secondary"
              disabled={sectionIndex === layout.sections.length - 1}
              onClick={() => setLayout({ sections: moved(layout.sections, sectionIndex, 1) })}
            >
              Down
            </Button>
            <Button
              size="small"
              variant="secondary"
              disabled={section.fields.length > 0}
              title={section.fields.length > 0 ? "Move or remove its fields first" : undefined}
              onClick={() => setLayout({ sections: layout.sections.filter((_, i) => i !== sectionIndex) })}
            >
              Remove section
            </Button>
          </legend>
          {section.fields.length === 0 ? <Empty>No fields in this section.</Empty> : null}
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <tbody>
                {section.fields.map((field, fieldIndex) => {
                  const standard = standardField(record, field.key);
                  return (
                    <tr key={field.key}>
                      <td>{label(field.key)}</td>
                      <td>
                        <label className={ui.checkbox}>
                          <input
                            type="checkbox"
                            checked={Boolean(standard?.locked) || field.required}
                            disabled={Boolean(standard?.locked || standard?.system || standard?.alwaysSet)}
                            onChange={(event) => setField(sectionIndex, fieldIndex, { required: event.target.checked })}
                          />{" "}
                          Required
                        </label>
                      </td>
                      <td>
                        <label className={ui.checkbox}>
                          <input
                            type="checkbox"
                            checked={Boolean(standard?.system) || field.readOnly}
                            disabled={Boolean(standard?.locked || standard?.system)}
                            onChange={(event) => setField(sectionIndex, fieldIndex, { readOnly: event.target.checked })}
                          />{" "}
                          Read-only
                        </label>
                      </td>
                      <td className={ui.num}>
                        <span className={ui.rowButtons}>
                          <Button
                            size="small"
                            variant="secondary"
                            aria-label={`Move ${label(field.key)} up`}
                            disabled={fieldIndex === 0}
                            onClick={() => setSection(sectionIndex, { fields: moved(section.fields, fieldIndex, -1) })}
                          >
                            ↑
                          </Button>
                          <Button
                            size="small"
                            variant="secondary"
                            aria-label={`Move ${label(field.key)} down`}
                            disabled={fieldIndex === section.fields.length - 1}
                            onClick={() => setSection(sectionIndex, { fields: moved(section.fields, fieldIndex, 1) })}
                          >
                            ↓
                          </Button>
                          {layout.sections.length > 1 ? (
                            <select
                              aria-label={`Move ${label(field.key)} to section`}
                              value=""
                              onChange={(event) => event.target.value !== "" && moveFieldTo(sectionIndex, fieldIndex, Number(event.target.value))}
                            >
                              <option value="">Move to…</option>
                              {layout.sections.map((other, otherIndex) =>
                                otherIndex === sectionIndex ? null : (
                                  <option key={otherIndex} value={otherIndex}>
                                    {other.name || `Section ${otherIndex + 1}`}
                                  </option>
                                ),
                              )}
                            </select>
                          ) : null}
                          {standard?.locked ? null : (
                            <Button size="small" variant="secondary" onClick={() => setSection(sectionIndex, { fields: section.fields.filter((_, i) => i !== fieldIndex) })}>
                              Remove
                            </Button>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </fieldset>
      ))}
      <div className={ui.actions}>
        {available.length > 0 ? (
          <>
            <Field label="Add a field">
              <select value={adding} onChange={(event) => setAdding(event.target.value)}>
                <option value="">Choose a field</option>
                {available.map((key) => (
                  <option key={key} value={key}>
                    {label(key)}
                  </option>
                ))}
              </select>
            </Field>
            <Button
              variant="secondary"
              disabled={!adding || layout.sections.length === 0}
              onClick={() => {
                const last = layout.sections.length - 1;
                setSection(last, { fields: [...layout.sections[last].fields, { key: adding, required: false, readOnly: false }] });
                setAdding("");
              }}
            >
              Add to the last section
            </Button>
          </>
        ) : null}
        <Button
          variant="secondary"
          disabled={layout.sections.length >= MAX_LAYOUT_SECTIONS}
          onClick={() => setLayout({ sections: [...layout.sections, { name: `Section ${layout.sections.length + 1}`, fields: [] }] })}
        >
          Add section
        </Button>
      </div>
      <div className={ui.actions}>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save layout"}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function RecordTypeRow({
  organisationId,
  type,
  first,
  last,
  editing,
  onEdit,
  onChanged,
}: {
  organisationId: string;
  type: RecordType;
  first: boolean;
  last: boolean;
  editing: "details" | "layout" | null;
  onEdit: (what: "details" | "layout" | null) => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState(type.name);
  const [description, setDescription] = useState(type.description ?? "");
  const { busy, error, run } = useBusy();
  const patch = (body: Record<string, unknown>) =>
    void run(async () => {
      await api(`/api/crm/record-types/${type.id}`, { method: "PATCH", body: { organisationId, ...body } });
      onEdit(null);
      onChanged();
    });
  return (
    <li>
      <div style={{ display: "grid", gap: 6, width: "100%" }}>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {editing === "details" ? (
          <form
            className={ui.actions}
            onSubmit={(event) => {
              event.preventDefault();
              patch({ name, description: description || null });
            }}
          >
            <Field label="Name">
              <input value={name} maxLength={MAX_RECORD_TYPE_NAME} onChange={(event) => setName(event.target.value)} required />
            </Field>
            <Field label="Description">
              <input value={description} maxLength={MAX_RECORD_TYPE_DESCRIPTION} onChange={(event) => setDescription(event.target.value)} />
            </Field>
            <Button type="submit" size="small" disabled={busy || !name.trim()}>
              Save
            </Button>
            <Button size="small" variant="secondary" onClick={() => onEdit(null)}>
              Cancel
            </Button>
          </form>
        ) : (
          <div className={ui.actions} style={{ justifyContent: "space-between" }}>
            <span>
              <strong>{type.name}</strong> {type.isDefault ? <Badge tone="green">Default</Badge> : null}
              {type.isActive ? null : <Badge>Archived</Badge>}
              {type.description ? <span className={ui.muted}> · {type.description}</span> : null}
              <span className={ui.muted}>
                {" "}
                · {type.layout.sections.length} sections, {layoutFields(type.layout).length} fields,{" "}
                {layoutFields(type.layout).filter((field) => field.required || standardField(type.record, field.key)?.locked).length} required
              </span>
            </span>
            <span className={ui.rowButtons}>
              <Button size="small" variant="secondary" disabled={busy} onClick={() => onEdit(editing === "layout" ? null : "layout")}>
                Edit layout
              </Button>
              <Button size="small" variant="secondary" disabled={busy} onClick={() => onEdit("details")}>
                Rename
              </Button>
              {!type.isDefault && type.isActive ? (
                <Button size="small" variant="secondary" disabled={busy} onClick={() => patch({ isDefault: true })}>
                  Make default
                </Button>
              ) : null}
              {type.isDefault ? null : (
                <Button size="small" variant="secondary" disabled={busy} onClick={() => patch({ isActive: !type.isActive })}>
                  {type.isActive ? "Archive" : "Restore"}
                </Button>
              )}
              <Button size="small" variant="secondary" aria-label={`Move ${type.name} up`} disabled={busy || first} onClick={() => patch({ move: "up" })}>
                ↑
              </Button>
              <Button size="small" variant="secondary" aria-label={`Move ${type.name} down`} disabled={busy || last} onClick={() => patch({ move: "down" })}>
                ↓
              </Button>
            </span>
          </div>
        )}
      </div>
    </li>
  );
}

export function RecordTypesManager({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const types = useApiData<{ recordTypes: RecordType[] }>("/api/crm/record-types", { organisationId });
  const setup = useCustomFields(organisationId);
  const [editing, setEditing] = useState<{ id: string; what: "details" | "layout" } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (!can("admin")) return <Notice tone="warning">Only organisation admins and owners can set up record types.</Notice>;
  if (types.error) return <Notice tone="error">{types.error}</Notice>;
  if (!types.data || !setup.data) return <p className={ui.muted}>Loading…</p>;
  const all = types.data.recordTypes;
  const customFields = setup.data.fields;
  const changed = (text: string) => {
    setMessage(text);
    types.reload();
  };
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      <p className={ui.muted}>
        Fields themselves are set up in <Link href="/operations/settings/custom-fields">Settings › Custom fields</Link>; a new field joins every layout of its kind.
      </p>
      {LAYOUT_RECORDS.map((record) => {
        const list = all.filter((type) => type.record === record);
        const open = list.find((type) => type.id === editing?.id && editing.what === "layout");
        return (
          <Card key={record} title={LAYOUT_RECORD_NAMES[record].title} description={RECORD_DESCRIPTIONS[record]}>
            {list.length === 0 ? <Empty>None yet.</Empty> : null}
            <ul className={ui.relatedList}>
              {list.map((type, index) => (
                <RecordTypeRow
                  key={`${type.id}:${type.name}:${type.description ?? ""}`}
                  organisationId={organisationId}
                  type={type}
                  first={index === 0}
                  last={index === list.length - 1}
                  editing={editing?.id === type.id ? editing.what : null}
                  onEdit={(what) => setEditing(what ? { id: type.id, what } : null)}
                  onChanged={() => changed(`${type.name} saved.`)}
                />
              ))}
            </ul>
            {open ? (
              <Card title={`${open.name} layout`}>
                <LayoutEditor
                  key={open.id}
                  organisationId={organisationId}
                  type={open}
                  customFields={customFields}
                  onSaved={() => {
                    setEditing(null);
                    changed(`${open.name}'s layout saved.`);
                  }}
                  onCancel={() => setEditing(null)}
                />
              </Card>
            ) : null}
            <details className={ui.fieldSection}>
              <summary>New {LAYOUT_RECORD_NAMES[record].one} record type</summary>
              <NewRecordTypeForm organisationId={organisationId} record={record} types={list} onSaved={() => changed("Record type added.")} />
            </details>
          </Card>
        );
      })}
    </>
  );
}
