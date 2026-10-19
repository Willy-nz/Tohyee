"use client";

import { useEffect, useRef, useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useConfirm } from "@/components/confirm-dialog";
import type { ColumnKind } from "@/lib/analytics/engine";
import type { DatabaseConnection, PreviewColumn } from "@/lib/analytics/databases/connections";
import type { ExternalObject } from "@/lib/analytics/databases/drivers";
import { DATABASE_ENGINES, DEFAULT_ROW_LIMIT, describeConnection, type DatabaseEngine, type Encryption, MAX_ROW_LIMIT } from "@/lib/analytics/databases/config";
import { tableNameFor } from "@/lib/analytics/databases/types";
import type { AnalyticsSource } from "@/lib/analytics/sources";
import { api, errorMessage } from "@/lib/client/api";

/**
 * Analytics › Data sources › SQL Server, PostgreSQL or MySQL (decisions
 * 602-605): choose or add a connection, test it, pick a table or view (or
 * write a SELECT), preview it, check each column's type, then load it into
 * this organisation's own copy. Admins and owners only.
 */

export const COLUMN_KINDS: Array<{ value: ColumnKind; label: string }> = [
  { value: "text", label: "Text" },
  { value: "money", label: "Money (2 decimals)" },
  { value: "quantity", label: "Quantity (4 decimals)" },
  { value: "decimal", label: "Number (6 decimals)" },
  { value: "integer", label: "Whole number" },
  { value: "date", label: "Date" },
  { value: "timestamp", label: "Date and time" },
  { value: "boolean", label: "Yes / no" },
];

/** The encryption choices in each database's own words. */
export function encryptionChoices(engine: DatabaseEngine): Array<{ value: Encryption; label: string }> {
  if (engine === "sqlserver") {
    return [
      { value: "verify", label: "Encrypt and check the certificate" },
      { value: "require", label: "Encrypt, trust the server's certificate" },
      { value: "off", label: "Don't encrypt" },
    ];
  }
  return [
    { value: "require", label: "Encrypt (don't check the certificate)" },
    { value: "verify", label: "Encrypt and check the certificate" },
    { value: "off", label: "Don't encrypt" },
  ];
}

/** What to tell people about read-only access for each database. */
export function readOnlyAdvice(engine: DatabaseEngine): string {
  if (engine === "sqlserver") {
    return "Use a login that can only read (for example one with just the db_datareader role). Tohyee only runs a single SELECT and checks every query, but SQL Server has no read-only session, so the login's rights are what make sure nothing can change.";
  }
  return "Use a database user that can only read (SELECT rights only). Tohyee only runs SELECT queries, inside read-only transactions, but a read-only user makes sure nothing can change.";
}

type Connections = { connections: DatabaseConnection[] };

export function DatabaseConnector({
  organisationId,
  engine,
  takenTables,
  onDone,
}: {
  organisationId: string;
  engine: DatabaseEngine;
  takenTables: string[];
  onDone: () => void;
}) {
  const list = useApiData<Connections>("/api/analytics/connections", { organisationId });
  const [editing, setEditing] = useState<DatabaseConnection | "new" | null>(null);
  const [chosen, setChosen] = useState<DatabaseConnection | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const confirm = useConfirm();
  const label = DATABASE_ENGINES[engine].label;
  const mine = (list.data?.connections ?? []).filter((connection) => connection.engine === engine);

  async function remove(connection: DatabaseConnection) {
    const ok = await confirm("Tohyee forgets its server, user and password. Nothing in the database changes.", {
      title: `Remove ${connection.name}?`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    setMessage(null);
    try {
      await api(`/api/analytics/connections/${connection.id}`, { method: "DELETE", query: { organisationId } });
      list.reload();
    } catch (caught) {
      setMessage(errorMessage(caught));
    }
  }

  if (chosen) {
    return (
      <DatabaseSourceSetup
        organisationId={organisationId}
        connection={{ id: chosen.id, name: chosen.name, engine: chosen.engine }}
        takenTables={takenTables}
        onDone={onDone}
        onCancel={() => setChosen(null)}
      />
    );
  }

  return (
    <>
      <Card
        title={`${label} connections`}
        description="Choose a connection to read a table, view or query from, or add one. Only admins and owners see these."
        actions={editing ? null : <Button size="small" onClick={() => setEditing("new")}>Add connection</Button>}
      >
        {message ? <Notice tone="error">{message}</Notice> : null}
        {list.error ? <Notice tone="error">{list.error}</Notice> : null}
        {!list.data ? (
          <p className={ui.muted}>Loading…</p>
        ) : mine.length === 0 ? (
          <Empty>No {label} connections yet. Choose Add connection.</Empty>
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Connection</th>
                  <th>Server and database</th>
                  <th>User</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {mine.map((connection) => (
                  <tr key={connection.id}>
                    <td>
                      <strong>{connection.name}</strong>
                      <div className={ui.muted}>{connection.sourceCount === 1 ? "1 source" : `${connection.sourceCount} sources`}</div>
                    </td>
                    <td>{describeConnection(connection)}</td>
                    <td>{connection.username}</td>
                    <td className={ui.num}>
                      <div className={ui.rowButtons}>
                        <Button size="small" onClick={() => setChosen(connection)}>Choose data</Button>
                        <Button size="small" variant="secondary" onClick={() => setEditing(connection)}>Edit</Button>
                        <Button size="small" variant="danger" onClick={() => void remove(connection)} disabled={connection.sourceCount > 0} title={connection.sourceCount > 0 ? "Remove its sources first" : undefined}>
                          Remove
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing ? (
        <ConnectionForm
          key={editing === "new" ? "new" : editing.id}
          organisationId={organisationId}
          engine={engine}
          existing={editing === "new" ? undefined : editing}
          onSaved={(saved) => {
            setEditing(null);
            list.reload();
            if (editing === "new") setChosen(saved);
          }}
          onCancel={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

function ConnectionForm({
  organisationId,
  engine,
  existing,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  engine: DatabaseEngine;
  existing?: DatabaseConnection;
  onSaved: (connection: DatabaseConnection) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [host, setHost] = useState(existing?.host ?? "");
  const [port, setPort] = useState(existing?.port ? String(existing.port) : "");
  const [instanceName, setInstanceName] = useState(existing?.instanceName ?? "");
  const [database, setDatabase] = useState(existing?.database ?? "");
  const [username, setUsername] = useState(existing?.username ?? "");
  const [password, setPassword] = useState("");
  const [encryption, setEncryption] = useState<Encryption>(existing?.encryption ?? (engine === "sqlserver" ? "verify" : "require"));
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [result, setResult] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const defaultPort = DATABASE_ENGINES[engine].defaultPort;

  const body = () => ({
    organisationId,
    name,
    engine,
    host,
    port: port.trim() || (engine === "sqlserver" && instanceName.trim() ? null : defaultPort),
    instanceName: engine === "sqlserver" ? instanceName.trim() || null : null,
    database,
    username,
    encryption,
    // Blank keeps the saved password (only for the same server, database and user).
    ...(password ? { password } : {}),
  });
  const found = (test: { tables: number; views: number }) =>
    `Connected. ${username} can see ${test.tables === 1 ? "1 table" : `${test.tables} tables`} and ${test.views === 1 ? "1 view" : `${test.views} views`}.`;

  async function test() {
    setBusy("test");
    setResult(null);
    try {
      const tested = await api<{ tables: number; views: number }>("/api/analytics/connections/test", {
        method: "POST",
        body: { ...body(), connectionId: existing?.id ?? null },
      });
      setResult({ tone: "success", text: found(tested) });
    } catch (caught) {
      setResult({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy("save");
    setResult(null);
    try {
      const saved = existing
        ? await api<{ connection: DatabaseConnection }>(`/api/analytics/connections/${existing.id}`, { method: "PATCH", body: body() })
        : await api<{ connection: DatabaseConnection }>("/api/analytics/connections", { method: "POST", body: body() });
      onSaved(saved.connection);
    } catch (caught) {
      setResult({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      title={existing ? `Change ${existing.name}` : `Add a ${DATABASE_ENGINES[engine].label} connection`}
      description="Tohyee connects from this server, so the database can be on your own network. The connection is tested before it's saved."
    >
      <Notice tone="info">{readOnlyAdvice(engine)}</Notice>
      {result ? <Notice tone={result.tone}>{result.text}</Notice> : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className={ui.grid}>
          <Field label="Connection name" hint="For you, e.g. Shop database.">
            <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} required />
          </Field>
          <Field label="Server" hint={engine === "sqlserver" ? "Name or IP address, e.g. OFFICE-PC or OFFICE-PC\\SQLEXPRESS." : "Name or IP address, e.g. 192.168.1.20."}>
            <input value={host} maxLength={260} autoComplete="off" spellCheck={false} onChange={(event) => setHost(event.target.value)} required />
          </Field>
          {engine === "sqlserver" ? (
            <Field label="Instance (optional)" hint="A named instance, e.g. SQLEXPRESS. Leave the port blank to find it through SQL Server Browser.">
              <input value={instanceName} maxLength={16} autoComplete="off" spellCheck={false} onChange={(event) => setInstanceName(event.target.value)} />
            </Field>
          ) : null}
          <Field label="Port" hint={engine === "sqlserver" && instanceName.trim() ? "Blank: found through SQL Server Browser." : `Blank: ${defaultPort}.`}>
            <input value={port} inputMode="numeric" maxLength={5} placeholder={engine === "sqlserver" && instanceName.trim() ? "" : String(defaultPort)} onChange={(event) => setPort(event.target.value.replace(/\D/g, ""))} />
          </Field>
          <Field label="Database">
            <input value={database} maxLength={128} autoComplete="off" spellCheck={false} onChange={(event) => setDatabase(event.target.value)} required />
          </Field>
          <Field label="User name">
            <input value={username} maxLength={128} autoComplete="off" spellCheck={false} onChange={(event) => setUsername(event.target.value)} required />
          </Field>
          <Field label="Password" hint={existing ? "Saved. Leave blank to keep it; it's needed again if the server, database or user changes." : "Kept encrypted on this server and never shown again."}>
            <input type="password" value={password} maxLength={1024} autoComplete="new-password" onChange={(event) => setPassword(event.target.value)} required={!existing} />
          </Field>
          <Field label="Encryption">
            <select value={encryption} onChange={(event) => setEncryption(event.target.value as Encryption)}>
              {encryptionChoices(engine).map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className={ui.rowButtons} style={{ marginTop: 16 }}>
          <Button type="submit" disabled={busy !== null}>
            {busy === "save" ? "Testing and saving…" : existing ? "Test and save" : "Test and save connection"}
          </Button>
          <Button variant="secondary" onClick={() => void test()} disabled={busy !== null}>
            {busy === "test" ? "Testing…" : "Test connection"}
          </Button>
          <Button variant="secondary" onClick={onCancel} disabled={busy !== null}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

type Preview = { columns: PreviewColumn[]; rows: string[][] };
type ColumnChoice = PreviewColumn & { include: boolean };

/** A table choice as the value of the table picker. */
export function objectKey(object: Pick<ExternalObject, "schema" | "name">): string {
  return JSON.stringify([object.schema, object.name]);
}

/** Setting up (or changing) a source from a database: what it reads, its columns and how they load. */
export function DatabaseSourceSetup({
  organisationId,
  connection,
  existing,
  takenTables,
  onDone,
  onCancel,
}: {
  organisationId: string;
  connection: { id: string; name: string; engine: DatabaseEngine };
  existing?: AnalyticsSource;
  takenTables: string[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const objects = useApiData<{ objects: ExternalObject[] }>(`/api/analytics/connections/${connection.id}/objects`, { organisationId });
  const [mode, setMode] = useState<"table" | "query">(existing?.database?.query ? "query" : "table");
  const [picked, setPicked] = useState<{ schema: string | null; table: string } | null>(
    existing?.database?.table ? { schema: existing.database.schema, table: existing.database.table } : null,
  );
  const [query, setQuery] = useState(existing?.database?.query ?? "");
  const [filter, setFilter] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [choices, setChoices] = useState<ColumnChoice[] | null>(null);
  const [name, setName] = useState(existing?.name ?? "");
  const [tableName, setTableName] = useState(existing?.tableName ?? "");
  const [rowLimit, setRowLimit] = useState(String(existing?.database?.rowLimit ?? DEFAULT_ROW_LIMIT));
  const [reloadDaily, setReloadDaily] = useState(existing?.reloadDaily ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runPreview(target: { schema: string | null; table: string } | { query: string }) {
    setPreviewing(true);
    setError(null);
    try {
      const result = await api<Preview>(`/api/analytics/connections/${connection.id}/preview`, { method: "POST", body: { organisationId, ...target } });
      setPreview(result);
      setChoices(
        result.columns.map((column) => {
          const saved = existing?.columns.find((entry) => entry.source === column.source);
          return {
            ...column,
            name: saved?.name ?? column.name,
            kind: saved?.kind ?? column.kind,
            include: column.loadable && (existing ? Boolean(saved) : true),
          };
        }),
      );
      if (!existing) {
        const base = "table" in target ? target.table : "query";
        if (!name) setName("table" in target ? target.table : `${connection.name} query`);
        if (!tableName) setTableName(tableNameFor(base, takenTables));
      }
    } catch (caught) {
      setPreview(null);
      setChoices(null);
      setError(errorMessage(caught));
    } finally {
      setPreviewing(false);
    }
  }

  // Changing a source starts from a fresh look at what it reads.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !existing?.database) return;
    started.current = true;
    const saved = existing.database;
    void runPreview(saved.query ? { query: saved.query } : { schema: saved.schema, table: saved.table ?? "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only once, for the source being changed
  }, []);

  function change(index: number, patch: Partial<ColumnChoice>) {
    if (!choices) return;
    setChoices(choices.map((column, at) => (at === index ? { ...column, ...patch } : column)));
  }

  async function save() {
    if (!choices) return;
    setBusy(true);
    setError(null);
    const body = {
      organisationId,
      name,
      connectionId: connection.id,
      ...(mode === "query" ? { query, table: null, schema: null } : { schema: picked?.schema ?? null, table: picked?.table ?? null, query: null }),
      rowLimit: rowLimit.trim() || DEFAULT_ROW_LIMIT,
      reloadDaily,
      columns: choices.filter((column) => column.include).map(({ source, name: columnName, kind }) => ({ source, name: columnName, kind })),
    };
    try {
      let sourceId = existing?.id;
      if (existing) {
        const { connectionId: _unchanged, ...changes } = body;
        void _unchanged;
        await api(`/api/analytics/sources/${existing.id}`, { method: "PATCH", body: changes });
      } else {
        const created = await api<{ source: AnalyticsSource }>("/api/analytics/sources", { method: "POST", body: { ...body, tableName } });
        sourceId = created.source.id;
      }
      // Load it straight away, so there's data to look at.
      await api(`/api/analytics/sources/${sourceId}/load`, { method: "POST", body: { organisationId } });
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const visible = (objects.data?.objects ?? []).filter((object) => `${object.schema ?? ""}.${object.name}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const tables = visible.filter((object) => object.kind === "table");
  const views = visible.filter((object) => object.kind === "view");
  const pickedKey = picked ? objectKey({ schema: picked.schema, name: picked.table }) : "";
  const label = (object: ExternalObject) => (object.schema ? `${object.schema}.${object.name}` : object.name);

  return (
    <Card
      title={existing ? `Change ${existing.name}` : `Choose data from ${connection.name}`}
      description="Pick a table or view, or write a SELECT query. Check each column's type: anything that's money should be Money, so totals are exact to the cent."
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.rowButtons} role="group" aria-label="What to read" style={{ marginBottom: 12 }}>
        <Button size="small" variant={mode === "table" ? "primary" : "secondary"} aria-pressed={mode === "table"} onClick={() => setMode("table")}>
          Table or view
        </Button>
        <Button size="small" variant={mode === "query" ? "primary" : "secondary"} aria-pressed={mode === "query"} onClick={() => setMode("query")}>
          SQL query
        </Button>
      </div>
      {mode === "table" ? (
        <>
          {objects.error ? <Notice tone="error">{objects.error}</Notice> : null}
          <div className={ui.grid}>
            <Field label="Find a table">
              <input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Name…" />
            </Field>
            <Field label="Table or view" hint={objects.loading ? "Reading the list…" : `${tables.length} tables, ${views.length} views.`}>
              <select
                value={pickedKey}
                onChange={(event) => {
                  if (!event.target.value) return;
                  const [schema, table] = JSON.parse(event.target.value) as [string | null, string];
                  setPicked({ schema, table });
                  void runPreview({ schema, table });
                }}
              >
                <option value="">Choose…</option>
                {picked && !visible.some((object) => objectKey(object) === pickedKey) ? <option value={pickedKey}>{picked.schema ? `${picked.schema}.${picked.table}` : picked.table}</option> : null}
                {tables.length ? (
                  <optgroup label="Tables">
                    {tables.map((object) => (
                      <option key={objectKey(object)} value={objectKey(object)}>
                        {label(object)}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {views.length ? (
                  <optgroup label="Views">
                    {views.map((object) => (
                      <option key={objectKey(object)} value={objectKey(object)}>
                        {label(object)}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
            </Field>
          </div>
          {picked && !preview ? (
            <div className={ui.rowButtons} style={{ marginTop: 12 }}>
              <Button size="small" variant="secondary" onClick={() => void runPreview(picked)} disabled={previewing}>
                {previewing ? "Reading…" : "Preview"}
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <Field label="SELECT query" hint="One SELECT (it may start with WITH). Anything that changes data is refused.">
            <textarea value={query} rows={8} maxLength={20000} spellCheck={false} style={{ fontFamily: "var(--font-mono, monospace)", width: "100%" }} onChange={(event) => setQuery(event.target.value)} />
          </Field>
          <div className={ui.rowButtons} style={{ marginTop: 12 }}>
            <Button size="small" variant="secondary" onClick={() => void runPreview({ query })} disabled={previewing || !query.trim()}>
              {previewing ? "Running…" : "Preview"}
            </Button>
          </div>
        </>
      )}
      {previewing ? <p className={ui.muted} role="status">Reading the first rows…</p> : null}

      {choices && preview ? (
        <>
          <div className={ui.grid} style={{ marginTop: 16 }}>
            <Field label="Name">
              <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
            </Field>
            <Field label="Table" hint={existing ? "Reports use this name, so it can't change." : "Lower-case letters, digits and _."}>
              <input value={tableName} disabled={Boolean(existing)} maxLength={63} onChange={(event) => setTableName(event.target.value)} />
            </Field>
            <Field label="Row limit" hint={`A load with more rows stops, so totals are never from part of the data. Up to ${MAX_ROW_LIMIT.toLocaleString("en-NZ")}.`}>
              <input value={rowLimit} inputMode="numeric" maxLength={7} onChange={(event) => setRowLimit(event.target.value.replace(/\D/g, ""))} />
            </Field>
          </div>
          <label className={ui.checkbox}>
            <input type="checkbox" checked={reloadDaily} onChange={(event) => setReloadDaily(event.target.checked)} /> Load again every night after 4am
          </label>
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Load</th>
                  <th>Column in the database</th>
                  <th>Column name</th>
                  <th>Type</th>
                  <th>First values</th>
                </tr>
              </thead>
              <tbody>
                {choices.map((column, index) => (
                  <tr key={column.source}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Load ${column.source}`}
                        checked={column.include}
                        disabled={!column.loadable}
                        onChange={(event) => change(index, { include: event.target.checked })}
                      />
                    </td>
                    <td>
                      {column.source}
                      <div className={ui.muted}>{column.detected}</div>
                    </td>
                    <td>
                      <input
                        aria-label={`Name for ${column.source}`}
                        value={column.name}
                        maxLength={63}
                        disabled={!column.include}
                        onChange={(event) => change(index, { name: event.target.value })}
                      />
                    </td>
                    <td>
                      {column.loadable ? (
                        <select
                          aria-label={`Type for ${column.source}`}
                          value={column.kind}
                          disabled={!column.include}
                          onChange={(event) => change(index, { kind: event.target.value as ColumnKind })}
                        >
                          {COLUMN_KINDS.map((kind) => (
                            <option key={kind.value} value={kind.value}>
                              {kind.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Badge>Binary: not loaded</Badge>
                      )}
                    </td>
                    <td className={ui.muted}>{column.examples.filter(Boolean).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>First {preview.rows.length} rows</summary>
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <thead>
                  <tr>{preview.columns.map((column) => <th key={column.source} scope="col">{column.source}</th>)}</tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, at) => (
                    <tr key={at}>{row.map((value, index) => <td key={index}>{value}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      ) : null}
      <div className={ui.rowButtons} style={{ marginTop: 16 }}>
        <Button onClick={() => void save()} disabled={busy || previewing || !choices || !choices.some((column) => column.include)}>
          {busy ? "Saving and loading…" : existing ? "Save and load" : "Set up and load"}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
