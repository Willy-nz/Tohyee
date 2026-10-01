"use client";

import { useApiData } from "@/components/hooks";
import { Field } from "@/components/ui";
import type { LayoutRecord, RecordType } from "@/lib/crm/record-types/layout";

/** An organisation's record types for one kind of record, in their order (CRT1). */
export function useRecordTypes(organisationId: string, record: LayoutRecord) {
  return useApiData<{ recordTypes: RecordType[] }>("/api/crm/record-types", { organisationId, record });
}

/**
 * Picks a new record's type (CRT5), starting on the default. Shown only when
 * there's a choice, as Salesforce asks for a record type only when the
 * person has more than one available.
 */
export function RecordTypeSelect({
  types,
  value,
  onChange,
  disabled,
}: {
  types: RecordType[] | undefined;
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const active = (types ?? []).filter((type) => type.isActive || type.id === value);
  if (active.length < 2) return null;
  const chosen = value || active.find((type) => type.isDefault)?.id || "";
  return (
    <Field label="Record type">
      <select value={chosen} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {active.map((type) => (
          <option key={type.id} value={type.id}>
            {type.name}
            {type.isDefault ? " (default)" : ""}
            {type.isActive ? "" : " (archived)"}
          </option>
        ))}
      </select>
    </Field>
  );
}
