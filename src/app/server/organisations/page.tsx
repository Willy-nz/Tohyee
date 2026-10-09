"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import { CURRENCY_MINOR_UNITS } from "@/lib/money/currency";
import type { OrganisationAdminView } from "@/lib/organisations/admin";
import { useConfirm } from "@/components/confirm-dialog";
import { HandoverCard } from "@/components/server-handover";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}

function StatusBadge({ organisation }: { organisation: OrganisationAdminView }) {
  if (!organisation.isActive) return <Badge>Inactive</Badge>;
  if (organisation.provisioningStatus === "failed") return <Badge tone="red">Set-up failed</Badge>;
  if (organisation.provisioningStatus === "pending") return <Badge tone="amber">Setting up</Badge>;
  if (organisation.migrationStatus === "failed") return <Badge tone="red">Upgrade failed</Badge>;
  if (organisation.migrationStatus === "pending") return <Badge tone="amber">Upgrading</Badge>;
  return <Badge tone="green">Ready</Badge>;
}

export default function OrganisationsPage() {
  const confirm = useConfirm();
  const router = useRouter();
  const { user } = useWorkspace();
  const list = useApiData<{ organisations: OrganisationAdminView[] }>(user.isServerAdmin ? "/api/admin/organisations" : null);
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [baseCurrency, setBaseCurrency] = useState("NZD");
  const [ownerEmail, setOwnerEmail] = useState("");
  // #181: the modules it starts with (changed later under Modules).
  const [modules, setModules] = useState({ accounting: true, gstRegistered: true, crm: false, analytics: false });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  if (!user.isServerAdmin) {
    return (
      <Page>
        <PageHeader title="Organisations" />
        <Notice tone="warning">Only server admins can manage organisations.</Notice>
      </Page>
    );
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const result = await api<{ organisation: OrganisationAdminView; modulesNote: string | null }>("/api/admin/organisations", {
        method: "POST",
        body: { id, displayName: name, baseCurrency, ownerEmail: ownerEmail || undefined, modules: { ...modules, gstRegistered: modules.accounting && modules.gstRegistered } },
      });
      if (result.organisation.provisioningStatus === "ready") {
        setStatus({
          tone: "success",
          text: `Created ${result.organisation.displayName} with its own database (${result.organisation.databaseName}).${result.modulesNote ? ` ${result.modulesNote}` : ""}`,
        });
      } else {
        setStatus({
          tone: "error",
          text: `Registered ${result.organisation.displayName}, but its database couldn't be created: ${result.organisation.provisioningError ?? "unknown error"}. Fix the cause and press Repair.`,
        });
      }
      setName("");
      setId("");
      setIdTouched(false);
      setOwnerEmail("");
      setModules({ accounting: true, gstRegistered: true, crm: false, analytics: false });
      list.reload();
      router.refresh();
    } catch (caught) {
      setStatus({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  async function act(action: () => Promise<unknown>, success: string) {
    try {
      await action();
      setStatus({ tone: "success", text: success });
      list.reload();
      router.refresh();
    } catch (caught) {
      setStatus({ tone: "error", text: errorMessage(caught) });
    }
  }

  return (
    <Page>
      <PageHeader
        title="Organisations"
        description="Each organisation has its own PostgreSQL database, so it can be backed up, restored or moved on its own."
      />
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      <Card title="New organisation" description="Creates the database and a starting NZ chart of accounts.">
        <form onSubmit={(event) => void create(event)} style={{ display: "grid", gap: 12 }}>
          <div className={ui.grid4}>
            <Field label="Name">
              <input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (!idTouched) setId(slugify(event.target.value));
                }}
                maxLength={150}
                required
              />
            </Field>
            <Field label="ID" hint="Lower-case letters, numbers and dashes. Can't be changed later.">
              <input
                value={id}
                onChange={(event) => {
                  setIdTouched(true);
                  setId(event.target.value);
                }}
                pattern="[a-z0-9][a-z0-9\-]{0,31}"
                required
              />
            </Field>
            <Field label="Base currency">
              <select value={baseCurrency} onChange={(event) => setBaseCurrency(event.target.value)}>
                {Object.keys(CURRENCY_MINOR_UNITS).map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Owner's email" hint="Leave blank to make yourself the owner.">
              <input type="email" value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} />
            </Field>
          </div>
          <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 6 }}>
            <legend className={ui.muted}>Modules (at least one of Accounting, CRM or Analytics; changed later under Modules)</legend>
            <label className={ui.checkbox}>
              <input type="checkbox" checked={modules.accounting} onChange={(event) => setModules({ ...modules, accounting: event.target.checked })} /> Accounting
            </label>
            {modules.accounting ? (
              <label className={ui.checkbox}>
                <input type="checkbox" checked={modules.gstRegistered} onChange={(event) => setModules({ ...modules, gstRegistered: event.target.checked })} /> Tax: registered
                for GST
              </label>
            ) : null}
            <label className={ui.checkbox}>
              <input type="checkbox" checked={modules.crm} onChange={(event) => setModules({ ...modules, crm: event.target.checked })} /> CRM
            </label>
            <label className={ui.checkbox}>
              <input type="checkbox" checked={modules.analytics} onChange={(event) => setModules({ ...modules, analytics: event.target.checked })} /> Analytics
            </label>
          </fieldset>
          <div>
            <Button type="submit" disabled={busy || (!modules.accounting && !modules.crm && !modules.analytics)}>
              {busy ? "Creating database…" : "Create organisation"}
            </Button>
          </div>
        </form>
      </Card>
      <Card title="All organisations on this server">
        {list.error ? <Notice tone="error">{list.error}</Notice> : null}
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Organisation</th>
                <th>Database</th>
                <th>Status</th>
                <th className={ui.num}>People</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(list.data?.organisations ?? []).map((organisation) => (
                <tr key={organisation.id}>
                  <td>
                    {organisation.displayName}
                    <div className={ui.muted}>
                      {organisation.id} · {organisation.baseCurrency}
                    </div>
                  </td>
                  <td>
                    <code>{organisation.databaseName}</code>
                    <div className={ui.muted}>schema v{organisation.schemaVersion ?? "-"}</div>
                  </td>
                  <td>
                    <StatusBadge organisation={organisation} />
                    {organisation.provisioningError || organisation.migrationError ? (
                      <div className={ui.muted} style={{ maxWidth: 280 }}>
                        {organisation.provisioningError ?? organisation.migrationError}
                      </div>
                    ) : null}
                  </td>
                  <td className={ui.num}>{organisation.memberCount}</td>
                  <td>{formatDateTime(organisation.createdAt)}</td>
                  <td className={ui.num}>
                    <span className={ui.actions} style={{ justifyContent: "flex-end" }}>
                      {organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current" ? (
                        <Button
                          size="small"
                          onClick={() =>
                            void act(
                              () => api(`/api/admin/organisations/${organisation.id}/repair`, { method: "POST" }),
                              `Repaired ${organisation.displayName}.`,
                            )
                          }
                        >
                          Repair
                        </Button>
                      ) : null}
                      <Button
                        variant={organisation.isActive ? "danger" : "secondary"}
                        size="small"
                        onClick={async () => {
                          if (
                            !organisation.isActive ||
                            await confirm(`Deactivate ${organisation.displayName}? Nobody will be able to open it until it's reactivated. Nothing is deleted.`)
                          ) {
                            void act(
                              () =>
                                api(`/api/admin/organisations/${organisation.id}`, {
                                  method: "PATCH",
                                  body: { isActive: !organisation.isActive },
                                }),
                              `${organisation.displayName} ${organisation.isActive ? "deactivated" : "reactivated"}.`,
                            );
                          }
                        }}
                      >
                        {organisation.isActive ? "Deactivate" : "Reactivate"}
                      </Button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <HandoverCard organisations={list.data?.organisations ?? []} />
    </Page>
  );
}
