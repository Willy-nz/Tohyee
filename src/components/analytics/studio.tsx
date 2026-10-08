"use client";

import Link from "next/link";
import { useState } from "react";
import { useWorkspace } from "@/components/workspace";
import { Field } from "@/components/ui";
import styles from "./studio.module.css";

export function AnalyticsNavigation({ active }: { active: "reports" | "sources" | "shaping" }) {
  const { can } = useWorkspace();
  return <nav className={styles.navigation} aria-label="Analytics workspace">
    <Link href="/analytics" aria-current={active === "reports" ? "page" : undefined}>Reports</Link>
    {can("viewer") ? <Link href="/analytics/sources" aria-current={active === "sources" ? "page" : undefined}>Data sources</Link> : null}
    {can("admin") ? <Link href="/analytics/shaping" aria-current={active === "shaping" ? "page" : undefined}>Prepare data</Link> : null}
  </nav>;
}

export type Connector = "books" | "csv" | "excel" | "email";
const connectors: { id: Connector; icon: string; title: string; description: string }[] = [
  { id: "books", icon: "T", title: "Books and CRM", description: "Use this organisation’s ledger, invoices, contacts and CRM. Refreshed nightly or on demand." },
  { id: "csv", icon: "CSV", title: "CSV file", description: "Connect an export in your analytics folder. Review fields and choose how often to reload." },
  { id: "excel", icon: "XLSX", title: "Excel workbook", description: "Choose a sheet from an .xlsx workbook, preview its columns and confirm field types." },
  { id: "email", icon: "@", title: "Report emails", description: "Collect CSV and Excel attachments from Gmail, Microsoft or IMAP into your analytics folder." },
];

export function ConnectorPicker({ selected, onSelect }: { selected: Connector | null; onSelect: (connector: Connector) => void }) {
  const [search, setSearch] = useState("");
  const matches = connectors.filter((entry) => `${entry.title} ${entry.description}`.toLowerCase().includes(search.toLowerCase().trim()));
  return <section className={styles.connectorSection} aria-label="Choose a connector">
    <div className={styles.sectionHeading}><div><h2>Connect your data</h2><p>Choose a source, check its fields, then use it across your reports.</p></div>
      <Field label="Search connectors"><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Files, books, email…" /></Field>
    </div>
    <div className={styles.connectors}>{matches.map((entry) => <button type="button" className={styles.connector} key={entry.id} aria-pressed={selected === entry.id} onClick={() => onSelect(entry.id)}>
      <span className={styles.connectorIcon} aria-hidden="true">{entry.icon}</span><strong>{entry.title}</strong><span>{entry.description}</span><b>Choose connector →</b>
    </button>)}</div>
    {!matches.length ? <p role="status">No connectors match your search.</p> : null}
    <p className={styles.note}>Direct connections to Google Sheets, BigQuery and external SQL databases are not available yet. Use a CSV or Excel export from those services.</p>
  </section>;
}
