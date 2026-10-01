import type { ReactNode } from "react";
import { ui } from "@/components/ui";
import type { DetailField, DetailSection } from "@/lib/crm/record-page";

/**
 * A CRM record page's Details tab (CRT6, CRT7): the record type's layout
 * sections, each collapsible and open to start with, a row per field with a
 * pencil to change just that field, after Salesforce's inline edit. The
 * pencil shows only where the person may edit (`field.editable`), and the
 * server checks again.
 */
export function RecordDetails({
  sections,
  valueOf,
  editingKey,
  onEdit,
  renderEditor,
}: {
  sections: DetailSection[];
  valueOf: (field: DetailField) => ReactNode;
  editingKey: string | null;
  onEdit?: (key: string) => void;
  renderEditor: (field: DetailField) => ReactNode;
}) {
  return (
    <div className={ui.recordSections}>
      {sections.map((section) => (
        <details key={section.name} open className={ui.fieldSection}>
          <summary>{section.name}</summary>
          <dl className={ui.recordFields}>
            {section.fields.map((field) => (
              <div key={field.key} className={ui.recordField}>
                <dt>
                  {field.label}
                  {field.required ? (
                    <span className={ui.requiredMark} title="Required">
                      {" "}
                      *
                    </span>
                  ) : null}
                </dt>
                <dd>
                  {editingKey === field.key ? (
                    renderEditor(field)
                  ) : (
                    <span className={ui.recordValue}>
                      <span>{valueOf(field) || <span className={ui.muted}>—</span>}</span>
                      {field.editable && onEdit ? (
                        <button type="button" className={ui.pencil} aria-label={`Edit ${field.label}`} title={`Edit ${field.label}`} onClick={() => onEdit(field.key)}>
                          ✎
                        </button>
                      ) : field.readOnly && !field.standard?.system ? (
                        <span className={ui.muted} title="Read-only on this record type">
                          {" "}
                          Read-only
                        </span>
                      ) : null}
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ))}
    </div>
  );
}
