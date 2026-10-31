"use client";

import { useState } from "react";
import { Field } from "@/components/ui";
import styles from "./studio.module.css";

export type Connector = "books" | "csv" | "excel" | "email" | "sqlserver" | "postgres" | "mysql" | "google-analytics" | "google-search-console" | "meta";

/** The connectors that read an external database (decision 602). */
export function isDatabaseConnector(connector: Connector | null): connector is "sqlserver" | "postgres" | "mysql" {
  return connector === "sqlserver" || connector === "postgres" || connector === "mysql";
}

const connectors: { id: Connector; icon: string; title: string; description: string }[] = [
  { id: "books", icon: "T", title: "Books and CRM", description: "Use this organisation’s ledger, invoices, contacts and CRM. Refreshed nightly or on demand." },
  { id: "csv", icon: "CSV", title: "CSV file", description: "Connect an export in your analytics folder. Review fields and choose how often to reload." },
  { id: "excel", icon: "XLSX", title: "Excel workbook", description: "Choose a sheet from an .xlsx workbook, preview its columns and confirm field types." },
  { id: "email", icon: "@", title: "Report emails", description: "Collect CSV and Excel attachments from Gmail, Microsoft or IMAP into your analytics folder." },
  { id: "sqlserver", icon: "SQL", title: "Microsoft SQL Server", description: "Read a table, view or SELECT query from a SQL Server database. Read only; reloaded nightly or on demand." },
  { id: "postgres", icon: "PG", title: "PostgreSQL", description: "Read a table, view or SELECT query from a PostgreSQL database. Read only; reloaded nightly or on demand." },
  { id: "mysql", icon: "My", title: "MySQL", description: "Read a table, view or SELECT query from a MySQL database. Read only; reloaded nightly or on demand." },
  { id: "google-analytics", icon: "GA", title: "Google Analytics", description: "A website's visitors, sessions, pages and traffic sources from a GA4 property. Loaded nightly or on demand." },
  { id: "google-search-console", icon: "SC", title: "Google Search Console", description: "How a website does in Google search: searches, clicks, impressions, position, pages, countries and devices. Loaded nightly or on demand." },
  { id: "meta", icon: "M", title: "Meta (Facebook and Instagram)", description: "A Facebook Page and its Instagram account: followers, reach, views and engagement by day, each post's figures, and optionally ad spend and results by campaign. Read only; loaded nightly or on demand." },
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
    <p className={styles.note}>Direct connections to Google Sheets and BigQuery are not available. Use a CSV or Excel export from those services.</p>
  </section>;
}
