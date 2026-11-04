import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { buildSignedPdf, checkSignablePdf, sha256Hex } from "@/lib/signing/pdf";
import { hashToken, newToken, parseSignature } from "@/lib/signing/service";
import { allSigned, groupedFingerprint, maskEmail, requestState, signersToAsk, TOKEN_PATTERN } from "@/lib/signing/shared";

/** E-signatures' pure rules (decisions 1396-1410). Made-up names only. */

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function pdf(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let page = 0; page < pages; page += 1) doc.addPage([595, 842]).drawText(`Page ${page + 1}`, { x: 50, y: 780 });
  return doc.save();
}

describe("tokens", () => {
  it("are long and random, and only their hash is kept", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(token).toMatch(TOKEN_PATTERN);
    const token = newToken();
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken(token)).toBe(hashToken(token));
  });
});

describe("request state and who's asked", () => {
  it("shows an open request past its expiry as expired, and never a finished one", () => {
    const now = new Date("2026-07-20T00:00:00Z");
    expect(requestState("sent", "2026-07-21T00:00:00Z", now)).toBe("sent");
    expect(requestState("sent", "2026-07-20T00:00:00Z", now)).toBe("expired");
    expect(requestState("completed", "2026-07-01T00:00:00Z", now)).toBe("completed");
    expect(requestState("voided", "2026-07-01T00:00:00Z", now)).toBe("voided");
  });

  it("asks one at a time in order, everyone at once in any order, and nobody after a decline", () => {
    const signers = [
      { position: 2, status: "waiting" as const },
      { position: 1, status: "signed" as const },
      { position: 3, status: "waiting" as const },
    ];
    expect(signersToAsk("in_order", signers)).toEqual([2]);
    expect(signersToAsk("any_order", signers)).toEqual([2, 3]);
    expect(signersToAsk("in_order", [...signers, { position: 4, status: "declined" as const }])).toEqual([]);
    expect(signersToAsk("in_order", [{ position: 1, status: "signed" as const }])).toEqual([]);
    expect(allSigned([{ status: "signed" }, { status: "signed" }])).toBe(true);
    expect(allSigned([{ status: "signed" }, { status: "ready" }])).toBe(false);
    expect(allSigned([])).toBe(false);
  });

  it("hides most of an email until the signer has proved it's theirs", () => {
    expect(maskEmail("aroha@kobe-cafe.test")).toBe("a***@kobe-cafe.test");
    expect(maskEmail("nope")).toBe("***");
    expect(groupedFingerprint("a".repeat(64)).split(" ")).toHaveLength(8);
  });
});

describe("what a signer sends", () => {
  const sha = "b".repeat(64);
  it("needs consent, the fingerprint they were shown and a name", () => {
    expect(() => parseSignature({ method: "typed", typedName: "Aroha", consent: false, documentSha256: sha }, sha)).toThrow("I agree to sign electronically");
    expect(() => parseSignature({ method: "typed", typedName: "Aroha", consent: true, documentSha256: "c".repeat(64) }, sha)).toThrow("isn't the one on this request");
    expect(() => parseSignature({ method: "typed", typedName: " ", consent: true, documentSha256: sha }, sha)).toThrow();
    expect(() => parseSignature({ method: "stamp", typedName: "Aroha", consent: true, documentSha256: sha }, sha)).toThrow();
    expect(parseSignature({ method: "typed", typedName: "Aroha Ngata", consent: true, documentSha256: sha.toUpperCase() }, sha)).toEqual({ method: "typed", typedName: "Aroha Ngata", png: null });
  });

  it("takes a drawn signature only as a small PNG", () => {
    expect(() => parseSignature({ method: "drawn", typedName: "Aroha", consent: true, documentSha256: sha }, sha)).toThrow("Draw your signature");
    expect(() => parseSignature({ method: "drawn", typedName: "Aroha", signaturePng: Buffer.from("not a png at all, just some text that is long enough to pass the size check ok").toString("base64"), consent: true, documentSha256: sha }, sha)).toThrow("couldn't be read");
    expect(() => parseSignature({ method: "drawn", typedName: "Aroha", signaturePng: `data:image/png;base64,${Buffer.alloc(300_000, 1).toString("base64")}`, consent: true, documentSha256: sha }, sha)).toThrow();
    const drawn = parseSignature({ method: "drawn", typedName: "Aroha", signaturePng: `data:image/png;base64,${PNG}`, consent: true, documentSha256: sha }, sha);
    expect([drawn.method, drawn.png?.subarray(1, 4).toString("latin1")]).toEqual(["drawn", "PNG"]);
  });
});

describe("the signed copy", () => {
  it("refuses files that aren't PDFs, or are encrypted", async () => {
    await expect(checkSignablePdf(new TextEncoder().encode("hello"))).rejects.toThrow("isn't a PDF");
    await expect(checkSignablePdf(new TextEncoder().encode("%PDF-1.7 broken"))).rejects.toThrow("couldn't be read");
    expect(await checkSignablePdf(await pdf(2))).toBe(2);
  });

  it("keeps the original pages and adds a signature page and certificate; a changed byte changes the fingerprint", async () => {
    const original = await pdf(2);
    const input = {
      requestId: "7",
      title: "Lease renewal",
      organisationName: "Kowhai Made-up Ltd",
      documentName: "lease.pdf",
      documentSha256: sha256Hex(original),
      sentAt: "2026-07-15T01:00:00Z",
      sentByEmail: "hemi@example.com",
      completedAt: "2026-07-16T02:00:00Z",
      consentText: "I agree to sign electronically",
      signers: [
        { position: 1, name: "Aroha Ngata", email: "aroha@example.com", roleLabel: "Director", signedAt: "2026-07-16T01:00:00Z", method: "typed" as const, typedName: "Aroha Ngata", signaturePng: null, verifiedBy: "email_code" as const, verifiedAt: "2026-07-16T00:59:00Z", ipAddress: "203.0.113.9", userAgent: "Made-up Browser", signedSha256: sha256Hex(original) },
        { position: 2, name: "Tama Rewi", email: "tama@example.com", roleLabel: null, signedAt: "2026-07-16T02:00:00Z", method: "drawn" as const, typedName: "Tama Rewi", signaturePng: new Uint8Array(Buffer.from(PNG, "base64")), verifiedBy: "tohyee_sign_in" as const, verifiedAt: "2026-07-16T01:59:00Z", ipAddress: null, userAgent: null, signedSha256: sha256Hex(original) },
      ],
    };
    const signed = await buildSignedPdf(original, input);
    const doc = await PDFDocument.load(signed);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(4);
    const { extractText } = await import("unpdf");
    const text = (await extractText(new Uint8Array(signed), { mergePages: true })).text;
    for (const expected of ["Signing certificate", "Aroha Ngata", "Tama Rewi", "Director", "203.0.113.9", "Signed in to Tohyee", "I agree to sign electronically", input.documentSha256.slice(0, 8)]) expect(text).toContain(expected);
    // Built for one document, it refuses another.
    await expect(buildSignedPdf(await pdf(3), input)).rejects.toThrow("doesn't match");
    const tampered = new Uint8Array(signed);
    tampered[100] ^= 1;
    expect(sha256Hex(tampered)).not.toBe(sha256Hex(signed));
  });
});
