"use client";

import { type FormEvent, useState } from "react";
import { RequireOrganisation } from "@/components/books";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { AI_TOOL_PLAIN_WORDS } from "@/lib/ai/tool-names";
import type { AiAccessToken } from "@/lib/ai/tokens";
import { ROLE_LABELS } from "@/lib/auth/roles";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import styles from "./ai.module.css";

type KeysResponse = { keys: AiAccessToken[]; maxActiveKeys: number; remoteAddress: string | null };

/** Copies text, falling back to selecting it (the clipboard needs HTTPS or localhost). */
async function copyText(text: string, input: HTMLInputElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    input?.select();
    return false;
  }
}

function isLocalAddress(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

function desktopConfig(url: string, key: string): string {
  const args = ["-y", "mcp-remote", url, "--transport", "http-only", "--header", "Authorization:${TOHYEE_AI_KEY}"];
  if (url.startsWith("http://") && !isLocalAddress(url)) args.push("--allow-http");
  return JSON.stringify(
    { mcpServers: { tohyee: { command: "npx", args, env: { TOHYEE_AI_KEY: `Bearer ${key}` } } } },
    null,
    2,
  );
}

function NewKey({ token, onDone }: { token: string; onDone: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  return (
    <Notice tone="warning">
      <p>
        <strong>Copy this key now. It won&apos;t be shown again.</strong> Anyone with it can read these books as you, so keep it somewhere safe
        and only paste it into your own AI.
      </p>
      <div className={styles.keyRow}>
        <input
          ref={setInput}
          className={styles.keyInput}
          aria-label="Your new AI key"
          readOnly
          value={token}
          onFocus={(event) => event.target.select()}
        />
        <Button
          variant="secondary"
          onClick={async () => setCopied((await copyText(token, input)) ? "Copied." : "Selected: press Ctrl+C (or Cmd+C) to copy.")}
        >
          Copy
        </Button>
        <Button variant="secondary" onClick={onDone}>
          I&apos;ve copied it
        </Button>
      </div>
      {copied ? <p className={ui.muted}>{copied}</p> : null}
    </Notice>
  );
}

function AiConnect({ organisationId }: { organisationId: string }) {
  const confirm = useConfirm();
  const { current } = useWorkspace();
  const keys = useApiData<KeysResponse>("/api/ai/tokens", { organisationId });
  const [status, setStatus] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);

  const localUrl = `${window.location.origin}/api/mcp`;
  const remoteUrl = keys.data?.remoteAddress ? `${keys.data.remoteAddress}/api/mcp` : null;
  const shownUrl = remoteUrl ?? localUrl;
  const keyForSnippet = newToken ?? "tohyee_ai_your-key-here";
  const active = (keys.data?.keys ?? []).filter((key) => !key.revokedAt);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api<{ token: string; key: AiAccessToken }>("/api/ai/tokens", { method: "POST", body: { organisationId, name } });
      setNewToken(result.token);
      setStatus({ tone: "success", text: `Made the key “${result.key.name}”.` });
      setName("");
      keys.reload();
    } catch (caught) {
      setStatus({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(key: AiAccessToken) {
    if (!(await confirm(`Revoke “${key.name}”? Any AI using it stops working straight away.`))) return;
    try {
      await api(`/api/ai/tokens/${key.id}/revoke`, { method: "POST", body: { organisationId } });
      setStatus({ tone: "success", text: `Revoked “${key.name}”.` });
      keys.reload();
    } catch (caught) {
      setStatus({ tone: "error", text: errorMessage(caught) });
    }
  }

  return (
    <>
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}

      <Card
        title="Your access keys"
        description={`Each key lets one AI read ${current?.displayName ?? "this organisation"}'s books as you. Make one per AI or device so you can revoke them separately.`}
      >
        {newToken ? <NewKey token={newToken} onDone={() => setNewToken(null)} /> : null}
        {keys.error ? <Notice tone="error">{keys.error}</Notice> : null}
        <form className={ui.inlineForm} onSubmit={(event) => void create(event)}>
          <Field label="Name" hint="So you can tell your keys apart, e.g. “Claude on my laptop”.">
            <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} required />
          </Field>
          <Button type="submit" disabled={busy || (keys.data ? active.length >= keys.data.maxActiveKeys : false)}>
            Create a key
          </Button>
        </form>
        {keys.data && active.length >= keys.data.maxActiveKeys ? (
          <p className={ui.muted}>You have {keys.data.maxActiveKeys} keys, the most you can have here. Revoke one to make another.</p>
        ) : null}
        {keys.data && keys.data.keys.length === 0 ? (
          <Empty>No keys yet.</Empty>
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Starts with</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(keys.data?.keys ?? []).map((key) => (
                  <tr key={key.id}>
                    <td>
                      {key.name} {key.revokedAt ? <Badge tone="red">Revoked {formatDateTime(key.revokedAt)}</Badge> : null}
                    </td>
                    <td>
                      <code>{key.startsWith}…</code>
                    </td>
                    <td>{formatDateTime(key.createdAt)}</td>
                    <td>{key.lastUsedAt ? formatDateTime(key.lastUsedAt) : "Never"}</td>
                    <td className={ui.num}>
                      {key.revokedAt ? null : (
                        <Button variant="danger" size="small" onClick={() => void revoke(key)}>
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="How to connect" description="Tohyee speaks MCP (the Model Context Protocol), which Claude, ChatGPT and many other AI apps can use.">
        <p>
          MCP address{remoteUrl ? " (from anywhere, through Remote access)" : " (on this computer or network)"}: <code>{shownUrl}</code>
        </p>
        {remoteUrl ? (
          <p className={ui.muted}>
            On this computer or network you can also use <code>{localUrl}</code>.
          </p>
        ) : (
          <Notice tone="info">
            AI that runs in the cloud (Claude.ai, ChatGPT) can&apos;t reach this address. For those, a server admin needs to turn on Remote access in
            the Tohyee server app; the MCP address is then the remote access address followed by <code>/api/mcp</code>.
          </Notice>
        )}
        <p>
          Use your key as a <strong>Bearer token</strong>: every request sends the header <code>Authorization: Bearer tohyee_ai_…</code>.
        </p>

        <h3 className={ui.cardTitle}>Claude Desktop (or another app that runs MCP servers on your computer)</h3>
        <ol className={styles.steps}>
          <li>
            Install Node.js (nodejs.org) if you don&apos;t have it; the bridge below runs with <code>npx</code>.
          </li>
          <li>
            In Claude Desktop open Settings › Developer › Edit Config, and add this to <code>claude_desktop_config.json</code>
            {newToken ? " (it has your new key in it)" : ", putting your key in place of tohyee_ai_your-key-here"}:
            <pre className={styles.snippet}>{desktopConfig(shownUrl, keyForSnippet)}</pre>
            If the file already has <code>mcpServers</code>, add the <code>tohyee</code> entry inside it. This uses{" "}
            <code>mcp-remote</code>, an open-source bridge, to reach Tohyee with your key.
          </li>
          <li>Quit and reopen Claude Desktop, then ask it something like “What was our profit last month?”.</li>
        </ol>

        <h3 className={ui.cardTitle}>Claude.ai, ChatGPT and other AI in the cloud</h3>
        <ol className={styles.steps}>
          <li>Remote access must be on (see above), so the AI service can reach Tohyee.</li>
          <li>
            Add a custom connector (it may be called an MCP server or app) with the MCP address <code>{remoteUrl ?? "https://your-address/api/mcp"}</code>.
          </li>
          <li>
            Choose no sign-in (not OAuth) and add a request header <code>Authorization</code> with the value <code>Bearer</code> followed by a space and
            your key.
          </li>
        </ol>
        <p className={ui.muted}>
          We haven&apos;t been able to check every AI service&apos;s screens, and they change. Some only let connectors sign in with OAuth, which
          Tohyee doesn&apos;t offer yet; Claude.ai&apos;s request headers were still being rolled out when this was written. If yours has nowhere to
          put a header, connect from the desktop app instead.
        </p>

        <h3 className={ui.cardTitle}>Any other MCP client</h3>
        <p>
          Tohyee uses the Streamable HTTP transport: JSON-RPC 2.0 by POST to <code>{shownUrl}</code>, answered with JSON (no event stream and no
          sessions), with the key as the Bearer token.
        </p>
      </Card>

      <Card title="What it can see" description="Your AI can ask Tohyee for these, and nothing else. It can't post, approve, change or delete anything.">
        <ul className={styles.toolList}>
          {AI_TOOL_PLAIN_WORDS.map((tool) => (
            <li key={tool.name}>{tool.words}</li>
          ))}
        </ul>
        <p className={ui.muted}>Payroll isn&apos;t included.</p>
      </Card>

      <Card title="About your keys">
        <ul className={styles.toolList}>
          <li>
            A key belongs to you and to this organisation only. It carries your role here ({current ? ROLE_LABELS[current.role] : "your role"}) but is
            always read-only.
          </li>
          <li>It stops working when you revoke it, when you&apos;re removed from this organisation, or when your login is turned off.</li>
          <li>Tohyee keeps only a fingerprint (hash) of each key, so it can&apos;t show a key again. If you lose one, revoke it and make another.</li>
          <li>
            What your AI reads is sent to the AI service you use, under its terms. Only connect AI you&apos;re comfortable sharing these books with.
          </li>
        </ul>
      </Card>
    </>
  );
}

export default function AiPage() {
  return (
    <Page>
      <PageHeader
        title="AI"
        description="Connect your own AI (Claude, ChatGPT and others) to these books. It can look things up and answer questions; it can't change anything."
      />
      <RequireOrganisation>{(organisationId) => <AiConnect key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
