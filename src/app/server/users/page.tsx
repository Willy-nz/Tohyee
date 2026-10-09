"use client";

import { type FormEvent, useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import type { SetupLink } from "@/lib/auth/setup-links";
import type { UserSummary } from "@/lib/users/admin";
import { useConfirm } from "@/components/confirm-dialog";

export default function UsersPage() {
  const confirm = useConfirm();
  const { user: me } = useWorkspace();
  const users = useApiData<{ users: UserSummary[]; twoStepRequired: boolean }>(me.isServerAdmin ? "/api/admin/users" : null);
  const [draft, setDraft] = useState({ displayName: "", email: "", password: "", isServerAdmin: false });
  const [status, setStatus] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  /** The setup link just made, to copy and send (#208). */
  const [link, setLink] = useState<{ email: string; setupLink: SetupLink } | null>(null);
  const withLinks = users.data?.twoStepRequired ?? true;

  if (!me.isServerAdmin) {
    return (
      <Page>
        <PageHeader title="Users" />
        <Notice tone="warning">Only server admins can manage users.</Notice>
      </Page>
    );
  }

  async function act(action: () => Promise<unknown>, success: string, email?: string) {
    setLink(null);
    try {
      const result = (await action()) as { setupLink?: SetupLink | null } | undefined;
      const setupLink = result?.setupLink ?? null;
      setStatus({
        tone: "success",
        text: setupLink
          ? `${success} ${setupLink.emailed ? "The setup link was emailed to them; you can also copy it below." : "Copy the setup link below and send it to them."}`
          : success,
      });
      if (setupLink && email) setLink({ email, setupLink });
      users.reload();
    } catch (caught) {
      setStatus({ tone: "error", text: errorMessage(caught) });
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = withLinks ? { displayName: draft.displayName, email: draft.email, isServerAdmin: draft.isServerAdmin } : draft;
    await act(
      () => api("/api/admin/users", { method: "POST", body }),
      withLinks
        ? `Created a login for ${draft.email}. They choose their password and set up two-step sign-in with their setup link.`
        : `Created a login for ${draft.email}. Give them the temporary password and ask them to change it under Your account.`,
      draft.email,
    );
    setDraft({ displayName: "", email: "", password: "", isServerAdmin: false });
  }

  return (
    <Page>
      <PageHeader
        title="Users"
        description="Logins for this server. Access to each organisation's books is given separately, under People and roles."
      />
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      {link ? (
        <Card title={`Setup link for ${link.email}`} description={`It works once, until ${formatDateTime(link.setupLink.expiresAt)}. Making a new one stops this one.`}>
          <p style={{ overflowWrap: "anywhere" }}>
            <code>{link.setupLink.url}</code>
          </p>
          {link.setupLink.localOnly ? (
            <Notice tone="warning">Remote access is off, so this link only works on the same network as this server.</Notice>
          ) : null}
          <Button variant="secondary" size="small" onClick={() => void navigator.clipboard.writeText(link.setupLink.url)}>
            Copy link
          </Button>
        </Card>
      ) : null}
      <Card title="New user">
        <form onSubmit={(event) => void create(event)} style={{ display: "grid", gap: 12 }}>
          <div className={ui.grid4}>
            <Field label="Name">
              <input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} required />
            </Field>
            <Field label="Email">
              <input type="email" value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} required />
            </Field>
            {withLinks ? null : (
              <Field label="Temporary password" hint="At least 10 characters.">
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={10}
                  value={draft.password}
                  onChange={(event) => setDraft({ ...draft, password: event.target.value })}
                  required
                />
              </Field>
            )}
            <div className={ui.field}>
              <span className={ui.fieldLabel}>Access</span>
              <label className={ui.checkbox}>
                <input
                  type="checkbox"
                  checked={draft.isServerAdmin}
                  onChange={(event) => setDraft({ ...draft, isServerAdmin: event.target.checked })}
                />
                Server admin
              </label>
              <span className={ui.fieldHint}>Can create organisations and users. Doesn&apos;t give access to any books by itself.</span>
            </div>
          </div>
          <div>
            <Button type="submit">Create user</Button>
          </div>
        </form>
      </Card>
      <Card title="All users">
        {users.error ? <Notice tone="error">{users.error}</Notice> : null}
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Access</th>
                <th>Last sign-in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(users.data?.users ?? []).map((user) => (
                <tr key={user.id}>
                  <td>
                    {user.displayName} {user.id === me.id ? <Badge tone="blue">You</Badge> : null}
                  </td>
                  <td>{user.email}</td>
                  <td>
                    {user.isActive ? null : <Badge tone="red">Disabled</Badge>}{" "}
                    {user.isServerAdmin ? <Badge tone="blue">Server admin</Badge> : null}{" "}
                    {user.twoStepEnabled ? (
                      <Badge tone="green">Two-step on</Badge>
                    ) : user.setupLinkExpiresAt ? (
                      <Badge tone="amber">Setup link sent</Badge>
                    ) : (
                      <Badge tone="amber">Two-step not set up</Badge>
                    )}{" "}
                    <span className={ui.muted}>
                      {user.organisationCount} organisation{user.organisationCount === 1 ? "" : "s"}
                    </span>
                  </td>
                  <td>{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : <span className={ui.muted}>Never</span>}</td>
                  <td className={ui.num}>
                    <span className={ui.actions} style={{ justifyContent: "flex-end" }}>
                      <Button
                        variant="secondary"
                        size="small"
                        onClick={() => {
                          const password = window.prompt(`New temporary password for ${user.email} (10+ characters):`);
                          if (password) {
                            void act(
                              () => api(`/api/admin/users/${user.id}`, { method: "PATCH", body: { newPassword: password } }),
                              `Password reset for ${user.email}. They've been signed out everywhere.`,
                            );
                          }
                        }}
                      >
                        Reset password
                      </Button>
                      {user.twoStepEnabled ? (
                        <Button
                          variant="secondary"
                          size="small"
                          onClick={async () => {
                            if (
                              await confirm(
                                `Reset two-step sign-in for ${user.email}? Their authenticator app and backup codes stop working, they're signed out everywhere, and they get a setup link to set it up again. Only do this if you're sure it's really them asking (e.g. a lost phone).`,
                              )
                            ) {
                              void act(
                                () => api(`/api/admin/users/${user.id}/two-step`, { method: "DELETE" }),
                                `Two-step sign-in reset for ${user.email}.`,
                                user.email,
                              );
                            }
                          }}
                        >
                          Reset two-step
                        </Button>
                      ) : withLinks && user.isActive ? (
                        <Button
                          variant="secondary"
                          size="small"
                          onClick={() =>
                            void act(
                              () => api(`/api/admin/users/${user.id}/setup-link`, { method: "POST" }),
                              `New setup link for ${user.email}; any earlier one stopped working.`,
                              user.email,
                            )
                          }
                        >
                          {user.setupLinkExpiresAt ? "New setup link" : "Send setup link"}
                        </Button>
                      ) : null}
                      {user.id !== me.id ? (
                        <>
                          <Button
                            variant="secondary"
                            size="small"
                            onClick={async () => {
                              if (await confirm(`Sign ${user.email} out everywhere? They can sign straight back in with their password and two-step sign-in.`)) {
                                void act(() => api(`/api/admin/users/${user.id}/sign-out`, { method: "POST" }), `${user.email} is signed out everywhere.`);
                              }
                            }}
                          >
                            Sign out everywhere
                          </Button>
                          <Button
                            variant="secondary"
                            size="small"
                            onClick={() =>
                              void act(
                                () => api(`/api/admin/users/${user.id}`, { method: "PATCH", body: { isServerAdmin: !user.isServerAdmin } }),
                                `${user.email} ${user.isServerAdmin ? "is no longer" : "is now"} a server admin.`,
                              )
                            }
                          >
                            {user.isServerAdmin ? "Remove server admin" : "Make server admin"}
                          </Button>
                          <Button
                            variant={user.isActive ? "danger" : "secondary"}
                            size="small"
                            onClick={() =>
                              void act(
                                () => api(`/api/admin/users/${user.id}`, { method: "PATCH", body: { isActive: !user.isActive } }),
                                `${user.email} ${user.isActive ? "disabled" : "re-enabled"}.`,
                              )
                            }
                          >
                            {user.isActive ? "Disable" : "Enable"}
                          </Button>
                        </>
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </Page>
  );
}
