# Analytics: review and build plan

Written 3 October 2026 and discussed with Jess the same day (her answers
are at the end). Licence and product facts were
checked against each project's own repository or help pages on this date;
anything that couldn't be checked is marked *unverified*.

## What Jess asked for

- Bring data in like Looker Studio; build reports like Power BI.
- CSV files (up to about 1 million rows) in a folder on the server, loaded
  again every day.
- Tohyee's own accounting and CRM data, taken "in a professional way".
- Google Analytics, Meta, LinkedIn, Shopify and similar data arriving by
  scheduled report emails: Tohyee reads a folder or label you set up in your
  own mailbox and saves the files into the server folder.
- Possibly Power Query-like merging and shaping.
- Clients can see reports too.

The made-up test used throughout: a 1M-row sales CSV plus two Tohyee
organisations, answering *monthly sales by region against last year*, *top
20 customers*, and *gross margin from the books beside CSV sales*, with date
and region filters, shared read-only with a client.

## Short answer

1. **Yes, it needs its own database**, but not another PostgreSQL. Each
   organisation gets one analytics file using **DuckDB**, an embedded
   database built for exactly this kind of reporting (MIT licence, runs
   inside Tohyee's server, nothing extra to install on Windows). The
   organisation's PostgreSQL database stays the source of truth and doesn't
   grow; invoice PDFs and CRM history never go into the analytics file.
2. **None of the open-source BI tools can be dropped in.** Metabase needs
   Java, Superset and Redash need Python, Lightdash needs Docker. Each would
   be a second program to install, update and back up on every customer's
   server. We build the report screens into Tohyee and borrow the good ideas.
3. **The email route works for some sources, not all** (details below).
   Google Analytics and Microsoft Advertising are confirmed to email a CSV.
   Looker Studio only emails a PDF. LinkedIn, Shopify and Instagram
   insights have no scheduled email of their own.

## Test results (run here, 3 Oct 2026)

On this container (2 CPUs, 8 GB), with `@duckdb/node-api` 1.5.6:

| Step | Time |
|---|---|
| Write the made-up CSV: 1,000,000 rows, 67.6 MB | (setup) |
| Load it into DuckDB, money as exact decimals | 0.6-0.75 s |
| Swap the new table in for the old one | 2 ms |
| Monthly sales by region against last year (264 rows) | 43 ms |
| Top 20 customers, filtered to 2025 and Auckland | 12 ms |
| Gross margin % by month | 34 ms |
| Read 200,000 made-up journal lines from PostgreSQL | 0.57 s |
| Copy them into DuckDB | 0.25 s |

- The analytics file for the 1M rows was 11.5 MB (the CSV was 67.6 MB).
- **Money must be loaded as decimals.** Left to guess, DuckDB read prices
  as floating-point numbers, and the same Auckland total came out as
  327,516,613.5500009 on one run and ...5500015 on the next. Loaded as
  decimals it was exactly 327,516,613.55 every time, and the 200,000 copied
  journal lines totalled exactly what PostgreSQL said (998,960,804.01).
  Tohyee's rule (money never in floats) carries over: the loader asks which
  columns are money and loads them as decimals.
- DuckDB's PostgreSQL plug-in downloads itself on first use, which was
  refused here (no internet from this container) and would be fragile on
  customers' servers. Copying with Tohyee's existing PostgreSQL driver
  (above) was fast enough, so we don't need the plug-in.
- Not yet tested on Windows. The Windows build of DuckDB for Node exists
  (`@duckdb/node-bindings-win32-x64`, about 38 MB unpacked). Step 1 below
  repeats this test on GitHub's Windows runner.

### Repeatable engine benchmark

Run `npx tsx scripts/analytics-benchmark.ts [rows]` (default: 1,000,000).
It writes synthetic sales with integer seed 353 and UTC dates, loads them
through Tohyee's CSV engine, times the three report queries, and compares
the exact sales total with decimal arithmetic over the CSV text. Its
temporary files are removed after the run.

The Markdown table includes load and query times, row counts, CSV and
checkpointed DuckDB sizes, and RSS sampled every 10 ms and after each step.
The Windows installer workflow runs it after building the app and appends
the table to the job summary. The installer test also checks the packaged
`duckdb.node` and `duckdb.dll` and loads a two-row CSV through the signed-in
installed server's API. Windows results must come from that run's logs
and summary, not from the Linux figures above.

## Open-source review

All licences checked in each project's own repository on 3 Oct 2026.

### Report and dashboard tools

| Tool | Licence | Needs | Take |
|---|---|---|---|
| Metabase | AGPL-3.0, except a commercial `enterprise/` part | Java 25 | Ideas only (question builder, dashboard filters). Licence would be fine, but bundling Java isn't, and much of its embedding is paid |
| Apache Superset | Apache-2.0 | Python; no Windows install path | Ideas only (chart builder) |
| Lightdash | MIT, except a source-available `ee/` part | Docker to self-host | Ideas: metrics defined once, then an "explore" screen |
| Evidence | MIT | Builds static report sites | Ideas: reports as fixed snapshots suit client sharing and PDFs |
| Redash | BSD-2-Clause | Python | Skip |

### Engine

| Engine | Licence | Take |
|---|---|---|
| **DuckDB** | MIT | **Use.** Runs inside Node (`@duckdb/node-api`, current; the old `duckdb` package is deprecated), Windows x64 build available, reads CSV, Excel and Parquet natively |
| Apache DataFusion | Apache-2.0 | Skip: no official Node package |
| chDB (ClickHouse) | Apache-2.0 | Skip: no Windows support |

### Shaping, semantic layer, connectors

| Tool | Licence | Take |
|---|---|---|
| dbt-core | Apache-2.0 | Skip (Python). Idea: each shaped table is defined as steps that produce SQL |
| dbt Fusion | Mostly Elastic License 2.0 (not open source) | Avoid |
| SQLMesh | Apache-2.0 | Skip (Python) |
| Apache Hop | Apache-2.0 | Skip (Java). Idea for a visual steps screen |
| Cube | Apache-2.0 (client MIT) | Borrow its design (measures and dimensions defined once); running it inside Tohyee is untested and heavy |
| dlt, Meltano | Apache-2.0, MIT | Skip (Python) |
| Airbyte | Elastic License 2.0 | Avoid (not open source; Docker) |

### Charts and tables

| Library | Licence | Take |
|---|---|---|
| **Apache ECharts** 6 | Apache-2.0 (its zrender dependency BSD-3) | **Use** for charts: the Power BI-like range (bar, line, combo, pie, scatter, map, gauge, funnel) |
| **Perspective** | Apache-2.0 | **Use** for pivot tables and big grids (handles about 1M rows in the browser). It has moved from `@finos/...` to `@perspective-dev/...` |
| Observable Plot | ISC | Possible for quick exploring charts; not needed if ECharts is used |
| react-pivottable | MIT | Lighter pivot fallback |

**Licences together.** Everything marked Use is MIT, Apache-2.0, ISC or
BSD, which can be included in AGPL-3.0 Tohyee. The FSF licence list itself
couldn't be fetched here, so that's from what is well established rather
than re-checked today. The installer must ship each one's licence and
NOTICE files. Elastic License tools (Airbyte, dbt Fusion) can't be
included.

## Report emails: what actually arrives

| Source | Scheduled email? | What arrives | Checked |
|---|---|---|---|
| Google Analytics 4 | Yes: daily, weekly, monthly, quarterly; admins only | **CSV or PDF attachment** (you choose) | Google help page. A schedule lasts 1-12 months, then must be renewed |
| Microsoft Advertising | Yes: daily, weekly, monthly | **Zipped CSV** attached, if "include as attachment" is ticked | Microsoft help page |
| Google Ads | Yes | CSV, Excel and others offered; *unverified* whether attached or linked | Google help page |
| Looker Studio | Yes | **PDF only**, no CSV | Google help page (Portuguese) |
| Meta Ads Manager | Probably | *Unverified*: Meta's help pages block automated reading; other sites disagree | Third-party only |
| LinkedIn Campaign Manager | No (manual export only) | — | Third-party only, *unverified* |
| Instagram / Meta Business Suite insights | No (manual export only) | — | Third-party only |
| Shopify | No scheduled email; needs a report app or a direct connection | — | Shopify help page |

What that means:

- The email route works now for Google Analytics and Microsoft Advertising,
  and probably Google Ads and Meta Ads; we confirm those with one real test
  send each before relying on them.
- Looker Studio PDFs can't be loaded as data. GA4 can send its own CSV
  instead.
- LinkedIn, Instagram and Shopify need another way in. A manual export
  dropped in the folder works today. Shopify has a simple, well-documented
  API (a token made in your own store), so a direct Shopify connection is a
  sensible later step. LinkedIn and Meta direct connections need app
  approval from those companies, so they stay out for now.
- No platform documents its sender address, so a mailbox rule files them by
  subject or sender after a first test send.

### Reading the mailbox folder

Tohyee's CRM email sync already connects a Gmail or Microsoft 365 mailbox
with the organisation's own Google or Microsoft app, read-only
(`gmail.readonly`; `Mail.Read`). Analytics reuses that connection and only
looks in the folder or label you choose.

- Neither Google nor Microsoft has a permission for one folder only. Read
  access covers the whole mailbox; Tohyee simply only opens the chosen
  folder. Saying that plainly on the setup screen.
- **A catch found during this review, which also affects the existing CRM
  email sync:** a Google app left in "Testing" mode loses its access after
  7 days. For a Google Workspace account, making the app "Internal" avoids
  that. For a personal Gmail it doesn't. To look into before building:
  either confirm how the CRM sync copes now, or offer IMAP with a Gmail app
  password as the simple alternative (Google still allows this with
  2-Step Verification; it can read one label only and needs no Google
  app). Microsoft 365 IMAP needs the Microsoft app (passwords are switched
  off there).
- Tohyee never moves, marks or deletes emails. It remembers which messages
  it has saved, so each file is saved once.

## How it fits Tohyee

- **Per organisation.** Analytics is a module switched on per organisation,
  like the CRM. Its data file sits beside the organisation's database in
  Tohyee's data folder. No organisation can see another's analytics, which
  keeps the one-database-per-organisation rule.
- **Definitions in PostgreSQL, data in DuckDB.** Data sources, load
  settings, shaping steps, measures, reports and dashboards are kept in the
  organisation's own PostgreSQL database, so they are backed up and
  restored with it. The DuckDB file is only loaded data and can always be
  rebuilt from the sources, so it doesn't need separate backups (a backup
  could still copy it to save reloading).
- **Every load is recorded by the loader**: when, which file, how many rows,
  how long, and any error. Nothing is a status someone types in.
- **Tohyee's own data, done properly.** A fixed, documented set of tables is
  copied from the organisation's books and CRM in a read-only transaction:
  journal lines with accounts and periods, invoices and bills with their
  lines, contacts, items, and CRM records and activities. Their column names
  stay the same between versions, so reports don't break when Tohyee
  updates. Gross margin and other figures must agree with Tohyee's own
  reports for the same period; that needs worked examples before it's
  built.
- **Other organisations.** For a practice (your work, or the future
  Practice manager), reporting across client organisations means one
  organisation reading another's copied books. That needs a deliberate rule
  about who may do it; left for later.
- **Access.** Owner and admin set up sources. A new "report viewer" access
  sees only the dashboards shared with them, so a client can log in and see
  their reports and nothing else. Scheduled PDF emails of a dashboard use
  Tohyee's existing email sending.
- **AI.** Later, the "Connect your own AI" tools can be given read access to
  the analytics data too, so you can ask your AI about it.

## Build steps

Each step is its own pull request with tests, checked with made-up data
before moving on.

1. **Engine and CSV folder.** Add DuckDB. A folder setting per organisation
   (server admins choose the folder on the server). Tohyee finds the CSV and
   Excel files, shows a preview with detected column types, you confirm
   which columns are money, dates and text. Loads every night (and on
   demand) into a new table, swapped in only when the load succeeds, so a
   bad file never leaves you with half a table. Load history screen. Run the
   1M-row test on GitHub's Windows runner and bundle DuckDB in the
   installer.
2. **Tohyee books and CRM.** The fixed set of copied tables, refreshed
   nightly and on demand. Worked examples first, so the figures are proved
   to match Tohyee's own reports.
3. **Reports and dashboards.** Pick a table, drag fields into a chart
   (ECharts) or a pivot table (Perspective). Measures defined once (for
   example "Sales = quantity x unit price"), date and value filters,
   slicers that filter a whole dashboard, light and dark themes. Joining a
   CSV table to Tohyee contacts or accounts by a matching column.
4. **Sharing with clients.** The report viewer access, dashboards shared to
   chosen people, PDF export and scheduled PDF emails.
5. **Report emails.** Choose the mailbox folder or label; Tohyee saves the
   CSV, Excel and zipped CSV attachments into the organisation's folder,
   ready for step 1's loader. Test with real sends from GA4 and Google Ads
   first.
6. **Shaping (the Power Query part).** A list of applied steps per table:
   filter rows, remove or rename columns, change types, split a column,
   unpivot, group, add a calculated column, merge two tables, append tables.
   Each step shows a preview; the steps become SQL that DuckDB runs at load
   time.
7. **Later.** A direct Shopify connection; reporting across client
   organisations for practices; AI access to analytics; other direct
   connections only where the provider allows them without app review.

Steps 1-4 make it usable for CSV-based reporting at work; 5 and 6 make it
much less manual.

## Jess's answers (3 Oct 2026)

1. Analytics is per organisation, when it's turned on.
2. Reports shared with clients are secure: clients sign in, as for the
   accounting, and see only what's shared with them. No public links.
3. Use GitHub's coding agent (Copilot) for parts of the build.
4. Mailboxes: not sure yet; personal Gmail and Microsoft email may need to
   be options. Decided before step 5.

These are decisions 353-362 in `docs/DECISIONS.md`.

## Who builds what

- **Claude**: step 1 (the engine, folder loader and the patterns the rest
  follow), then reviews every pull request the coding agent opens, and
  writes the worked examples for step 2 for Jess to approve.
- **GitHub's coding agent**, from GitHub issues with a clear brief, on
  pieces that don't depend on unfinished work: the Windows test of DuckDB
  first, then the chart and pivot components, then later steps as each
  foundation is merged.
- Nothing is merged without passing lint, type checks, tests and the
  build, and a review.

## Sources

- DuckDB licence: https://github.com/duckdb/duckdb/blob/main/LICENSE
- DuckDB for Node: https://www.npmjs.com/package/@duckdb/node-api,
  https://github.com/duckdb/duckdb-node (deprecation note)
- DuckDB extensions offline: https://github.com/duckdb/duckdb-web/tree/main/docs/current/extensions
- Metabase: https://github.com/metabase/metabase/blob/master/LICENSE.txt
- Superset: https://github.com/apache/superset/blob/master/LICENSE.txt
- Lightdash: https://github.com/lightdash/lightdash/blob/main/LICENSE
- Evidence: https://github.com/evidence-dev/evidence/blob/main/LICENSE
- Redash: https://github.com/getredash/redash/blob/master/LICENSE
- DataFusion: https://github.com/apache/datafusion/blob/main/LICENSE.txt
- chDB Node: https://github.com/chdb-io/chdb-node
- dbt-core: https://github.com/dbt-labs/dbt-core/blob/main/LICENSE;
  dbt Fusion: https://github.com/dbt-labs/dbt-fusion/blob/main/LICENSES.md
- SQLMesh: https://github.com/TobikoData/sqlmesh
- Apache Hop: https://github.com/apache/hop/blob/main/LICENSE
- Cube: https://github.com/cube-js/cube/blob/master/LICENSE
- dlt: https://github.com/dlt-hub/dlt/blob/devel/LICENSE.txt
- Airbyte: https://github.com/airbytehq/airbyte-platform/blob/main/LICENSE
- Meltano: https://github.com/meltano/meltano/blob/main/LICENSE
- ECharts: https://github.com/apache/echarts/blob/master/LICENSE
- Perspective: https://github.com/perspective-dev/perspective/blob/master/LICENSE.md
- Observable Plot: https://github.com/observablehq/plot/blob/main/LICENSE
- react-pivottable: https://github.com/plotly/react-pivottable/blob/master/LICENSE
- GA4 scheduled reports: https://support.google.com/analytics/answer/13722168
- Looker Studio delivery: https://docs.cloud.google.com/looker/docs/studio/schedule-automatic-report-delivery?hl=pt-br
- Google Ads reports: https://support.google.com/google-ads/answer/2404176
- Microsoft Advertising reports: https://learn.microsoft.com/en-us/advertising/msa-help/hlp_ba_proc_createreport
- Shopify exports: https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/using-reports/export-reports
- Gmail scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
- Google app audience (Testing, 7 days): https://support.google.com/cloud/answer/15549945
- Exchange RBAC for Applications: https://learn.microsoft.com/Exchange/permissions-exo/application-rbac
- Exchange basic auth: https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online
- Google app passwords and IMAP: https://workspaceupdates.googleblog.com/2023/09/winding-down-google-sync-and-less-secure-apps-support.html
