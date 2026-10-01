import { route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { getLogo } from "@/lib/organisations/logo";
import { getPayslip } from "@/lib/payroll/payslips";
import { renderPayslipPdf } from "@/lib/pdf/payslip";

type Context = { params: Promise<{ payRunId: string; employeeId: string }> };

/**
 * The payslip as a PDF (PSLIP4), to look at or download (`download=true`).
 * Bookkeeper and payroll access. The data is loaded in the transaction; the
 * PDF is written after it.
 */
export const GET = route<Context>(async (request, context) => {
  const { payRunId, employeeId } = await context.params;
  const params = searchParams(request);
  const loaded = await withPayrollAccess(request, params.get("organisationId"), async (tx) => ({
    payslip: await getPayslip(tx, payRunId, employeeId),
    logo: await getLogo(tx),
  }));
  const pdf = await renderPayslipPdf(loaded.payslip, { logo: loaded.logo });
  const disposition = params.get("download") === "true" ? "attachment" : "inline";
  return new Response(Buffer.from(pdf.bytes), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `${disposition}; filename="${pdf.fileName.replace(/[^\x20-\x7e]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(pdf.fileName)}`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
