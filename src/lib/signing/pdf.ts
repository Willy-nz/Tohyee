import { createHash } from "node:crypto";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib";
import { ValidationError } from "@/lib/errors";
import { loadFontFiles } from "@/lib/pdf/writer";
import { groupedFingerprint, METHOD_LABELS, type SignatureMethod } from "@/lib/signing/shared";

/*
 * The signed copy (decision 1401): the document's own pages, each with a
 * one-line stamp at the foot, then a signature page with each signature and
 * an audit certificate listing every signer, when and how they signed, how
 * their email was checked, and the fingerprint (SHA-256) of the document
 * they were shown. Built with pdf-lib from the exact bytes that were sent.
 */

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Checks a PDF can be signed: it opens, isn't encrypted and has pages. Returns its page count. */
export async function checkSignablePdf(bytes: Uint8Array): Promise<number> {
  if (bytes.length < 5 || Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") throw new ValidationError("That file isn't a PDF.");
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    if (error instanceof Error && /encrypt/i.test(error.message)) throw new ValidationError("That PDF is password-protected or encrypted. Save a copy without a password, then add it.");
    throw new ValidationError("That PDF couldn't be read. Save it again as a PDF and try again.");
  }
  if (doc.isEncrypted) throw new ValidationError("That PDF is password-protected or encrypted. Save a copy without a password, then add it.");
  let pages: number;
  try {
    pages = doc.getPageCount();
  } catch {
    throw new ValidationError("That PDF couldn't be read. Save it again as a PDF and try again.");
  }
  if (pages < 1) throw new ValidationError("That PDF has no pages.");
  return pages;
}

export type CertificateSigner = {
  position: number;
  name: string;
  email: string;
  roleLabel: string | null;
  signedAt: string;
  method: SignatureMethod;
  typedName: string;
  signaturePng: Uint8Array | null;
  verifiedBy: "email_code" | "tohyee_sign_in";
  verifiedAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  signedSha256: string;
};

export type CertificateInput = {
  requestId: string;
  title: string;
  organisationName: string;
  documentName: string;
  documentSha256: string;
  sentAt: string;
  sentByEmail: string;
  completedAt: string;
  consentText: string;
  signers: CertificateSigner[];
};

const INK = rgb(0.1, 0.12, 0.16);
const MUTED = rgb(0.38, 0.42, 0.48);
const RULE = rgb(0.8, 0.82, 0.86);
const A4: [number, number] = [595.28, 841.89];
const MARGIN = 48;

/** A time as New Zealand time, with the zone, for the certificate. */
export function certificateTime(iso: string): string {
  const time = new Date(iso);
  const text = new Intl.DateTimeFormat("en-NZ", { timeZone: "Pacific/Auckland", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZoneName: "short" }).format(time);
  return `${text} (${time.toISOString().replace(/\.\d{3}Z$/, "Z")})`;
}

const printable = (text: string) => text.replace(/\r\n?/g, " ").replace(/[^\P{Cc}]/gu, "");

class Pages {
  page!: PDFPage;
  y = 0;
  constructor(
    private readonly doc: PDFDocument,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
    private readonly footer: string,
  ) {}

  add() {
    this.page = this.doc.addPage(A4);
    this.y = A4[1] - MARGIN;
    this.page.drawText(printable(this.footer), { x: MARGIN, y: 24, size: 7.5, font: this.regular, color: MUTED });
  }

  ensure(height: number) {
    if (this.y - height < MARGIN + 20) this.add();
  }

  wrap(text: string, width: number, size: number, bold = false): string[] {
    const font = bold ? this.bold : this.regular;
    const lines: string[] = [];
    for (const paragraph of printable(text).split("\n")) {
      let line = "";
      for (const word of paragraph.split(/ +/)) {
        const candidate = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= width) {
          line = candidate;
          continue;
        }
        if (line) lines.push(line);
        let rest = word;
        while (font.widthOfTextAtSize(rest, size) > width && rest.length > 1) {
          let cut = rest.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut -= 1;
          lines.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        line = rest;
      }
      lines.push(line);
    }
    return lines;
  }

  text(text: string, options: { size?: number; bold?: boolean; muted?: boolean; x?: number; width?: number } = {}) {
    const size = options.size ?? 10;
    const x = options.x ?? MARGIN;
    const width = options.width ?? A4[0] - MARGIN - x;
    for (const line of this.wrap(text, width, size, options.bold)) {
      this.ensure(size + 4);
      this.page.drawText(line, { x, y: this.y - size, size, font: options.bold ? this.bold : this.regular, color: options.muted ? MUTED : INK });
      this.y -= size + 4;
    }
  }

  /** A label and value on one row (the value wraps under itself). */
  row(label: string, value: string) {
    const size = 9;
    const lines = this.wrap(value, A4[0] - MARGIN * 2 - 130, size);
    this.ensure(lines.length * (size + 3) + 2);
    this.page.drawText(printable(label), { x: MARGIN, y: this.y - size, size, font: this.bold, color: MUTED });
    for (const line of lines) {
      this.page.drawText(line, { x: MARGIN + 130, y: this.y - size, size, font: this.regular, color: INK });
      this.y -= size + 3;
    }
    this.y -= 2;
  }

  rule() {
    this.ensure(10);
    this.y -= 4;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: A4[0] - MARGIN, y: this.y }, thickness: 0.5, color: RULE });
    this.y -= 8;
  }

  gap(points: number) {
    this.y -= points;
  }
}

/**
 * The signed copy of `original`: its pages stamped, then the signature
 * page and the audit certificate. The original's bytes are checked against
 * the request's fingerprint first.
 */
export async function buildSignedPdf(original: Uint8Array, input: CertificateInput): Promise<Uint8Array> {
  if (sha256Hex(original) !== input.documentSha256) throw new Error("The document doesn't match the request's fingerprint.");
  const doc = await PDFDocument.load(original, { updateMetadata: false });
  doc.registerFontkit(fontkit);
  const files = await loadFontFiles();
  const regular = await doc.embedFont(files.regular, { subset: true });
  const bold = await doc.embedFont(files.bold, { subset: true });
  const stamp = printable(`Signed electronically in Tohyee · request ${input.requestId} · see the signing certificate at the end`);
  for (const page of doc.getPages()) {
    const { width } = page.getSize();
    const size = 6.5;
    const textWidth = regular.widthOfTextAtSize(stamp, size);
    page.drawText(stamp, { x: Math.max(8, (width - textWidth) / 2), y: 8, size, font: regular, color: MUTED });
  }

  const pages = new Pages(doc, regular, bold, `${input.organisationName} · ${input.title} · signing request ${input.requestId}`);
  pages.add();
  pages.text("Signatures", { size: 18, bold: true });
  pages.gap(4);
  pages.text(input.title, { size: 11 });
  pages.gap(10);
  for (const signer of input.signers) {
    pages.ensure(120);
    pages.rule();
    pages.text(`${signer.name}${signer.roleLabel ? `, ${signer.roleLabel}` : ""}`, { size: 11, bold: true });
    pages.gap(4);
    if (signer.method === "drawn" && signer.signaturePng) {
      const image = await doc.embedPng(signer.signaturePng);
      const scale = Math.min(220 / image.width, 70 / image.height, 1);
      const height = image.height * scale;
      pages.ensure(height + 6);
      pages.page.drawImage(image, { x: MARGIN, y: pages.y - height, width: image.width * scale, height });
      pages.y -= height + 6;
    } else {
      pages.ensure(30);
      pages.page.drawText(printable(signer.typedName), { x: MARGIN, y: pages.y - 22, size: 22, font: regular, color: INK });
      pages.y -= 30;
    }
    pages.page.drawLine({ start: { x: MARGIN, y: pages.y }, end: { x: MARGIN + 240, y: pages.y }, thickness: 0.5, color: INK });
    pages.gap(4);
    pages.text(`${METHOD_LABELS[signer.method]}: "${signer.typedName}". Signed ${certificateTime(signer.signedAt)}.`, { size: 8.5, muted: true });
  }

  pages.add();
  pages.text("Signing certificate", { size: 18, bold: true });
  pages.gap(8);
  pages.row("Document", input.documentName);
  pages.row("Title", input.title);
  pages.row("Organisation", input.organisationName);
  pages.row("Signing request", input.requestId);
  pages.row("Fingerprint (SHA-256)", groupedFingerprint(input.documentSha256));
  pages.row("Sent", `${certificateTime(input.sentAt)} by ${input.sentByEmail}`);
  pages.row("Completed", certificateTime(input.completedAt));
  pages.row("Consent", `Each signer ticked: "${input.consentText}".`);
  for (const signer of input.signers) {
    pages.rule();
    pages.text(`Signer ${signer.position}: ${signer.name}`, { size: 11, bold: true });
    pages.gap(2);
    pages.row("Email", signer.email);
    if (signer.roleLabel) pages.row("Signing as", signer.roleLabel);
    pages.row("Identity check", signer.verifiedBy === "email_code" ? `Code sent to ${signer.email}, entered ${certificateTime(signer.verifiedAt)}` : `Signed in to Tohyee as ${signer.email}`);
    pages.row("Signed", certificateTime(signer.signedAt));
    pages.row("Method", `${METHOD_LABELS[signer.method]} ("${signer.typedName}")`);
    pages.row("Document signed", signer.signedSha256 === input.documentSha256 ? "The fingerprint above" : groupedFingerprint(signer.signedSha256));
    pages.row("IP address", signer.ipAddress ?? "Not known");
    pages.row("Browser", signer.userAgent ?? "Not known");
  }
  pages.rule();
  pages.text(
    "To check a copy: open the signing request in Tohyee and use Check a copy. Tohyee works out the copy's SHA-256 and compares it with the signed copy it kept. The fingerprint above is of the document as it was sent, before these pages were added. Tohyee doesn't do witnessed signing.",
    { size: 8.5, muted: true },
  );
  doc.setTitle(`${input.title} (signed)`);
  doc.setProducer("Tohyee (pdf-lib)");
  doc.setModificationDate(new Date(input.completedAt));
  return doc.save();
}
