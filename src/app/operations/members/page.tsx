"use client";

import { type FormEvent, useState } from "react";
import { RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { ROLE_LABELS, ROLES, type Role } from "@/lib/auth/roles";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import { invitationMessage, type InvitationOutcome } from "@/lib/organisations/invite-messages";
import type { Handover } from "@/lib/organisations/handover";
import type { Member } from "@/lib/organisations/members";
import { useConfirm } from "@/components/confirm-dialog";
import { MemberFarms } from "@/components/member-farms";

const ROLE_HELP: Record<Role, string> = {
  farm_worker: "Records field work (cover readings, grazings, feed, soil samples) on the farms you choose for them, and sees their paddocks and farm calendar. Nothing of the books.",
  sales_rep: "Uses the CRM only: every company and person, and their own deals, tasks and forecast. Nothing of the books.",
  sales_manager: "Uses the CRM only, like a sales rep, and also sees the deals, tasks and forecasts of the sales teams they manage.",
  report_viewer: "Sees only the Analytics dashboards shared with them (for example a client). Nothing of the books.",
  viewer: "Can read journals, stock, contacts and reports.",
  bookkeeper: "Can also post journals, corrections, stock movements and FX revaluations, and manage contacts.",
  admin: "Can also manage the chart of accounts, tax codes, period locks, settings and people.",
  owner: "Can also manage other owners.",
};

function Members({ organisationId }: { organisationId: string }) {
  const confirm = useConfirm();
  const { user, current, can } = useWorkspace();
  const members = useApiData<{ members: Member[] }>(`/api/organisations/${organisationId}/members`);
  const handover = useApiData<{ handover: Handover | null }>(can("admin") ? `/api/organisations/${organisationId}/handover` : null);
  const [status, setStatus] = useState<{ tone: "success" | "error" | "warning"; text: string } | null>(null);
  const [shownLink, setShownLink] = useState<{ email: string; url: string; expiresAt: string; localOnly: boolean } | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("bookkeeper");
  const isOwner = current?.role === "owner";

  async function run(action: () => Promise<unknown>, success: string) {
    try {
      await action();
      setStatus({ tone: "success", text: success });
      members.reload();
    } catch (caught) {
      setStatus({ tone: "error", text: errorMessage(caught) });
    }
  }

  function showInvitation(action: "invite" | "resend", to: string, toRole: Role | null, invitation: InvitationOutcome | null) {
    setStatus(invitationMessage(action, to, toRole, invitation));
    setShownLink(invitation?.url ? { email: to, url: invitation.url, expiresAt: invitation.expiresAt, localOnly: invitation.localOnly } : null);
    members.reload();
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const to = email.trim();
    try {
      const result = await api<{ invitation: InvitationOutcome | null }>(`/api/organisations/${organisationId}/members`, {
        method: "POST",
        body: { email: to, displayName: name, role },
      });
      showInvitation("invite", to, role, result.invitation);
      setEmail("");
      setName("");
    } catch (caught) {
      setShownLink(null);
      setStatus({ tone: "error", text: errorMessage(caught) });
    }
  }

  async function resend(member: Member) {
    try {
      const result = await api<{ invitation: InvitationOutcome }>(`/api/organisations/${organisationId}/members/${member.userId}/invitation`, { method: "POST" });
      showInvitation("resend", member.email, null, result.invitation);
    } catch (caught) {
      setShownLink(null);
      setStatus({ tone: "error", text: errorMessage(caught) });
    }
  }

  if (!can("admin")) {
    return <Notice tone="warning">Only organisation admins and owners can manage people.</Notice>;
  }

  const waiting = handover.data?.handover ?? null;
  return (
    <>
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      {waiting ? (
        <Card title="A server admin is handing this organisation over">
          <Notice tone="warning">
            {waiting.requestedByEmail} asked to make {waiting.toName} ({waiting.toEmail}) an owner. It happens on{" "}
            {new Date(waiting.takesEffectAt).toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric" })} unless an owner or
            admin cancels it. Their reason: &ldquo;{waiting.reason}&rdquo;
          </Notice>
          <Button
            variant="danger"
            onClick={async () => {
              if (await confirm(`Cancel the handover to ${waiting.toEmail}? The server admin who asked is told.`)) {
                await run(() => api(`/api/organisations/${organisationId}/handover`, { method: "DELETE" }), "The handover is cancelled.");
                handover.reload();
              }
            }}
          >
            Cancel the handover
          </Button>
        </Card>
      ) : null}
      {shownLink ? (
        <Card title={`Invitation link for ${shownLink.email}`} description={`It works once, until ${formatDateTime(shownLink.expiresAt)}. Resending makes a new one and stops this one.`}>
          <p style={{ overflowWrap: "anywhere" }}>
            <code>{shownLink.url}</code>
          </p>
          {shownLink.localOnly ? (
            <Notice tone="warning">Remote access is off, so this link only works on the same network as this server.</Notice>
          ) : null}
          <div>
            <Button variant="secondary" size="small" onClick={() => void navigator.clipboard.writeText(shownLink.url)}>
              Copy link
            </Button>
          </div>
        </Card>
      ) : null}
      <Card
        title="Invite someone"
        description="If they don't have a login yet, Tohyee makes one that only opens this organisation, and emails them a link to set it up."
      >
        <form className={ui.inlineForm} onSubmit={(event) => void invite(event)}>
          <Field label="Name">
            <input value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" required />
          </Field>
          <Field label="Email">
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </Field>
          <Field label="Role" hint={ROLE_HELP[role]}>
            <select value={role} onChange={(event) => setRole(event.target.value as Role)}>
              {ROLES.filter((entry) => entry !== "owner" || isOwner).map((entry) => (
                <option key={entry} value={entry}>
                  {ROLE_LABELS[entry]}
                </option>
              ))}
            </select>
          </Field>
          <Button type="submit">Invite</Button>
        </form>
      </Card>
      <Card title="People with access">
        {members.error ? <Notice tone="error">{members.error}</Notice> : null}
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(members.data?.members ?? []).map((member) => {
                const locked = member.role === "owner" && !isOwner;
                return (
                  <tr key={member.userId}>
                    <td data-label="Name">
                      {member.displayName} {member.userId === user.id ? <Badge tone="blue">You</Badge> : null}{" "}
                      {member.invited ? <Badge tone="amber">Invited</Badge> : null}{" "}
                      {!member.isActive ? <Badge tone="red">Login disabled</Badge> : null}
                      {member.invited && member.invitationSentAt ? (
                        <div className={ui.muted}>Sent {formatDateTime(member.invitationSentAt)}</div>
                      ) : null}
                    </td>
                    <td data-label="Email" style={{ overflowWrap: "anywhere" }}>{member.email}</td>
                    <td data-label="Role">
                      <select
                        aria-label={`Role for ${member.email}`}
                        value={member.role}
                        disabled={locked}
                        onChange={(event) =>
                          void run(
                            () =>
                              api(`/api/organisations/${organisationId}/members/${member.userId}`, {
                                method: "PATCH",
                                body: { role: event.target.value },
                              }),
                            `${member.email} is now ${ROLE_LABELS[event.target.value as Role].toLowerCase()}.`,
                          )
                        }
                      >
                        {ROLES.filter((entry) => entry !== "owner" || isOwner || member.role === "owner").map((entry) => (
                          <option key={entry} value={entry}>
                            {ROLE_LABELS[entry]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className={ui.num}>
                      {member.invited ? (
                        <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                          <Button variant="secondary" size="small" disabled={locked} onClick={() => void resend(member)} aria-label={`Resend invitation to ${member.email}`}>
                            Resend
                          </Button>
                          <Button
                            variant="danger"
                            size="small"
                            disabled={locked}
                            aria-label={`Cancel invitation to ${member.email}`}
                            onClick={async () => {
                              if (await confirm(`Cancel the invitation to ${member.email}? Their link stops working.`)) {
                                void run(
                                  () => api(`/api/organisations/${organisationId}/members/${member.userId}/invitation`, { method: "DELETE" }),
                                  `Cancelled the invitation to ${member.email}.`,
                                );
                              }
                            }}
                          >
                            Cancel
                          </Button>
                        </span>
                      ) : (
                      <Button
                        variant="danger"
                        size="small"
                        disabled={locked}
                        onClick={async () => {
                          if (await confirm(`Remove ${member.email} from this organisation?`)) {
                            void run(
                              () => api(`/api/organisations/${organisationId}/members/${member.userId}`, { method: "DELETE" }),
                              `Removed ${member.email}.`,
                            );
                          }
                        }}
                      >
                        Remove
                      </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      {members.data ? <MemberFarms organisationId={organisationId} members={members.data.members} /> : null}
    </>
  );
}

export default function MembersPage() {
  return (
    <Page>
      <PageHeader title="People and roles" description="Who can see and change this organisation's books." />
      <RequireOrganisation>{(organisationId) => <Members key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
