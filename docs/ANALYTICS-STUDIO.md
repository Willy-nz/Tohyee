# Analytics workspace

The Analytics workspace has three entry points: Reports, Data sources and Prepare data. Existing dashboard URLs and saved definitions are retained.

- Reports can be searched by name or description, sorted by name or most recently updated, and viewed as cards or a table. Create report opens a blank report. Card previews identify the saved visual types; they do not invent sample figures.
- Data sources separates connected sources, connector selection and load history. Connected file sources expose their field names, original headings and types. CSV and Excel connector choices filter the available server-folder files; existing preview, type mapping, loading and nightly refresh flows are reused. Books/CRM and report-email collection use their existing services.
- The chart editor places a searchable field catalogue beside a live preview and a properties panel. Choose a visual, source, dimensions, measures, filters and width, then add it to the report or apply changes. Saving is disabled while a preview is pending or invalid. Report-level save/view and delete wait until the chart editor is closed, so they cannot silently abandon an unfinished chart.
- Sharing is opened explicitly from the report toolbar. Report viewers stay in viewing mode even with `?edit=1` and do not request source schemas.

Direct Google Sheets, BigQuery and external SQL connections, a free-position drag-and-drop canvas and multi-page reports are not implemented. The source picker says which connections are available. The current report model retains half/full-width tiles, ordering, dates, slicers, pivots and sharing.

## Design references

The supplied Looker Studio screenshots informed the source library, connector picker and report workspace. Interaction references, without copying source code:

- https://www.metabase.com/docs/latest/dashboards/introduction
- https://superset.apache.org/docs/using-superset/exploring-data/

## Validation

Unit coverage checks connector availability, navigation permissions and forced edit URLs for report viewers. Browser checks against mocked API responses exercise report search/list views, source field inspection, Excel file filtering, load history, live chart editing and saving, report-viewer schema restrictions, and phone-width layouts. These checks do not establish live external service connectivity or database integration; the existing PostgreSQL integration suite requires `TEST_DATABASE_URL`.
