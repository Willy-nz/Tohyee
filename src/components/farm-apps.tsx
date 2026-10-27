"use client";

import { type FormEvent, useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import type { FarmAppKey } from "@/lib/farm-apps/keys";
import { FARM_APP_SCOPE_LABELS, FARM_APP_SCOPES, type FarmAppScope } from "@/lib/farm-apps/scopes";
import { formatDate } from "@/lib/format";
import type { FarmAppLauncher } from "@/lib/farming/launchers";
import { useWorkspace } from "@/components/workspace";

/**
 * Farming › Apps (#249 stage 5; FA1-FA8, decision 561): the signed-in
 * person's own keys for apps they build or use, each with the scopes it
 * needs. The key is shown once.
 */

const GUIDE = "https://github.com/Willy-nz/Tohyee/blob/main/docs/FARM-APPS.md";
/** A timestamp as the browser's own date (an ISO date in UTC can be the day before in New Zealand). */
const localDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA");

const SAMPLE = "https://github.com/Willy-nz/Tohyee/tree/main/examples/farm-apps/soil-sampling";

export function FarmApps({ organisationId }: { organisationId: string }) {
  const keys = useApiData<{ keys: FarmAppKey[]; maxActiveKeys: number; scopesAllowed: FarmAppScope[] }>("/api/farming/app-keys", { organisationId });
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<FarmAppScope[]>(["read_farm"]);
  const [made, setMade] = useState<{ key: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = typeof window === "undefined" ? "/api/farm-apps/v1" : `${window.location.origin}/api/farm-apps/v1`;
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  const create = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await api<{ key: string; appKey: FarmAppKey }>("/api/farming/app-keys", { method: "POST", body: { organisationId, name, scopes } });
      setMade({ key: result.key, name: result.appKey.name });
      setName("");
      keys.reload();
    });
  };
  const allowed = keys.data?.scopesAllowed ?? [];
  const active = keys.data?.keys.filter((key) => !key.revokedAt) ?? [];
  return (
    <>
      <AppTiles organisationId={organisationId} />
      <h2>Manage integrations</h2>
      <Card title="Apps you build or use" description="An app key lets an app read farm data and record field work through Tohyee's Farming API, as you, and only what you tick. It can't reach the books, payroll or contacts, and it posts nothing.">
        <p>
          The API is at <code>{base}</code>, described in <a href={`${base}/openapi.json`}>openapi.json</a>. The <a href={GUIDE}>guide</a> shows an AI tool how to build an app against it, and the{" "}
          <a href={SAMPLE}>soil sampling app</a> is a working example.
        </p>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {made ? (
          <Notice tone="success">
            Here&apos;s the key for {made.name}. Copy it now: Tohyee won&apos;t show it again.
            <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", margin: "8px 0 0" }}>{made.key}</pre>
          </Notice>
        ) : null}
        <form onSubmit={create}>
          <div className={ui.inlineForm}>
            <Field label="App name">
              <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} required placeholder="Soil sampler" />
            </Field>
          </div>
          <fieldset style={{ border: "none", padding: 0, margin: "8px 0" }}>
            <legend>What the app may do</legend>
            {FARM_APP_SCOPES.map((scope) => (
              <label key={scope} className={ui.checkbox} style={{ display: "block" }}>
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  disabled={!allowed.includes(scope)}
                  onChange={(event) => setScopes((current) => (event.target.checked ? [...current, scope] : current.filter((entry) => entry !== scope)))}
                />{" "}
                {FARM_APP_SCOPE_LABELS[scope]}
                {!allowed.includes(scope) ? <span className={ui.muted}> (needs the bookkeeper role)</span> : null}
              </label>
            ))}
          </fieldset>
          <Button type="submit" disabled={busy || scopes.length === 0 || active.length >= (keys.data?.maxActiveKeys ?? 10)}>
            Make a key
          </Button>
        </form>
      </Card>
      <Card title="Your app keys" description="Only the keys you made. A key stops working when you revoke it, leave the organisation, or your password or two-step sign-in is reset.">
        {keys.error ? <Notice tone="error">{keys.error}</Notice> : null}
        {keys.data && keys.data.keys.length === 0 ? <Empty>No app keys yet.</Empty> : null}
        {keys.data && keys.data.keys.length ? (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>App</th>
                  <th>Starts with</th>
                  <th>May</th>
                  <th>Made</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.data.keys.map((key) => (
                  <tr key={key.id}>
                    <td data-label="App">
                      <strong>{key.name}</strong> {key.revokedAt ? <Badge tone="neutral">Revoked</Badge> : null}
                    </td>
                    <td data-label="Starts with">
                      <code>{key.startsWith}…</code>
                    </td>
                    <td data-label="May">{key.scopes.map((scope) => FARM_APP_SCOPE_LABELS[scope]).join("; ")}</td>
                    <td data-label="Made">{formatDate(localDay(key.createdAt))}</td>
                    <td data-label="Last used">{key.lastUsedAt ? formatDate(localDay(key.lastUsedAt)) : "Never"}</td>
                    <td>
                      {key.revokedAt ? null : (
                        <button type="button" className={ui.linkButton} disabled={busy} onClick={() => void run(async () => { await api(`/api/farming/app-keys/${key.id}/revoke`, { method: "POST", body: { organisationId } }); keys.reload(); })}>
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
    </>
  );
}

/**
 * Launch tiles (#447, decision 908): the apps the farm uses, by name and
 * address, shown on the farm's Today and More pages. Admins add and remove
 * them; a tile never holds a key.
 */
function AppTiles({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const launchers = useApiData<{ launchers: FarmAppLauncher[] }>("/api/farming/launchers", { organisationId });
  const [form, setForm] = useState({ name: "", url: "", description: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      launchers.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  const list = launchers.data?.launchers ?? [];
  return (
    <Card title="App tiles" description="Apps the farm uses, shown as tiles on the farm's Today and More pages. A tile is only a name and an address: each app asks for its own key.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {launchers.error ? <Notice tone="error">{launchers.error}</Notice> : null}
      {launchers.data && !list.length ? <Empty>No app tiles yet.</Empty> : null}
      {list.length ? (
        <ul>
          {list.map((launcher) => (
            <li key={launcher.id}>
              <a href={launcher.url} target="_blank" rel="noreferrer noopener">
                {launcher.name}
              </a>
              {launcher.description ? <span className={ui.muted}> · {launcher.description}</span> : null}{" "}
              {can("admin") ? (
                <button type="button" className={ui.linkButton} disabled={busy} onClick={() => void run(async () => void (await api(`/api/farming/launchers/${launcher.id}`, { method: "DELETE", query: { organisationId } })))}>
                  Remove tile
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {can("admin") ? (
        <form
          className={ui.inlineForm}
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await api("/api/farming/launchers", { method: "POST", body: { organisationId, ...form, description: form.description || null } });
              setForm({ name: "", url: "", description: "" });
            });
          }}
        >
          <Field label="Name">
            <input value={form.name} maxLength={60} required onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
          <Field label="Address" hint="https://…">
            <input type="url" value={form.url} maxLength={500} required onChange={(event) => setForm({ ...form, url: event.target.value })} />
          </Field>
          <Field label="What it's for">
            <input value={form.description} maxLength={200} onChange={(event) => setForm({ ...form, description: event.target.value })} />
          </Field>
          <Button type="submit" disabled={busy}>
            Add tile
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

