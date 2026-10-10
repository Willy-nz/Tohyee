"use client";

import { type FormEvent, useState } from "react";
import { useBusy } from "@/components/crm";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { EmailTemplate } from "@/lib/crm/sales-email";

type Form = { name: string; subject: string; body: string };

function TemplateEditor({ organisationId, template, onDone }: { organisationId: string; template: EmailTemplate | null; onDone: () => void }) {
  const [form, setForm] = useState<Form>({ name: template?.name ?? "", subject: template?.subject ?? "", body: template?.body ?? "" });
  const { busy, error, run } = useBusy();
  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const body = { organisationId, ...form };
      if (template) await api(`/api/crm/email-templates/${template.id}`, { method: "PATCH", body });
      else await api("/api/crm/email-templates", { method: "POST", body });
      onDone();
    });
  }
  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 10 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="Name">
        <input value={form.name} maxLength={100} required onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </Field>
      <Field label="Subject">
        <input value={form.subject} maxLength={200} required onChange={(event) => setForm({ ...form, subject: event.target.value })} />
      </Field>
      <Field label="Message">
        <textarea rows={10} value={form.body} maxLength={20000} required onChange={(event) => setForm({ ...form, body: event.target.value })} />
      </Field>
      <span className={ui.rowButtons}>
        <Button type="submit" disabled={busy}>
          {template ? "Save template" : "Add template"}
        </Button>
        <Button type="button" variant="secondary" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
      </span>
    </form>
  );
}

/** CRM › Email templates (decision 496): admins write them; everyone sending a sales email can start from one. */
export function EmailTemplatesPage({ organisationId }: { organisationId: string }) {
  const data = useApiData<{ templates: EmailTemplate[]; mergeFields: Record<string, string> }>("/api/crm/email-templates", { organisationId });
  const [editing, setEditing] = useState<EmailTemplate | "new" | null>(null);
  const { busy, error, run } = useBusy();
  const done = () => {
    setEditing(null);
    data.reload();
  };
  const templates = data.data?.templates ?? [];
  return (
    <>
      {data.error ? <Notice tone="error">{data.error}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Card
        title="Email templates"
        description="Starting points for sales emails. The person sending checks and can change the words before it goes; nothing is sent automatically."
        actions={
          editing === null ? (
            <Button size="small" onClick={() => setEditing("new")}>
              Add template
            </Button>
          ) : null
        }
      >
        {editing === "new" ? <TemplateEditor organisationId={organisationId} template={null} onDone={done} /> : null}
        {data.data && templates.length === 0 && editing !== "new" ? <Empty>No templates yet.</Empty> : null}
        {templates.map((template) =>
          editing !== "new" && editing?.id === template.id ? (
            <TemplateEditor key={template.id} organisationId={organisationId} template={template} onDone={done} />
          ) : (
            <div key={template.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 0", borderTop: "1px solid var(--line, #e5e5e5)" }}>
              <div>
                <strong>{template.name}</strong> {template.isActive ? null : <Badge>Off</Badge>}
                <div className={ui.muted}>{template.subject}</div>
              </div>
              <span className={ui.rowButtons}>
                <Button size="small" variant="secondary" disabled={busy || editing !== null} onClick={() => setEditing(template)}>
                  Edit
                </Button>
                <Button
                  size="small"
                  variant="secondary"
                  disabled={busy || editing !== null}
                  onClick={() =>
                    void run(async () => {
                      await api(`/api/crm/email-templates/${template.id}`, { method: "PATCH", body: { organisationId, isActive: !template.isActive } });
                      data.reload();
                    })
                  }
                >
                  {template.isActive ? "Switch off" : "Switch on"}
                </Button>
              </span>
            </div>
          ),
        )}
      </Card>
      <Card title="Merge fields" description="Type these in a subject or message; they're filled in for each person. One with nothing to fill in is left blank.">
        <table className={ui.table}>
          <tbody>
            {Object.entries(data.data?.mergeFields ?? {}).map(([field, label]) => (
              <tr key={field}>
                <td>
                  <code>{`{{${field}}}`}</code>
                </td>
                <td>{label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
