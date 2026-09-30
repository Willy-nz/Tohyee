import type { EmailDocumentKind } from "@/lib/email/templates";

/**
 * The HTML part of a document email: a plain, table-based layout that mail
 * clients show consistently. The organisation's logo (an inline `cid:`
 * attachment, never a remote image) and name at the top, the message typed
 * in the email dialog as paragraphs, a box with the document's number,
 * total and due date, and the organisation's contact details at the foot.
 * Every piece of text is escaped; there are no links, scripts, remote
 * images or tracking pixels. The same message goes as plain text too, for
 * mail clients that want it. Templates stay plain text with placeholders.
 */

export type EmailSummaryRow = { label: string; value: string };

export type EmailHtmlInput = {
  subject: string;
  /** The message as typed (plain text; blank lines separate paragraphs). */
  body: string;
  organisation: { name: string; postalAddress: string | null; gstNumber: string | null; email: string | null };
  summary: EmailSummaryRow[];
  /** The logo, as an inline attachment with this Content-ID, shown at this size. */
  logo: { cid: string; width: number; height: number } | null;
};

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** Paragraphs from blank lines, line breaks within them kept. */
export function paragraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => escapeHtml(paragraph).replace(/\n/g, "<br>"));
}

const money = (value: string | null | undefined) => (value ? `$${value}` : null);

/** What the summary box shows for each kind of document, from the template's values. */
export function emailSummary(kind: EmailDocumentKind, values: Record<string, string | null>): EmailSummaryRow[] {
  const rows: Array<[string, string | null | undefined]> = [];
  switch (kind) {
    case "invoice":
      rows.push(["Invoice number", values.number], ["Total", money(values.total)]);
      if (values["amount due"] && values["amount due"] !== values.total) rows.push(["Amount due", money(values["amount due"])]);
      rows.push(["Due date", values["due date"]]);
      break;
    case "credit_note":
      rows.push(["Credit note number", values.number], ["Total", money(values.total)]);
      break;
    case "quote":
      rows.push(["Quote number", values.number], ["Total", money(values.total)], ["Expires", values["expiry date"]]);
      break;
    case "purchase_order":
      rows.push(["Order number", values.number], ["Total", money(values.total)], ["Delivery date", values["delivery date"]]);
      break;
    case "statement":
      rows.push(["Statement date", values["statement date"]], ["Balance owing", money(values.balance)]);
      break;
  }
  return rows.filter((row): row is [string, string] => Boolean(row[1])).map(([label, value]) => ({ label, value }));
}

const FONT = "font-family:Arial,Helvetica,sans-serif;";
const INK = "#1a1f29";
const MUTED = "#5f6b7a";
const LINE = "#d6dae0";
const SHADE = "#f3f5f7";

export function renderEmailHtml(input: EmailHtmlInput): string {
  const { organisation, logo } = input;
  const name = escapeHtml(organisation.name);
  const header = logo
    ? `<img src="cid:${escapeHtml(logo.cid)}" width="${logo.width}" height="${logo.height}" alt="${name}" style="display:block;border:0;outline:none;max-width:100%;height:auto;">
          <div style="${FONT}font-size:15px;font-weight:bold;color:${INK};margin-top:10px;">${name}</div>`
    : `<div style="${FONT}font-size:20px;font-weight:bold;color:${INK};">${name}</div>`;
  const message = paragraphs(input.body)
    .map((paragraph) => `<p style="${FONT}font-size:15px;line-height:1.5;color:${INK};margin:0 0 14px;">${paragraph}</p>`)
    .join("\n          ");
  const summary =
    input.summary.length === 0
      ? ""
      : `<tr>
        <td style="padding:4px 32px 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${SHADE};border:1px solid ${LINE};border-radius:6px;">
            ${input.summary
              .map(
                (row, index) => `<tr>
              <td style="${FONT}font-size:14px;color:${MUTED};padding:${index === 0 ? 14 : 6}px 16px ${index === input.summary.length - 1 ? 14 : 6}px;">${escapeHtml(row.label)}</td>
              <td align="right" style="${FONT}font-size:14px;font-weight:bold;color:${INK};padding:${index === 0 ? 14 : 6}px 16px ${index === input.summary.length - 1 ? 14 : 6}px;">${escapeHtml(row.value)}</td>
            </tr>`,
              )
              .join("\n            ")}
          </table>
        </td>
      </tr>`;
  const contact = [
    `<strong>${name}</strong>`,
    ...(organisation.postalAddress ? [escapeHtml(organisation.postalAddress).replace(/\r?\n/g, "<br>")] : []),
    ...(organisation.email ? [escapeHtml(organisation.email)] : []),
    ...(organisation.gstNumber ? [`GST number ${escapeHtml(organisation.gstNumber)}`] : []),
  ].join("<br>");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#eef0f3;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef0f3;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid ${LINE};border-radius:8px;">
          <tr>
            <td style="padding:28px 32px 20px;border-bottom:1px solid ${LINE};">
          ${header}
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 8px;">
          ${message}
            </td>
          </tr>
          ${summary}
          <tr>
            <td style="padding:18px 32px 24px;border-top:1px solid ${LINE};${FONT}font-size:12px;line-height:1.5;color:${MUTED};">
              ${contact}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}
