"use client";

import { InfoTip } from "@/components/info-tip";
import Link from "next/link";
import { type FormEvent, type ReactNode, useState } from "react";
import { RequireOrganisation } from "@/components/books";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import {
  AI_ACCESS_LEVEL_HELP,
  AI_ACCESS_LEVEL_LABELS,
  AI_ACCESS_LEVELS,
  type AiAccessLevel,
  effectiveAccessLevel,
  FULL_ACCESS_WARNING,
  roleCeiling,
  AI_KEY_END_LABELS,
  defaultKeyEndDays,
} from "@/lib/ai/access-levels";
import { AI_TOOL_PLAIN_WORDS } from "@/lib/ai/tool-names";
import type { AiAccessToken } from "@/lib/ai/tokens";
import { ROLE_LABELS } from "@/lib/auth/roles";
import type { Role } from "@/lib/auth/roles";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import styles from "./ai.module.css";

type KeysResponse = {
  keys: AiAccessToken[];
  maxActiveKeys: number;
  maxActiveConnections: number;
  remoteAddress: string | null;
  /** The MCP address AI apps sign in at (https remote access only), or null. */
  signInAddress: string | null;
};

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

/** A box with text to copy and a Copy button. */
function CopyBox({ label, value, extra }: { label: string; value: string; extra?: ReactNode }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  return (
    <>
      <div className={styles.keyRow}>
        <input ref={setInput} className={styles.keyInput} aria-label={label} readOnly value={value} onFocus={(event) => event.target.select()} />
        <Button variant="secondary" onClick={async () => setCopied((await copyText(value, input)) ? "Copied." : "Selected: press Ctrl+C (or Cmd+C) to copy.")}>
          Copy
        </Button>
        {extra}
      </div>
      {copied ? (
        <p className={ui.muted} role="status">
          {copied}
        </p>
      ) : null}
    </>
  );
}

function NewKey({ token, onDone }: { token: string; onDone: () => void }) {
  return (
    <Notice tone="warning">
      <p>
        <strong>Copy this key now. It won&apos;t be shown again.</strong> Anyone with it can use these books as you, at the key&apos;s level, so keep it somewhere safe
        and only paste it into your own AI.
      </p>
      <CopyBox
        label="Your new AI key"
        value={token}
        extra={
          <Button variant="secondary" onClick={onDone}>
            I&apos;ve copied it
          </Button>
        }
      />
    </Notice>
  );
}

/** "Look only", and the capped level when the person's role allows less now. */
function LevelText({ level, role }: { level: AiAccessLevel; role: Role | null }) {
  const effective = role ? effectiveAccessLevel(level, role) : level;
  return (
    <>
      {AI_ACCESS_LEVEL_LABELS[level]}
      {effective !== level ? ` (${AI_ACCESS_LEVEL_LABELS[effective]} with your role)` : ""}
    </>
  );
}

/** One key or connection, as a short row that fits a phone. */
function AccessRow({ item, role, onRevoke }: { item: AiAccessToken; role: Role | null; onRevoke: (item: AiAccessToken) => void }) {
  const ended = Boolean(item.revokedAt) || item.expired;
  return (
    <li className={styles.item}>
      <div className={styles.itemMain}>
        <div className={styles.itemName}>
          {item.name}{" "}
          {item.revokedAt ? (
            <Badge tone="red">{item.kind === "connection" ? "Disconnected" : "Revoked"} {formatDateTime(item.revokedAt)}</Badge>
          ) : item.expired ? (
            <Badge tone="red">
              {item.kind === "connection"
                ? "Expired: not used for 60 days"
                : item.stopReason === "end_date"
                  ? `Ended ${item.stopsAt ? formatDateTime(item.stopsAt) : ""}`
                  : "Stopped: not used for 90 days"}
            </Badge>
          ) : null}
        </div>
        <div className={ui.muted}>
          {item.kind === "connection" ? (
            <>
              Sends you back to <strong>{item.appHost}</strong> ·{" "}
            </>
          ) : (
            <>
              <code>{item.startsWith}…</code> ·{" "}
            </>
          )}
          <LevelText level={item.accessLevel} role={role} /> · {item.kind === "connection" ? "connected" : "made"} {formatDateTime(item.createdAt)} · last used{" "}
          {item.lastUsedAt ? formatDateTime(item.lastUsedAt) : "never"}
          {item.kind === "key" && !ended && item.stopsAt ? (
            <>
              {" "}
              · {item.stopReason === "end_date" ? "ends" : "stops if not used by"} {formatDateTime(item.stopsAt)}
            </>
          ) : null}
        </div>
      </div>
      {ended ? null : (
        <Button variant="danger" size="small" onClick={() => onRevoke(item)}>
          {item.kind === "connection" ? "Disconnect" : "Revoke"}
        </Button>
      )}
    </li>
  );
}

function AccessList({ items, role, empty, endedLabel, onRevoke }: { items: AiAccessToken[]; role: Role | null; empty: string; endedLabel: string; onRevoke: (item: AiAccessToken) => void }) {
  const working = items.filter((item) => !item.revokedAt && !item.expired);
  const ended = items.filter((item) => item.revokedAt || item.expired);
  return (
    <>
      {working.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <ul className={styles.items}>
          {working.map((item) => (
            <AccessRow key={item.id} item={item} role={role} onRevoke={onRevoke} />
          ))}
        </ul>
      )}
      {ended.length ? (
        <details className={styles.ended}>
          <summary>
            {endedLabel} ({ended.length})
          </summary>
          <ul className={styles.items}>
            {ended.map((item) => (
              <AccessRow key={item.id} item={item} role={role} onRevoke={onRevoke} />
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

function More({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className={ui.collapsible}>
      <summary>{title}</summary>
      <Card>{children}</Card>
    </details>
  );
}

function AiConnect({ organisationId }: { organisationId: string }) {
  const confirm = useConfirm();
  const { current } = useWorkspace();
  const keys = useApiData<KeysResponse>("/api/ai/tokens", { organisationId });
  const [status, setStatus] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [name, setName] = useState("");
  const [accessLevel, setAccessLevel] = useState<AiAccessLevel>("read");
  const [fullConfirmed, setFullConfirmed] = useState(false);
  // "default": 90 days for a key that can post, none for one that only looks or drafts (#695).
  const [ends, setEnds] = useState<"default" | "30" | "90" | "365" | "none">("default");
  const [busy, setBusy] = useState(false);
  const role = current?.role ?? null;
  const ceiling = role ? roleCeiling(role) : "read";
  const [newToken, setNewToken] = useState<string | null>(null);

  const localUrl = `${window.location.origin}/api/mcp`;
  const remoteUrl = keys.data?.remoteAddress ? `${keys.data.remoteAddress}/api/mcp` : null;
  const signInUrl = keys.data?.signInAddress ?? null;
  const shownUrl = remoteUrl ?? localUrl;
  const keyForSnippet = newToken ?? "tohyee_ai_your-key-here";
  const all = keys.data?.keys ?? [];
  const connections = all.filter((item) => item.kind === "connection");
  const keyList = all.filter((item) => item.kind === "key");
  const activeKeys = keyList.filter((key) => !key.revokedAt && !key.expired);
  const shownEnds = ends === "default" ? String(defaultKeyEndDays(accessLevel) ?? "none") : ends;
  const atKeyLimit = keys.data ? activeKeys.length >= keys.data.maxActiveKeys : false;

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api<{ token: string; key: AiAccessToken }>("/api/ai/tokens", {
        method: "POST",
        body: { organisationId, name, accessLevel, endsInDays: shownEnds === "none" ? null : Number(shownEnds), ...(accessLevel === "full" ? { confirmFullAccess: fullConfirmed } : {}) },
      });
      setNewToken(result.token);
      setStatus({ tone: "success", text: `Made the key “${result.key.name}”.` });
      setName("");
      setAccessLevel("read");
      setEnds("default");
      setFullConfirmed(false);
      keys.reload();
    } catch (caught) {
      setStatus({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(item: AiAccessToken) {
    const question =
      item.kind === "connection"
        ? `Disconnect “${item.name}”? It stops working straight away; to use it again, connect it again from the app.`
        : `Revoke “${item.name}”? Any AI using it stops working straight away.`;
    if (!(await confirm(question))) return;
    try {
      await api(`/api/ai/tokens/${item.id}/revoke`, { method: "POST", body: { organisationId } });
      setStatus({ tone: "success", text: item.kind === "connection" ? `Disconnected “${item.name}”.` : `Revoked “${item.name}”.` });
      keys.reload();
    } catch (caught) {
      setStatus({ tone: "error", text: errorMessage(caught) });
    }
  }

  return (
    <>
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      {keys.error ? <Notice tone="error">{keys.error}</Notice> : null}

      <Card title="Connect your AI">
        {keys.data && signInUrl ? (
          <>
            <CopyBox label="MCP address" value={signInUrl} />
            <p>
              Paste this address into your AI app as a new connector. You&apos;ll be asked to sign in to Tohyee and choose the organisation and what the AI
              may do.
            </p>
          </>
        ) : keys.data ? (
          <Notice tone="info">
            Remote access is off, so AI in the cloud (Claude.ai, ChatGPT) can&apos;t reach Tohyee.{" "}
            <InfoTip label="Remote access">A server admin can turn it on in the Tohyee server app; this page then shows the address to paste. Until then, apps on this computer or network can use a key (below).</InfoTip>
          </Notice>
        ) : null}
      </Card>

      <Card title="Connected apps" description="AI apps you've signed in to these books. Each acts as you, at the level you chose.">
        <AccessList items={connections} role={role} empty="No AI apps connected yet." endedLabel="Ended connections" onRevoke={(item) => void revoke(item)} />
      </Card>

      <Card title="Keys">
        {newToken ? <NewKey token={newToken} onDone={() => setNewToken(null)} /> : null}
        <form className={ui.inlineForm} onSubmit={(event) => void create(event)}>
          <Field label="Name">
            <input placeholder="Claude on my laptop" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} required />
          </Field>
          <Field label="What it can do" hint={AI_ACCESS_LEVEL_HELP[accessLevel]}>
            <select
              value={accessLevel}
              onChange={(event) => {
                setAccessLevel(event.target.value as AiAccessLevel);
                setFullConfirmed(false);
              }}
            >
              {/* Full access is for Owners only (decision 488). */}
              {AI_ACCESS_LEVELS.filter((level) => level !== "full" || ceiling === "full").map((level) => (
                <option key={level} value={level}>
                  {AI_ACCESS_LEVEL_LABELS[level]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Ends" hint="It also stops if it isn't used for 90 days.">
            <select value={shownEnds} onChange={(event) => setEnds(event.target.value as "30" | "90" | "365" | "none")}>
              {["30", "90", "365", "none"].map((choice) => (
                <option key={choice} value={choice}>
                  {AI_KEY_END_LABELS[choice]}
                </option>
              ))}
            </select>
          </Field>
          <Button type="submit" disabled={busy || (accessLevel === "full" && !fullConfirmed) || atKeyLimit}>
            Create a key
          </Button>
        </form>
        {accessLevel === "full" ? (
          <Notice tone="warning">
            <p>
              <strong>Full access posts into your books.</strong> {FULL_ACCESS_WARNING}
            </p>
            <label>
              <input type="checkbox" checked={fullConfirmed} onChange={(event) => setFullConfirmed(event.target.checked)} /> I understand. Make a Full access
              key.
            </label>
          </Notice>
        ) : null}
        {ceiling === "read" ? (
          <Notice tone="info">
            Your role here is {role ? ROLE_LABELS[role] : "viewer"}, so your AI can only look things up, whatever you choose. Making drafts and posting need
            the bookkeeper role or higher.
          </Notice>
        ) : null}
        {keys.data && atKeyLimit ? <p className={ui.muted}>You have {keys.data.maxActiveKeys} keys, the most you can have here. Revoke one to make another.</p> : null}
        <AccessList items={keyList} role={role} empty="No keys yet." endedLabel="Revoked and ended keys" onRevoke={(item) => void revoke(item)} />
      </Card>

      <div className={styles.more}>
        <More title="Set up Claude Desktop with a key">
          <ol className={styles.steps}>
            <li>
              Install Node.js (nodejs.org) if you don&apos;t have it; the bridge below runs with <code>npx</code>.
            </li>
            <li>
              In Claude Desktop open Settings › Developer › Edit Config, and add this to <code>claude_desktop_config.json</code>
              {newToken ? " (it has your new key in it)" : ", putting your key in place of tohyee_ai_your-key-here"}:
              <pre className={styles.snippet}>{desktopConfig(shownUrl, keyForSnippet)}</pre>
              If the file already has <code>mcpServers</code>, add the <code>tohyee</code> entry inside it. This uses <code>mcp-remote</code>, an
              open-source bridge, to reach Tohyee with your key.
            </li>
            <li>Quit and reopen Claude Desktop, then ask it something like “What was our profit last month?”.</li>
          </ol>
        </More>

        <More title="Other apps: addresses, headers and protocol">
          <p>
            MCP address{remoteUrl ? " (from anywhere, through Remote access)" : " (on this computer or network)"}: <code>{shownUrl}</code>
            {remoteUrl ? (
              <>
                . On this computer or network you can also use <code>{localUrl}</code> with a key.
              </>
            ) : null}
          </p>
          <p>
            With a key, every request sends the header <code>Authorization: Bearer tohyee_ai_…</code>. An app that can&apos;t sign in but lets you add a
            header can use a key this way.
          </p>
          <p>
            Tohyee uses MCP&apos;s Streamable HTTP transport: JSON-RPC 2.0 by POST, answered with JSON (no event stream and no sessions). Signing in is
            OAuth 2.1 as the MCP specification describes: protected resource metadata, authorisation server metadata, client ID metadata documents or
            dynamic registration, the code flow with PKCE (S256), and tokens bound to the MCP address. Access tokens last an hour; refresh tokens 60 days,
            replaced each time they&apos;re used.
          </p>
        </More>

        <More title="What your AI can do">
          <p className={ui.muted}>Your AI can ask Tohyee for these, and nothing else. Each key or connection does only what its level allows.</p>
          {AI_ACCESS_LEVELS.map((level) => (
            <div key={level}>
              <h3 className={ui.cardTitle}>
                {AI_ACCESS_LEVEL_LABELS[level]}
                {level === "read" ? "" : " (also)"}
              </h3>
              <p className={ui.muted}>{AI_ACCESS_LEVEL_HELP[level]}</p>
              <ul className={styles.toolList}>
                {AI_TOOL_PLAIN_WORDS.filter((tool) => tool.level === level).map((tool) => (
                  <li key={tool.name}>{tool.words}</li>
                ))}
              </ul>
            </div>
          ))}
          <Notice tone="info">
            <strong>It never deletes.</strong> At every level, your AI can&apos;t delete, void, archive, roll back or remove anything, not even a draft.
            Those stay with people, in Tohyee. Only Full access records refunds you pay or receive, and it can undo a bank reconciliation it made itself in the
            last 24 hours, which reverses what it posted for that line on the line&apos;s date. Anything an approval rule covers waits for a person. Payroll
            isn&apos;t included, nor are users, roles, keys, lock dates or server settings.
          </Notice>
        </More>

        <More title="About connections and keys">
          <ul className={styles.toolList}>
            <li>
              A connection or key belongs to you and to this organisation only. It acts as you, so it can never do more than your role here (
              {role ? ROLE_LABELS[role] : "your role"}) allows, and no more than the level you chose.
            </li>
            <li>
              What it makes or changes shows in the history as you &ldquo;via AI app&rdquo; (a connection) or &ldquo;via AI key&rdquo;, with its name.
              Drafts it makes wait for you on the invoice, bill and journal pages.
            </li>
            <li>
              It stops when you disconnect or revoke it, when you&apos;re removed from this organisation, when your login is turned off, or when your password
              or two-step sign-in is reset. A connection not used for 60 days expires.
            </li>
            <li>An app&apos;s name is what the app calls itself; Tohyee can&apos;t check it. The address it sends you back to is shown with it.</li>
            <li>Tohyee keeps only a fingerprint (hash) of each key and token, so it can&apos;t show a key again. If you lose one, revoke it and make another.</li>
            <li>What your AI reads is sent to the AI service you use, under its terms. Only connect AI you&apos;re comfortable sharing these books with.</li>
          </ul>
        </More>
      </div>
    </>
  );
}

/** AJV5: how long after posting the AI may void a journal it posted itself. */
function JournalVoidLimit({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const settings = useApiData<{ maxDays: number | null }>("/api/ai/journal-void-settings", { organisationId });
  const [typed, setTyped] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (!settings.data) return null;
  const value = typed ?? (settings.data.maxDays === null ? "" : String(settings.data.maxDays));
  async function save() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await api<{ maxDays: number | null }>("/api/ai/journal-void-settings", { method: "PUT", body: { organisationId, maxDays: value.trim() === "" ? null : Number(value) } });
      setTyped(null);
      setMessage(saved.maxDays === null ? "No time limit." : `The AI can void its own journals for ${saved.maxDays} days after posting them.`);
      settings.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card
      title="Journals the AI posted"
      description="With Full access, an AI can void a manual journal it posted itself, never one a person posted or an invoice, bill or payment. It shows what it will reverse first, keeps the original, and can't void in a locked period or a journal matched to a bank line."
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      <div className={ui.inlineForm}>
        <Field label="Only within this many days of posting" hint="Blank: no limit.">
          <input type="number" min={1} max={3650} value={value} disabled={!can("admin") || busy} onChange={(event) => setTyped(event.target.value)} />
        </Field>
        {can("admin") ? (
          <Button onClick={() => void save()} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

export default function AiPage() {
  return (
    <Page>
      <PageHeader title="AI" />
      <RequireOrganisation>
        {(organisationId) => (
          <>
            <AiConnect key={organisationId} organisationId={organisationId} />
            <JournalVoidLimit key={`void-${organisationId}`} organisationId={organisationId} />
          </>
        )}
      </RequireOrganisation>
      <p className={ui.muted}>
        Chat with your AI in its own app. What it makes here, and the files you leave for it, are in{" "}
        <Link href="/operations/ai/workspace">AI dashboards and data</Link>; what it knows about the farm is in the{" "}
        <Link href="/operations/farming/notebook">farm notebook</Link>.
      </p>
    </Page>
  );
}
