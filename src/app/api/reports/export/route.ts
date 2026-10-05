import { readJson, route, withOrganisation } from "@/lib/api/http";
import { ValidationError } from "@/lib/errors";
import { parseReportExport, reportCsv, reportFileName, reportPdf, reportXlsx } from "@/lib/reports/export-files";

const CONTENT_TYPES = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
} as const;

export const POST = route(async (request) => {
  // The report's data comes in the body: up to 5 MB, counted as it's read rather than trusting Content-Length (#133).
  const body = await readJson(request, { maxBytes: 5_000_000 });
  if (body.format !== "csv" && body.format !== "xlsx" && body.format !== "pdf") throw new ValidationError("Choose CSV, Excel (.xlsx) or PDF.");
  const data = parseReportExport(body.data);
  // An analytics pivot (decision 375) is shown to report viewers too; the file is made only from what their page already shows.
  if (data.report === "analytics-pivot" && body.format === "pdf") throw new ValidationError("A pivot table exports to CSV or Excel.");
  await withOrganisation(request, body.organisationId, data.report === "analytics-pivot" ? "report_viewer" : "viewer", async () => undefined);
  const content = body.format === "csv" ? reportCsv(data) : body.format === "xlsx" ? await reportXlsx(data) : await reportPdf(data);
  return new Response(content as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": CONTENT_TYPES[body.format],
      "content-disposition": `attachment; filename="${reportFileName(data, body.format)}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
