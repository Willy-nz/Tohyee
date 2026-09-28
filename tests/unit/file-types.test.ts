import { describe, expect, it } from "vitest";
import { checkAttachment, cleanFileName, fileTypeLabel, formatFileSize, showsInline } from "@/lib/records/file-types";

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? [...Buffer.from(part, "latin1")] : part)));

const PDF = bytes("%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n");
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13], "IHDR....");
const JPG = bytes([0xff, 0xd8, 0xff, 0xe0], "JFIF");
const HEIC = bytes([0, 0, 0, 0x18], "ftypheic", [0, 0, 0, 0], "mif1heic");
const DOCX = bytes([0x50, 0x4b, 0x03, 0x04], "....[Content_Types].xml....word/document.xml");
const XLSX = bytes([0x50, 0x4b, 0x03, 0x04], "....[Content_Types].xml....xl/workbook.xml");
const OLE = bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], "....");
const CSV = bytes("Date,Amount\n2026-04-01,115.00\n");

/** docs/ACCOUNTING-EXAMPLES.md, "Notes, files and history": NF7, NF8 file checks. */
describe("attachment file checks", () => {
  it("NF7: accepts each allowed type when its contents match", () => {
    expect(checkAttachment("receipt.pdf", PDF)).toEqual({ fileName: "receipt.pdf", contentType: "application/pdf" });
    expect(checkAttachment("photo.PNG", PNG).contentType).toBe("image/png");
    expect(checkAttachment("photo.jpeg", JPG).contentType).toBe("image/jpeg");
    expect(checkAttachment("photo.jpg", JPG).contentType).toBe("image/jpeg");
    expect(checkAttachment("IMG_0001.HEIC", HEIC).contentType).toBe("image/heic");
    expect(checkAttachment("letter.docx", DOCX).contentType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(checkAttachment("budget.xlsx", XLSX).contentType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(checkAttachment("old.doc", OLE).contentType).toBe("application/msword");
    expect(checkAttachment("old.xls", OLE).contentType).toBe("application/vnd.ms-excel");
    expect(checkAttachment("statement.csv", CSV).contentType).toBe("text/csv");
  });

  it("NF8: refuses other types, empty and over-10 MB files, and contents that don't match the name", () => {
    expect(() => checkAttachment("notes.txt", CSV)).toThrow(/only PDF, JPG, PNG, HEIC, Word/);
    expect(() => checkAttachment("setup.exe", bytes("MZ...."))).toThrow(/can't be attached/);
    expect(() => checkAttachment("noextension", PDF)).toThrow(/can't be attached/);
    expect(() => checkAttachment("empty.pdf", new Uint8Array(0))).toThrow("empty.pdf is empty.");
    const big = new Uint8Array(11 * 1024 * 1024);
    big.set(PDF);
    expect(() => checkAttachment("big.pdf", big)).toThrow("big.pdf is 11.0 MB. Files can be at most 10 MB.");
    const exactly = new Uint8Array(10 * 1024 * 1024);
    exactly.set(PDF);
    expect(checkAttachment("ten.pdf", exactly).contentType).toBe("application/pdf");
    expect(() => checkAttachment("photo.png", PDF)).toThrow("photo.png doesn't look like a PNG file, so it can't be attached.");
    expect(() => checkAttachment("letter.docx", XLSX)).toThrow(/doesn't look like a Word file/);
    expect(() => checkAttachment("data.csv", PNG)).toThrow(/doesn't look like a CSV file/);
  });

  it("keeps only the file's own name, without folders or control characters", () => {
    expect(cleanFileName("C:\\Users\\jess\\receipt.pdf")).toBe("receipt.pdf");
    expect(cleanFileName("../../etc/passwd.pdf")).toBe("passwd.pdf");
    expect(cleanFileName("bad\u0000na\u001fme.pdf")).toBe("badname.pdf");
    expect(() => cleanFileName("folder/")).toThrow("The file needs a name.");
    const long = `${"a".repeat(300)}.pdf`;
    expect(cleanFileName(long)).toHaveLength(255);
    expect(cleanFileName(long).endsWith(".pdf")).toBe(true);
  });

  it("labels, sizes and which files open in the browser", () => {
    expect(fileTypeLabel("application/pdf")).toBe("PDF");
    expect(fileTypeLabel("text/csv")).toBe("CSV");
    expect(formatFileSize(900)).toBe("900 bytes");
    expect(formatFileSize(250 * 1024)).toBe("250 KB");
    expect(formatFileSize(1.25 * 1024 * 1024)).toBe("1.3 MB");
    expect(showsInline("application/pdf")).toBe(true);
    expect(showsInline("image/png")).toBe(true);
    expect(showsInline("text/csv")).toBe(false);
    expect(showsInline("image/heic")).toBe(false);
  });
});
