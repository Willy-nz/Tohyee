"use client";

import { type FormEvent, useEffect, useState } from "react";
import { Badge, Button, Card, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import type { RemoteAccess } from "@/lib/remote/settings";
import type { TunnelStatus } from "@/lib/remote/tunnel";

const STATUS: Record<TunnelStatus, { tone: "green" | "amber" | "red" | "neutral"; label: string }> = {
  off: { tone: "neutral", label: "Off" },
  starting: { tone: "amber", label: "Starting" },
  connected: { tone: "green", label: "Connected" },
  reconnecting: { tone: "amber", label: "Reconnecting" },
  error: { tone: "red", label: "Not working" },
  missing_program: { tone: "red", label: "cloudflared missing" },
};

function SetupSteps({ localService }: { localService: string }) {
  return (
    <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 6 }}>
      <li>
        You need a domain (web address) on Cloudflare, e.g. <code>example.nz</code>. Cloudflare&apos;s free plan is enough; the domain
        itself costs a small yearly fee from any registrar.
      </li>
      <li>
        In the Cloudflare dashboard, go to <strong>Networking → Tunnels</strong> (older accounts: Zero Trust → Networks → Tunnels) and
        choose <strong>Create a tunnel</strong>. Name it (e.g. <em>tohyee</em>) and pick <strong>Windows</strong>.
      </li>
      <li>
        Cloudflare shows an install command. <strong>Don&apos;t run it</strong>: copy it (or just the long code starting{" "}
        <code>eyJ</code>) and paste it below. Tohyee runs the connector itself.
      </li>
      <li>
        On the tunnel&apos;s <strong>Routes</strong> tab, add a <strong>published application</strong>: a subdomain such as{" "}
        <code>books</code> on your domain, with the service URL <code>{localService}</code> (use 127.0.0.1, not localhost).
      </li>
      <li>
        Enter that address (e.g. <code>https://books.example.nz</code>) as the public address below, turn remote access on and save.
      </li>
    </ol>
  );
}

function RemoteForm({ remote, onSaved }: { remote: RemoteAccess; onSaved: (remote: RemoteAccess) => void }) {
  const [enabled, setEnabled] = useState(remote.enabled || !remote.hasToken);
  const [tunnelToken, setTunnelToken] = useState("");
  const [publicUrl, setPublicUrl] = useState(remote.publicUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ remoteAccess: RemoteAccess }>("/api/admin/remote-access", {
        method: "PUT",
        body: { enabled, tunnelToken: tunnelToken || undefined, publicUrl },
      });
      setTunnelToken("");
      onSaved(result.remoteAccess);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void save(event)} style={{ display: "grid", gap: 12 }} autoComplete="off">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field
        label="Tunnel token"
        hint={remote.hasToken ? `Saved (tunnel ${remote.tunnelId ?? "unknown"}). Leave blank to keep it.` : "Paste the install command or the code starting eyJ."}
      >
        <textarea
          rows={3}
          value={tunnelToken}
          onChange={(event) => setTunnelToken(event.target.value)}
          required={!remote.hasToken}
          spellCheck={false}
          style={{ fontFamily: "monospace" }}
        />
      </Field>
      <Field label="Public address" hint="The published application's address in Cloudflare. Used in emailed links.">
        <input value={publicUrl} onChange={(event) => setPublicUrl(event.target.value.trim())} placeholder="https://books.example.nz" />
      </Field>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        Remote access on (Tohyee runs the Cloudflare connector while the server is running)
      </label>
      <div className={ui.actions}>
        <Button type="submit" disabled={busy || !remote.secretsAvailable}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

export default function RemoteAccessPage() {
  const { user } = useWorkspace();
  const [remote, setRemote] = useState<RemoteAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);

  useEffect(() => {
    if (!user.isServerAdmin) return;
    let cancelled = false;
    const load = () =>
      api<{ remoteAccess: RemoteAccess }>("/api/admin/remote-access").then(
        (result) => {
          if (!cancelled) setRemote(result.remoteAccess);
        },
        (caught) => {
          if (!cancelled) setError(errorMessage(caught));
        },
      );
    void load();
    // Keep the connector's status fresh while the page is open.
    const timer = setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [user.isServerAdmin]);

  if (!user.isServerAdmin) {
    return (
      <Page>
        <PageHeader title="Remote access" />
        <Notice tone="warning">Only server admins can set up remote access.</Notice>
      </Page>
    );
  }

  async function restart() {
    setBusy(true);
    try {
      setRemote((await api<{ remoteAccess: RemoteAccess }>("/api/admin/remote-access", { method: "POST" })).remoteAccess);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm("Remove remote access? Tohyee stops the connector and forgets the tunnel token. It stays reachable on this computer.")) return;
    setBusy(true);
    try {
      setRemote((await api<{ remoteAccess: RemoteAccess }>("/api/admin/remote-access", { method: "PUT", body: { clear: true } })).remoteAccess);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const status = remote ? STATUS[remote.tunnel.status] : null;
  return (
    <Page>
      <PageHeader
        title="Remote access"
        description="Use Tohyee from anywhere (phone or laptop) through a Cloudflare Tunnel: nothing to open on your router, and a proper https address."
      />
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!remote && !error ? <p className={ui.muted}>Loading…</p> : null}
      {remote ? (
        <>
          {!remote.twoStepRequired ? (
            <Notice tone="error">
              Remote access can&apos;t be turned on until two-step sign-in is in force, and that needs TOHYEE_SECRET_KEY set on the server.
              The Windows installer sets it when you update Tohyee.
            </Notice>
          ) : null}
          <Card
            title="Status"
            description={
              status ? (
                <>
                  <Badge tone={status.tone}>{status.label}</Badge>
                  {remote.tunnel.connectedAt && remote.tunnel.status === "connected" ? ` since ${formatDateTime(remote.tunnel.connectedAt)}` : ""}
                  {remote.publicUrl && remote.tunnel.status === "connected" ? (
                    <>
                      {" · "}
                      <a href={remote.publicUrl} target="_blank" rel="noreferrer">
                        {remote.publicUrl}
                      </a>
                    </>
                  ) : null}
                </>
              ) : null
            }
            actions={
              remote.hasToken ? (
                <>
                  {remote.enabled ? (
                    <Button variant="secondary" onClick={() => void restart()} disabled={busy}>
                      Restart connector
                    </Button>
                  ) : null}
                  <Button variant="danger" onClick={() => void remove()} disabled={busy}>
                    Remove
                  </Button>
                </>
              ) : null
            }
          >
            {remote.tunnel.message ? <Notice tone={remote.tunnel.status === "connected" ? "info" : "warning"}>{remote.tunnel.message}</Notice> : null}
            {remote.enabled && remote.tunnel.status === "connected" ? (
              <p className={ui.muted}>
                Open the public address on your phone to check. Everyone signs in with their password and authenticator app.
              </p>
            ) : null}
            {remote.tunnel.log.length > 0 ? (
              <div>
                <button type="button" className={ui.linkButton} onClick={() => setShowLog((value) => !value)}>
                  {showLog ? "Hide connector log" : "Show connector log"}
                </button>
                {showLog ? (
                  <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.8rem", maxHeight: 280, overflow: "auto" }}>{remote.tunnel.log.join("\n")}</pre>
                ) : null}
              </div>
            ) : null}
          </Card>
          <Card title="Set up" description="Once only. Cloudflare's menu names can change a little; the pieces stay the same.">
            <SetupSteps localService={remote.localService} />
          </Card>
          <Card title="Tunnel">
            <RemoteForm key={remote.updatedAt ?? "new"} remote={remote} onSaved={setRemote} />
          </Card>
          <Card title="Good to know">
            <ul style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 6 }}>
              <li>Tohyee only answers from outside while this computer is on and Tohyee is running.</li>
              <li>Everyone must set up two-step sign-in (an authenticator app) before they can use Tohyee, at home or away.</li>
              <li>
                For an extra lock, Cloudflare Access (Zero Trust) can ask for an email code before anyone even reaches the sign-in page.
              </li>
              <li>Set up Server → Email too, so people get security alerts and can reset two-step sign-in if they lose their phone.</li>
            </ul>
          </Card>
        </>
      ) : null}
    </Page>
  );
}
