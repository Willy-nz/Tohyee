"use client";

import { type FormEvent, useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import type { OrganisationAdminView } from "@/lib/organisations/admin";
import type { Handover } from "@/lib/organisations/handover";

/**
 * "Hand over an organisation" on the server's Organisations page (#208): for
 * when its owners can't add a new owner themselves. It waits 7 days; the
 * owners and admins are emailed and can cancel it. Not to yourself.
 */
export function HandoverCard({ organisations }: { organisations: OrganisationAdminView[] }) {
  const confirm = useConfirm();
  const handovers = useApiData<{ handovers: Handover[] }>("/api/admin/handovers");
  const [organisationId, setOrganisationId] = useState("");
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const names = new Map(organisations.map((organisation) => [organisation.id, organisation.displayName]));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const result = await api<{ handover: Handover }>(`/api/admin/organisations/${encodeURIComponent(organisationId)}/handover`, {
        method: "POST",
        body: { email, reason },
      });
      setStatus({
        tone: "success",
        text: `${names.get(organisationId) ?? organisationId} will be handed over to ${result.handover.toEmail} on ${formatDateTime(result.handover.takesEffectAt)} unless its owners or admins cancel it.`,
      });
      setEmail("");
      setReason("");
      handovers.reload();
    } catch (caught) {
      setStatus({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Hand over an organisation"
      description="For when an organisation's owners can't add a new owner themselves (for example the owner has died or left). The person you choose becomes an owner after 7 days. Its owners and admins are emailed now, see it when they sign in, and any of them can cancel it. Nobody loses access, and you can't choose yourself."
    >
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }}>
        <div className={ui.grid3}>
          <Field label="Organisation">
            <select value={organisationId} onChange={(event) => setOrganisationId(event.target.value)} required>
              <option value="">Choose…</option>
              {organisations.map((organisation) => (
                <option key={organisation.id} value={organisation.id}>
                  {organisation.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Their login (email)" hint="Add it under Users first.">
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </Field>
          <Field label="Why" hint="Shown to the owners and admins, and kept in the organisation's history.">
            <input value={reason} onChange={(event) => setReason(event.target.value)} minLength={5} maxLength={500} required />
          </Field>
        </div>
        <div>
          <Button type="submit" disabled={busy}>
            Hand over in 7 days
          </Button>
        </div>
      </form>
      {(handovers.data?.handovers ?? []).length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Organisation</th>
                <th>To</th>
                <th>Why</th>
                <th>Asked by</th>
                <th>When</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(handovers.data?.handovers ?? []).map((handover) => (
                <tr key={handover.id}>
                  <td>{names.get(handover.organisationId) ?? handover.organisationId}</td>
                  <td>{handover.toEmail}</td>
                  <td>{handover.reason}</td>
                  <td>{handover.requestedByEmail}</td>
                  <td>
                    {handover.status === "waiting" ? (
                      <Badge tone="amber">On {formatDateTime(handover.takesEffectAt)}</Badge>
                    ) : handover.status === "done" ? (
                      <Badge tone="green">Done</Badge>
                    ) : (
                      <Badge>Cancelled by {handover.cancelledByEmail}</Badge>
                    )}
                  </td>
                  <td className={ui.num}>
                    {handover.status === "waiting" ? (
                      <Button
                        variant="secondary"
                        size="small"
                        onClick={async () => {
                          if (!(await confirm(`Cancel handing ${names.get(handover.organisationId) ?? handover.organisationId} over to ${handover.toEmail}?`))) return;
                          try {
                            await api(`/api/admin/organisations/${encodeURIComponent(handover.organisationId)}/handover`, { method: "DELETE" });
                            setStatus({ tone: "success", text: "The handover is cancelled." });
                            handovers.reload();
                          } catch (caught) {
                            setStatus({ tone: "error", text: errorMessage(caught) });
                          }
                        }}
                      >
                        Cancel
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}
