import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib";

/**
 * A small page writer over pdf-lib (MIT) for Tohyee's PDFs: A4 pages, text
 * that wraps, tables whose header repeats on each page, and page numbers.
 * Pure JavaScript, so it works on the Windows install (Node and PostgreSQL
 * only, no browser). Text is set in Liberation Sans (SIL OFL 1.1, the files
 * in ./fonts, unmodified), embedded as a subset, so macrons (Ōtepoti) print.
 *
 * The fonts are read from `src/lib/pdf/fonts` under the app's folder
 * (`next.config.ts` copies them into the standalone build).
 */

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
export const MARGIN = 48;
const FOOTER = 28;
export const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const INK = rgb(0.1, 0.12, 0.16);
const MUTED = rgb(0.38, 0.42, 0.48);
const RULE = rgb(0.8, 0.82, 0.86);
const SHADE = rgb(0.95, 0.96, 0.97);

let fontFiles: Promise<{ regular: Uint8Array; bold: Uint8Array }> | null = null;

function fontsFolder(): string {
  return process.env.TOHYEE_PDF_FONTS_DIR?.trim() || path.join(process.cwd(), "src", "lib", "pdf", "fonts");
}

async function loadFontFiles(): Promise<{ regular: Uint8Array; bold: Uint8Array }> {
  fontFiles ??= Promise.all([
    readFile(path.join(fontsFolder(), "LiberationSans-Regular.ttf")),
    readFile(path.join(fontsFolder(), "LiberationSans-Bold.ttf")),
  ]).then(
    ([regular, bold]) => ({ regular: new Uint8Array(regular), bold: new Uint8Array(bold) }),
    (error) => {
      fontFiles = null;
      throw error;
    },
  );
  return fontFiles;
}

export type Align = "left" | "right";

export type Column = {
  header: string;
  /** Share of the table's width (the widths are scaled to fit). */
  width: number;
  align?: Align;
};

export type TableFooterRow = { label: string; values: string[]; bold?: boolean };

export type TextOptions ={ size?: number; bold?: boolean; muted?: boolean; align?: Align; width?: number; x?: number };

export class PdfWriter {
  private constructor(
    readonly doc: PDFDocument,
    private readonly regular: PDFFont,
    private readonly bold: PDFFont,
    private readonly footerText: string,
  ) {}

  page!: PDFPage;
  /** Distance down from the top margin of the current page. */
  y = 0;
  private pages: PDFPage[] = [];

  static async create(meta: { title: string; author: string; footer: string }): Promise<PdfWriter> {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const files = await loadFontFiles();
    const regular = await doc.embedFont(files.regular, { subset: true });
    const bold = await doc.embedFont(files.bold, { subset: true });
    doc.setTitle(meta.title);
    doc.setAuthor(meta.author);
    doc.setCreator("Tohyee");
    doc.setProducer("Tohyee (pdf-lib)");
    const writer = new PdfWriter(doc, regular, bold, meta.footer);
    writer.newPage();
    return writer;
  }

  newPage(): void {
    this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.pages.push(this.page);
    this.y = 0;
  }

  /** Room left on this page, above the footer. */
  get room(): number {
    return PAGE_HEIGHT - MARGIN * 2 - FOOTER - this.y;
  }

  /** Starts a new page unless `height` fits. */
  ensure(height: number): boolean {
    if (height <= this.room) return false;
    this.newPage();
    return true;
  }

  font(bold = false): PDFFont {
    return bold ? this.bold : this.regular;
  }

  widthOf(text: string, size: number, bold = false): number {
    return this.font(bold).widthOfTextAtSize(clean(text), size);
  }

  /** Splits text into lines that fit `width`, keeping its own line breaks. Long words are broken. */
  wrap(text: string, width: number, size: number, bold = false): string[] {
    const lines: string[] = [];
    for (const paragraph of clean(text, true).split("\n")) {
      let line = "";
      for (const word of paragraph.split(/ +/)) {
        const candidate = line ? `${line} ${word}` : word;
        if (this.widthOf(candidate, size, bold) <= width) {
          line = candidate;
          continue;
        }
        if (line) lines.push(line);
        line = "";
        let rest = word;
        while (this.widthOf(rest, size, bold) > width && rest.length > 1) {
          let cut = rest.length - 1;
          while (cut > 1 && this.widthOf(rest.slice(0, cut), size, bold) > width) cut -= 1;
          lines.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        line = rest;
      }
      lines.push(line);
    }
    return lines;
  }

  /** Draws one line of text at the current position (x from the left margin), without moving down. */
  drawLine(text: string, options: TextOptions = {}): void {
    const size = options.size ?? 10;
    const font = this.font(options.bold);
    const value = clean(text);
    const boxX = MARGIN + (options.x ?? 0);
    const boxWidth = options.width ?? CONTENT_WIDTH - (options.x ?? 0);
    const x = options.align === "right" ? boxX + boxWidth - font.widthOfTextAtSize(value, size) : boxX;
    this.page.drawText(value, {
      x,
      y: PAGE_HEIGHT - MARGIN - this.y - size,
      size,
      font,
      color: options.muted ? MUTED : INK,
    });
  }

  /** Writes wrapped text in a box and moves down past it. Returns the height used. */
  text(text: string, options: TextOptions & { gap?: number } = {}): number {
    const size = options.size ?? 10;
    const lineHeight = size * 1.3;
    const width = options.width ?? CONTENT_WIDTH - (options.x ?? 0);
    const lines = this.wrap(text, width, size, options.bold);
    for (const line of lines) {
      this.ensure(lineHeight);
      this.drawLine(line, { ...options, width });
      this.y += lineHeight;
    }
    this.y += options.gap ?? 0;
    return lines.length * lineHeight + (options.gap ?? 0);
  }

  /** Height of wrapped text, without drawing it. */
  measure(text: string, width: number, size = 10, bold = false): number {
    return this.wrap(text, width, size, bold).length * size * 1.3;
  }

  rule(options: { x?: number; width?: number; thick?: boolean } = {}): void {
    const y = PAGE_HEIGHT - MARGIN - this.y;
    const x = MARGIN + (options.x ?? 0);
    this.page.drawLine({
      start: { x, y },
      end: { x: x + (options.width ?? CONTENT_WIDTH - (options.x ?? 0)), y },
      thickness: options.thick ? 1 : 0.5,
      color: options.thick ? INK : RULE,
    });
  }

  space(points: number): void {
    this.y += points;
  }

  /**
   * A table: header row (repeated on each new page), one row per `rows`
   * entry (cells wrap), and `footer` rows under a line: a label across the
   * first columns and `values` in the last ones (bold where asked).
   */
  table(
    columns: Column[],
    rows: string[][],
    options: { size?: number; footer?: TableFooterRow[]; x?: number; width?: number } = {},
  ): void {
    const size = options.size ?? 9;
    const lineHeight = size * 1.3;
    const pad = 4;
    const x0 = options.x ?? 0;
    const tableWidth = options.width ?? CONTENT_WIDTH - x0;
    const total = columns.reduce((sum, column) => sum + column.width, 0);
    const widths = columns.map((column) => (column.width / total) * tableWidth);
    const lefts = widths.map((_, index) => x0 + widths.slice(0, index).reduce((sum, width) => sum + width, 0));

    type Cell = { lines: string[]; x: number; width: number; align?: Align };
    const cellsOf = (values: string[], bold: boolean): Cell[] =>
      values.map((value, index) => ({
        lines: this.wrap(value ?? "", widths[index] - pad * 2, size, bold),
        x: lefts[index],
        width: widths[index],
        align: columns[index].align,
      }));
    const rowHeight = (cells: Cell[]) => Math.max(1, ...cells.map((cell) => cell.lines.length)) * lineHeight + pad * 2;

    const drawRow = (cells: Cell[], bold: boolean, shade: boolean) => {
      const height = rowHeight(cells);
      if (shade) {
        this.page.drawRectangle({ x: MARGIN + x0, y: PAGE_HEIGHT - MARGIN - this.y - height, width: tableWidth, height, color: SHADE });
      }
      const top = this.y;
      for (const cell of cells) {
        cell.lines.forEach((line, lineIndex) => {
          this.y = top + pad + lineIndex * lineHeight;
          this.drawLine(line, { size, bold, x: cell.x + pad, width: cell.width - pad * 2, align: cell.align });
        });
      }
      this.y = top + height;
    };

    const header = cellsOf(
      columns.map((column) => column.header),
      true,
    );
    const drawHeader = () => {
      drawRow(header, true, true);
      this.rule({ x: x0, width: tableWidth });
    };
    this.ensure(rowHeight(header) + lineHeight * 2);
    drawHeader();
    for (const row of rows) {
      const cells = cellsOf(row, false);
      if (this.ensure(rowHeight(cells))) drawHeader();
      drawRow(cells, false, false);
      this.rule({ x: x0, width: tableWidth });
    }
    for (const [index, row] of (options.footer ?? []).entries()) {
      const bold = row.bold ?? false;
      const first = columns.length - row.values.length;
      const labelWidth = lefts[first] - x0;
      const cells: Cell[] = [
        { lines: this.wrap(row.label, labelWidth - pad * 2, size, bold), x: x0, width: labelWidth },
        ...row.values.map((value, offset) => {
          const column = first + offset;
          return { lines: this.wrap(value, widths[column] - pad * 2, size, bold), x: lefts[column], width: widths[column], align: columns[column].align };
        }),
      ];
      if (this.ensure(rowHeight(cells))) drawHeader();
      if (index === 0) this.rule({ x: x0, width: tableWidth, thick: true });
      drawRow(cells, bold, false);
    }
  }

  /** Adds "Page n of m" to every page and returns the file. */
  async finish(): Promise<Uint8Array> {
    const count = this.pages.length;
    this.pages.forEach((page, index) => {
      const size = 8;
      const label = `${this.footerText}${this.footerText ? " · " : ""}Page ${index + 1} of ${count}`;
      const width = this.regular.widthOfTextAtSize(label, size);
      page.drawText(label, { x: PAGE_WIDTH - MARGIN - width, y: MARGIN - 12, size, font: this.regular, color: MUTED });
    });
    return this.doc.save();
  }
}

/** Tabs and (unless kept) line breaks become spaces; other control characters are dropped. */
function clean(text: string, keepNewlines = false): string {
  const normalised = text.replace(/\r\n?/g, "\n").replace(/\t/g, " ");
  const lines = keepNewlines ? normalised : normalised.replace(/\n/g, " ");
  return lines.replace(/[^\P{Cc}\n]/gu, "");
}
