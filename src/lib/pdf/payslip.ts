import { payslipLayout } from "@/lib/payroll/payslip-layout";
import type { Payslip } from "@/lib/payroll/payslips";
import { CONTENT_WIDTH, type PdfImage, PdfWriter } from "@/lib/pdf/writer";

/**
 * A payslip as a PDF (examples PSLIP1-PSLIP5), from `payslipLayout`, the
 * same rows the payslip page shows, so nothing is worked out again here.
 */

function labelValueTable(writer: PdfWriter, heading: string, rows: Array<[string, string]>, footer?: [string, string]): void {
  writer.table(
    [
      { header: heading, width: 3 },
      { header: "Amount", width: 1, align: "right" },
    ],
    rows.map(([label, value]) => [label, value]),
    { footer: footer ? [{ label: footer[0], values: [footer[1]], bold: true }] : undefined },
  );
  writer.space(12);
}

export async function renderPayslipPdf(payslip: Payslip, options: { logo?: PdfImage | null } = {}): Promise<{ fileName: string; bytes: Uint8Array }> {
  const layout = payslipLayout(payslip);
  const writer = await PdfWriter.create({
    title: `Payslip ${payslip.employee.name} ${payslip.payDate}`,
    author: payslip.employer.name,
    footer: `${payslip.employer.name} · Payslip`,
  });
  const top = writer.y;
  const half = (CONTENT_WIDTH - 16) / 2;
  if (options.logo) {
    await writer.image(options.logo, { maxWidth: Math.min(170, half), maxHeight: 56 });
    writer.space(10);
  }
  writer.text(layout.title, { width: half, bold: true, size: 20, gap: 4 });
  const leftBottom = writer.y;
  writer.y = top;
  writer.text(payslip.employer.name, { x: half + 16, width: half, bold: true, size: 10.5, align: "right" });
  if (payslip.employer.postalAddress) writer.text(payslip.employer.postalAddress, { x: half + 16, width: half, align: "right" });
  writer.y = Math.max(leftBottom, writer.y) + 14;

  for (const [label, value] of layout.details) {
    const rowTop = writer.y;
    writer.text(label, { width: 110, muted: true });
    const labelBottom = writer.y;
    writer.y = rowTop;
    writer.text(value, { x: 110, width: CONTENT_WIDTH - 110 });
    writer.y = Math.max(labelBottom, writer.y) + 1;
  }
  writer.space(16);

  writer.table(
    [
      { header: "Earnings", width: 46 },
      { header: "Hours", width: 16, align: "right" },
      { header: "Rate", width: 16, align: "right" },
      { header: "Amount", width: 22, align: "right" },
    ],
    layout.earnings.map((row) => [row.label, row.hours, row.rate, row.amount]),
    { footer: [{ label: layout.gross.label, values: [layout.gross.hours, layout.gross.rate, layout.gross.amount], bold: true }] },
  );
  writer.space(12);
  labelValueTable(writer, "Deductions", layout.deductions, ["Net pay", layout.netPay]);
  if (layout.employer.length > 0) labelValueTable(writer, "Paid by your employer", layout.employer);
  labelValueTable(writer, layout.yearToDateHeading, layout.yearToDate);
  for (const note of layout.notes) writer.text(note, { muted: true, size: 9 });
  return { fileName: payslip.fileName, bytes: await writer.finish() };
}
