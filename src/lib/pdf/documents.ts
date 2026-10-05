import type { PrintedDocument } from "@/lib/documents/print";
import { formatRate, formatUnitPrice } from "@/lib/documents/format";
import type { PrintKind } from "@/lib/documents/tax-invoice";
import { formatDate, formatGstNumber, formatMoney, formatQuantity } from "@/lib/format";
import { CONTENT_WIDTH, type Column, type PdfImage, PdfWriter, type TableFooterRow } from "@/lib/pdf/writer";
import type { AgedAmounts } from "@/lib/reports/ageing";
import type { ActivityStatement, OutstandingStatement } from "@/lib/reports/customer-statements";

/**
 * PDFs of the printed invoice, credit note, quote and purchase order
 * (examples PD1-PD8, PO8) and customer statements (CST1-CST5), written on the
 * server for emailing. They lay out the same objects the print pages show
 * (`printedDocument`, `activityStatement`, `outstandingStatement`) with the
 * same formatting functions, so every figure comes from the same code as the
 * page; nothing is worked out again here.
 */

const NUMBER_LABELS: Record<PrintKind, string> = {
  invoice: "Invoice number",
  credit_note: "Credit note number",
  quote: "Quote number",
  purchase_order: "Order number",
};

const FILE_NOUNS: Record<PrintKind, string> = {
  invoice: "Invoice",
  credit_note: "Credit note",
  quote: "Quote",
  purchase_order: "Purchase order",
};

/** A file name that works on every computer: no path or reserved characters. */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${cleaned || "Document"}.pdf`;
}

export function documentFileName(doc: Pick<PrintedDocument, "kind" | "number" | "labels">): string {
  return safeFileName(doc.number ? `${FILE_NOUNS[doc.kind]} ${doc.number}` : doc.labels.title);
}

export function statementFileName(statement: ActivityStatement | OutstandingStatement): string {
  const date = statement.kind === "activity" ? statement.to : statement.asAt;
  return safeFileName(`Statement ${statement.customer.name} ${date}`);
}

/** Two blocks side by side (left and right), moving down past the taller. */
async function sideBySide(
  writer: PdfWriter,
  left: (x: number, width: number) => void | Promise<void>,
  right: (x: number, width: number) => void | Promise<void>,
  gap = 16,
): Promise<void> {
  const half = (CONTENT_WIDTH - gap) / 2;
  const top = writer.y;
  await left(0, half);
  const leftBottom = writer.y;
  writer.y = top;
  await right(half + gap, half);
  writer.y = Math.max(leftBottom, writer.y);
}

/** The logo's box, top left: at most this many points wide and high. */
const LOGO_BOX = { maxWidth: 170, maxHeight: 56 };

/** The organisation's logo top left (when it has one), then the title under it. */
async function logoAndTitle(writer: PdfWriter, logo: PdfImage | null | undefined, title: string, x: number, width: number): Promise<void> {
  if (logo) {
    await writer.image(logo, { x, ...LOGO_BOX, maxWidth: Math.min(LOGO_BOX.maxWidth, width) });
    writer.space(10);
  }
  writer.text(title, { x, width, bold: true, size: 20, gap: 4 });
}

/** "Label   value" rows, labels muted, in a box at x. */
function details(writer: PdfWriter, rows: Array<[string, string]>, x: number, width: number): void {
  const labelWidth = Math.min(110, width * 0.45);
  for (const [label, value] of rows) {
    const top = writer.y;
    writer.text(label, { x, width: labelWidth, muted: true });
    const labelBottom = writer.y;
    writer.y = top;
    writer.text(value, { x: x + labelWidth, width: width - labelWidth });
    writer.y = Math.max(labelBottom, writer.y) + 1;
  }
}

function nameAndAddress(writer: PdfWriter, name: string, address: string | null, x: number, width: number): void {
  writer.text(name, { x, width, bold: true, size: 10.5 });
  if (address) writer.text(address, { x, width });
}

export async function renderDocumentPdf(doc: PrintedDocument, options: { logo?: PdfImage | null } = {}): Promise<{ fileName: string; bytes: Uint8Array }> {
  const { labels } = doc;
  const heading = `${labels.title}${doc.number ? ` ${doc.number}` : ""}`;
  const writer = await PdfWriter.create({ title: heading, author: doc.organisation.name, footer: `${doc.organisation.name} · ${heading}` });
  const hasTax = doc.amountsMode !== "no_tax";

  await sideBySide(
    writer,
    (x, width) => logoAndTitle(writer, options.logo, labels.title, x, width),
    (x, width) => {
      writer.text(doc.organisation.name, { x, width, bold: true, size: 10.5, align: "right" });
      if (doc.organisation.postalAddress) writer.text(doc.organisation.postalAddress, { x, width, align: "right" });
    },
  );
  writer.space(14);

  const rows: Array<[string, string]> = [];
  if (doc.number) rows.push([NUMBER_LABELS[doc.kind], doc.number]);
  rows.push([doc.kind === "quote" ? "Quote date" : doc.kind === "purchase_order" ? "Order date" : "Date", formatDate(doc.date)]);
  if (doc.dueDate) rows.push(["Due date", formatDate(doc.dueDate)]);
  if (doc.deliveryDate) rows.push(["Delivery date", formatDate(doc.deliveryDate)]);
  if (doc.expiryDate) rows.push(["Expires", formatDate(doc.expiryDate)]);
  if (doc.reference) rows.push(["Reference", doc.reference]);
  if (doc.organisation.gstNumber) rows.push(["GST number", formatGstNumber(doc.organisation.gstNumber)]);
  await sideBySide(
    writer,
    (x, width) => nameAndAddress(writer, doc.customer.name, doc.customer.billingAddress, x, width),
    (x, width) => details(writer, rows, x, width),
  );
  writer.space(18);

  const amountHeader = `Amount${doc.amountsMode === "inclusive" ? " (incl. GST)" : doc.amountsMode === "exclusive" ? " (excl. GST)" : ""} (${doc.currencyCode})`;
  const columns: Column[] = [
    { header: "Description", width: hasTax ? 44 : 50 },
    { header: "Quantity", width: 13, align: "right" },
    { header: "Unit price", width: 14, align: "right" },
    ...(hasTax ? [{ header: "GST", width: 9, align: "right" as const }] : []),
    { header: amountHeader, width: 20, align: "right" },
  ];
  const lineRows = doc.lines.map((line) => [
    line.description,
    `${formatQuantity(line.quantity)}${line.unitName ? ` ${line.unitName}` : ""}`,
    formatUnitPrice(line.unitPrice),
    ...(hasTax ? [formatRate(line.taxRate)] : []),
    formatMoney(line.lineAmount),
  ]);
  const footRow = (label: string, value: string, bold = false): TableFooterRow => ({ label, values: [value], bold });
  const footer: TableFooterRow[] = [];
  if (labels.gstLine) {
    footer.push(footRow("Subtotal", formatMoney(doc.subtotal)));
    footer.push(footRow("Total GST", formatMoney(doc.taxTotal)));
  }
  footer.push(footRow(`Total ${doc.currencyCode}`, formatMoney(doc.total), true));
  if (doc.amountDue !== null && doc.amountPaid !== null) {
    footer.push(footRow("Paid or credited", formatMoney(doc.amountPaid)));
    footer.push(footRow(`Amount due ${doc.currencyCode}`, formatMoney(doc.amountDue), true));
  }
  writer.table(columns, lineRows, { footer });
  writer.space(12);

  if (labels.includesGstStatement) writer.text(`Total includes GST of $${formatMoney(doc.taxTotal)}.`, { gap: 8 });
  if (doc.deliveryAddress || doc.deliveryInstructions) {
    const text = [doc.deliveryAddress, doc.deliveryInstructions].filter(Boolean).join("\n");
    writer.ensure(writer.measure(text, CONTENT_WIDTH) + 16);
    writer.text("Deliver to", { bold: true });
    writer.text(text, { gap: 10 });
  }
  if (doc.terms) writer.text(doc.terms, { gap: 10 });
  if (doc.paymentDetails) {
    const text = `${doc.dueDate ? `Due ${formatDate(doc.dueDate)}. ` : ""}${doc.paymentDetails}`;
    writer.ensure(writer.measure(text, CONTENT_WIDTH) + 16);
    writer.text("How to pay", { bold: true });
    writer.text(text, { gap: 10 });
  }
  if (doc.payNowUrl) {
    const text = `Pay online by card: ${doc.payNowUrl}`;
    writer.ensure(writer.measure(text, CONTENT_WIDTH) + 16);
    writer.text("Pay now", { bold: true });
    writer.text(text, { gap: 10 });
  }
  return { fileName: documentFileName(doc), bytes: await writer.finish() };
}

// ---------------------------------------------------------------- statements

const BUCKETS: Array<[keyof AgedAmounts, string]> = [
  ["current", "Current"],
  ["days1to30", "1-30 days"],
  ["days31to60", "31-60 days"],
  ["days61to90", "61-90 days"],
  ["over90", "Over 90 days"],
];

/** A balance with "Cr" for money the organisation owes the customer, as on the page. */
function balance(value: string): string {
  return value.startsWith("-") ? `${formatMoney(value.slice(1))} Cr` : formatMoney(value);
}

function blankZero(value: string): string {
  return /^-?0*(\.0*)?$/.test(value) ? "" : formatMoney(value);
}

function ageingTable(writer: PdfWriter, ageing: AgedAmounts, currencyCode: string): void {
  writer.space(12);
  writer.table(
    [...BUCKETS.map(([, label]) => ({ header: label, width: 1, align: "right" as const })), { header: "Credit", width: 1, align: "right" }, { header: `Balance due (${currencyCode})`, width: 1.3, align: "right" }],
    [[...BUCKETS.map(([bucket]) => formatMoney(ageing[bucket])), ageing.credit === "0.00" ? formatMoney("0.00") : formatMoney(`-${ageing.credit}`), formatMoney(ageing.total)]],
  );
}

export async function renderStatementPdf(
  statement: ActivityStatement | OutstandingStatement,
  organisation: { name: string; postalAddress: string | null },
  options: { logo?: PdfImage | null } = {},
): Promise<{ fileName: string; bytes: Uint8Array }> {
  const title = statement.kind === "activity" ? "Activity statement" : "Statement";
  const period =
    statement.kind === "activity" ? `${formatDate(statement.from)} to ${formatDate(statement.to)}` : `Outstanding as at ${formatDate(statement.asAt)}`;
  const writer = await PdfWriter.create({ title: `${title} for ${statement.customer.name}`, author: organisation.name, footer: `${organisation.name} · ${title}` });
  await sideBySide(
    writer,
    async (x, width) => {
      await logoAndTitle(writer, options.logo, title, x, width);
      writer.text(period, { x, width, muted: true });
    },
    (x, width) => {
      writer.text(organisation.name, { x, width, bold: true, size: 10.5, align: "right" });
      if (organisation.postalAddress) writer.text(organisation.postalAddress, { x, width, align: "right" });
    },
  );
  writer.space(14);
  nameAndAddress(writer, statement.customer.name, statement.customer.billingAddress, 0, CONTENT_WIDTH / 2);
  if (statement.includeSubCustomers && statement.customers.length > 1) {
    writer.text(`Includes ${statement.customers.slice(1).map((customer) => customer.name).join(", ")}`, { muted: true });
  }
  writer.space(16);
  const showCustomer = statement.customers.length > 1;

  if (statement.kind === "activity") {
    const columns: Column[] = [
      { header: "Date", width: 12 },
      { header: "Activity", width: showCustomer ? 24 : 32 },
      ...(showCustomer ? [{ header: "Customer", width: 16 }] : []),
      { header: "Reference", width: showCustomer ? 12 : 16 },
      { header: "Amount", width: 13, align: "right" as const },
      { header: "Payments and credit", width: 13, align: "right" as const },
      { header: "Balance", width: 14, align: "right" as const },
    ];
    const opening = [formatDate(statement.from), "Opening balance", ...(showCustomer ? [""] : []), "", "", "", balance(statement.opening)];
    const rows = statement.lines.map((line) => [
      formatDate(line.date),
      line.description,
      ...(showCustomer ? [line.contactName] : []),
      line.reference ?? "",
      blankZero(line.amount),
      blankZero(line.payment),
      balance(line.balance),
    ]);
    writer.table(columns, [opening, ...rows], {
      footer: [
        {
          label: `Closing balance (${statement.currencyCode})`,
          values: [formatMoney(statement.totalAmount), formatMoney(statement.totalPayment), balance(statement.closing)],
          bold: true,
        },
      ],
    });
  } else if (statement.lines.length === 0) {
    writer.text("Nothing is owed on this date.", { muted: true, gap: 6 });
  } else {
    const columns: Column[] = [
      { header: "Date", width: 13 },
      { header: "Document", width: showCustomer ? 20 : 26 },
      ...(showCustomer ? [{ header: "Customer", width: 16 }] : []),
      { header: "Due", width: showCustomer ? 21 : 27 },
      { header: "Total", width: 15, align: "right" as const },
      { header: "Outstanding", width: 15, align: "right" as const },
    ];
    const rows = statement.lines.map((line) => [
      formatDate(line.date),
      line.type === "credit_note" ? `Credit note ${line.number}` : line.type === "invoice" ? `Invoice ${line.number}` : line.number,
      ...(showCustomer ? [line.contactName] : []),
      `${line.dueDate ? formatDate(line.dueDate) : ""}${line.daysOverdue > 0 ? ` · ${line.daysOverdue} days overdue` : ""}`,
      formatMoney(line.original),
      formatMoney(line.outstanding),
    ]);
    writer.table(columns, rows, {
      footer: [{ label: `Balance due (${statement.currencyCode})`, values: [formatMoney(statement.balance)], bold: true }],
    });
  }
  ageingTable(writer, statement.ageing, statement.currencyCode);
  return { fileName: statementFileName(statement), bytes: await writer.finish() };
}
