"use client";

import { useState } from "react";
import { Button, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";

/** The value of the "New supplier…" / "New customer…" choice in a contact list. */
export const NEW_CONTACT = "__new__";

/**
 * Adds a customer or supplier without leaving the invoice or bill (Xero lets
 * you type a new name there; 2 Oct 2026). Just the name, email and GST number;
 * the rest can be filled in later under Contacts.
 */
export function QuickContact({
  organisationId,
  kind,
  onCreated,
  onCancel,
}: {
  organisationId: string;
  kind: "customer" | "supplier";
  onCreated: (contact: Contact) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [gstNumber, setGstNumber] = useState("");
  const [key] = useState(() => newIdempotencyKey("contact"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Not a nested <form>: it sits inside the invoice or bill form.
  async function add() {
    if (!name.trim()) {
      setError(`Type the ${kind}'s name.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ contact: Contact }>("/api/contacts", {
        method: "POST",
        body: {
          organisationId,
          source: "ui",
          idempotencyKey: key,
          name: name.trim(),
          email: email.trim() || null,
          gstNumber: gstNumber.trim() || null,
          isCustomer: kind === "customer",
          isSupplier: kind === "supplier",
        },
      });
      onCreated(result.contact);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 10, padding: 12, border: "1px solid var(--border, #d0d7e2)", borderRadius: 8 }}>
      <strong>New {kind}</strong>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid3}>
        <Field label="Name">
          <input
            value={name}
            maxLength={200}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void add();
              }
            }}
          />
        </Field>
        <Field label="Email" hint="Optional.">
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </Field>
        <Field label="GST number" hint="Optional. 8 or 9 digits.">
          <input value={gstNumber} onChange={(event) => setGstNumber(event.target.value)} />
        </Field>
      </div>
      <div className={ui.rowButtons}>
        <Button type="button" size="small" onClick={() => void add()} disabled={busy}>
          {busy ? "Adding…" : `Add ${kind}`}
        </Button>
        <Button type="button" size="small" variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
