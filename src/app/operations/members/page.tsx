"use client";

import { type FormEvent, useState } from "react";
import { RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { ROLE_LABELS, ROLES, type Role } from "@/lib/auth/roles";
import { api, errorMessage } from "@/lib/client/api";
import type { Handover } from "@/lib/organisations/handover";
import type { Member } from "@/lib/organisations/members";
import { useConfirm } from "@/components/confirm-dialog";

const ROLE_HELP: Record<Role, string> = {
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
  const [status, setStatus] = useState<{ tone: "success" | "error"; text: string } | null>(null);
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

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(
      () => api(`/api/organisations/${organisationId}/members`, { method: "POST", body: { email, role } }),
      `Added ${email} as ${ROLE_LABELS[role].toLowerCase()}.`,
    );
    setEmail("");
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
      <Card title="Add someone" description="They need a login first. A server admin creates logins under Users.">
        <form className={ui.inlineForm} onSubmit={(event) => void add(event)}>
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
          <Button type="submit">Add</Button>
        </form>
      </Card>
      <Card title="People with access">
        {members.error ? <Notice tone="error">{members.error}</Notice> : null}
        <div className={ui.tableWrap}>
          <table className={ui.table}>
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
                    <td>
                      {member.displayName} {member.userId === user.id ? <Badge tone="blue">You</Badge> : null}{" "}
                      {!member.isActive ? <Badge tone="red">Login disabled</Badge> : null}
                    </td>
                    <td>{member.email}</td>
                    <td>
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
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
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
