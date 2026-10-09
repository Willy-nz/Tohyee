"use client";

import { useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import type { SignInEvent } from "@/lib/auth/sign-in-log";
import { formatDateTime } from "@/lib/format";

const OUTCOME: Record<SignInEvent["outcome"], string> = {
  signed_in: "Signed in",
  password_ok: "Password right, next step",
  failed: "Failed",
  locked: "Locked",
  refused: "Refused",
};

const STEP: Record<SignInEvent["step"], string> = {
  password: "Password",
  code: "Authenticator code",
  backup_code: "Backup code",
  setup_link: "Setup link",
  reset_link: "Emailed reset link",
  first_admin: "First admin",
};

/** The sign-in monitor (#208, decision 487): every sign-in attempt, with the suspicious ones flagged. Reported, never blocked. */
export default function SignInsPage() {
  const { user } = useWorkspace();
  const [flagged, setFlagged] = useState(false);
  const [remote, setRemote] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const log = useApiData<{ events: SignInEvent[]; unseen: { count: number; reviewedAt: string | null } }>(user.isServerAdmin ? "/api/admin/sign-ins" : null, {
    flagged: flagged ? "true" : null,
    remote: remote ? "true" : null,
  });
  if (!user.isServerAdmin) {
    return (
      <Page>
        <PageHeader title="Sign-ins" />
        <Notice tone="warning">Only server admins can see sign-ins.</Notice>
      </Page>
    );
  }
  const unseen = log.data?.unseen.count ?? 0;
  return (
    <Page>
      <PageHeader
        title="Sign-ins"
        description="Every sign-in attempt on this server for the last year. Anything unusual is flagged and emailed to the person and the server admins; nothing is blocked. If one wasn't them, sign them out everywhere under Users and reset their password."
      />
      {status ? <Notice tone="error">{status}</Notice> : null}
      {log.error ? <Notice tone="error">{log.error}</Notice> : null}
      {unseen > 0 ? (
        <Notice tone="warning">
          {unseen} flagged {unseen === 1 ? "sign-in" : "sign-ins"} since you last looked.{" "}
          <Button
            size="small"
            variant="secondary"
            onClick={async () => {
              try {
                await api("/api/admin/sign-ins/seen", { method: "POST" });
                log.reload();
              } catch (caught) {
                setStatus(errorMessage(caught));
              }
            }}
          >
            I&apos;ve looked
          </Button>
        </Notice>
      ) : null}
      <Card title="Attempts">
        <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
          <label className={ui.checkbox}>
            <input type="checkbox" checked={flagged} onChange={(event) => setFlagged(event.target.checked)} /> Flagged only
          </label>
          <label className={ui.checkbox}>
            <input type="checkbox" checked={remote} onChange={(event) => setRemote(event.target.checked)} /> Through remote access only
          </label>
        </div>
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>When</th>
                <th>Login</th>
                <th>What</th>
                <th>From</th>
                <th>Browser</th>
                <th>Flag</th>
              </tr>
            </thead>
            <tbody>
              {(log.data?.events ?? []).map((event) => (
                <tr key={event.id}>
                  <td>{formatDateTime(event.at)}</td>
                  <td>{event.email}</td>
                  <td>
                    {OUTCOME[event.outcome]} <span className={ui.muted}>({STEP[event.step]})</span>
                  </td>
                  <td>
                    {event.address ?? ""} {event.remote ? <Badge tone="blue">Remote</Badge> : <Badge>Local</Badge>}
                  </td>
                  <td style={{ overflowWrap: "anywhere", maxWidth: 260 }} className={ui.muted}>
                    {event.userAgent ?? ""}
                  </td>
                  <td>{event.flag ? <Badge tone="amber">{event.flag}</Badge> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </Page>
  );
}
