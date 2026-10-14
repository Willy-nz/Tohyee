import yauzl from "yauzl";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { postJournal } from "@/lib/ledger/journals";
import { buildAccountantPack } from "@/lib/reports/accountant-pack";
import { trialBalance } from "@/lib/reports/financial";
import { createZip } from "@/lib/zip/write";
import * as packRoute from "@/app/api/reports/accountant-pack/route";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

/** Every file in a zip, by name, read back with yauzl (the same library Tohyee reads zips with). */
function unzip(bytes: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      const files = new Map<string, Buffer>();
      zip.on("end", () => resolve(files));
      zip.on("entry", (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError);
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => {
            files.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

/** The year-end accountant pack (#258): one ZIP of the same reports as the screens. */
describeWithDatabase("year-end accountant pack", () => {
  let server: TestServer;
  let owner: SessionUser;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("pack-owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("writes zips that read back exactly, deflated or stored", async () => {
    const big = "Trial balance,".repeat(500);
    const files = await unzip(createZip([{ name: "a.csv", data: big }, { name: "Kōwhai.txt", data: "x" }, { name: "empty.txt", data: "" }]));
    expect(files.get("a.csv")!.toString()).toBe(big);
    expect(files.get("Kōwhai.txt")!.toString()).toBe("x");
    expect(files.get("empty.txt")!.length).toBe(0);
    expect(() => createZip([{ name: "a", data: "1" }, { name: "a", data: "2" }])).toThrow("Two files");
  });

  it("holds the trial balance, P&L, balance sheet, general ledger and a bank reconciliation for the year", async () => {
    await createTestOrganisation(owner, "pack-co");
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation("pack-co", { userId: owner.id, email: owner.email }, work);
    const journal = (postingDate: string, debit: string, credit: string, amount: string) =>
      as((tx) =>
        postJournal(tx, {
          idempotencyKey: key("journal"),
          postingDate,
          reference: "Setup",
          lines: [
            { accountCode: debit, debitAmount: amount, creditAmount: "0" },
            { accountCode: credit, debitAmount: "0", creditAmount: amount },
          ],
        }),
      );
    // The default financial year ends 31 March: the year 1 Apr 2025 to 31 Mar 2026.
    await journal("2025-04-01", "1000", "3000", "5000.00");
    await journal("2025-06-20", "1000", "4000", "1500.00");
    await journal("2026-01-15", "6010", "1000", "250.00");
    // After the year end: not in the pack's P&L.
    await journal("2026-04-02", "1000", "4000", "999.00");

    const pack = await as((tx) => buildAccountantPack(tx, { yearEnd: "2026-03-31" }, new Date("2026-10-14T00:00:00Z")));
    expect(pack.fileName).toMatch(/year-end pack 2026-03-31\.zip$/);
    const files = await unzip(pack.bytes);
    expect([...files.keys()].sort()).toEqual(
      ["Balance sheet.csv", "Cash flows.csv", "Financial statements.pdf", "Changes in equity.csv", "Bank reconciliation 1000 Business bank account.pdf", "Bank reconciliation 2400 Credit card.pdf", "General ledger.csv", "Profit and loss.csv", "Read me.txt", "Trial balance.csv"].sort(),
    );
    expect(pack.files).toContain("Bank reconciliation 1000 Business bank account.pdf");

    const tb = await as((tx) => trialBalance(tx, { asAt: "2026-03-31" }));
    const tbCsv = files.get("Trial balance.csv")!.toString("utf8");
    expect(tbCsv).toContain("As at 31/03/2026");
    expect(tbCsv).toContain(`,Total,${tb.totalDebit},${tb.totalCredit}`);
    expect(tb.totalDebit).toBe("6500.00");

    const pl = files.get("Profit and loss.csv")!.toString("utf8");
    expect(pl).toContain("01/04/2025 to 31/03/2026");
    expect(pl).toContain(",Net profit,1250.00");
    expect(pl).not.toContain("999.00");

    const bs = files.get("Balance sheet.csv")!.toString("utf8");
    expect(bs).toContain(",Total liabilities and equity,6250.00");

    expect(files.get("Changes in equity.csv")!.toString("utf8")).toContain("Equity at 31/03/2026,6250.00");
    const cf = files.get("Cash flows.csv")!.toString("utf8");
    expect(cf).toContain("Net cash from operating activities,1250.00");
    expect(cf).toContain("Cash at 31/03/2026,6250.00");

    const gl = files.get("General ledger.csv")!.toString("utf8");
    expect(gl.split("\r\n").filter((line) => line.startsWith("1000,") && /\d{2}\/\d{2}\/2026|\d{2}\/\d{2}\/2025/.test(line))).toHaveLength(3);
    expect(gl).toContain("Closing balance");

    expect(files.get("Bank reconciliation 1000 Business bank account.pdf")!.subarray(0, 5).toString()).toBe("%PDF-");
    expect(files.get("Read me.txt")!.toString()).toContain("Financial year 01/04/2025 to 31/03/2026");
  });

  it("downloads from the route, with a macron in the organisation's name", async () => {
    await createTestOrganisation(owner, "pack-macron-co");
    await inOrganisation("pack-macron-co", { userId: owner.id, email: owner.email }, (tx) =>
      tx.query("update organisation_settings set display_name = 'Kōwhai Dairies Ltd' where id = true"),
    );
    const response = await packRoute.GET(
      apiRequest("/api/reports/accountant-pack?organisationId=pack-macron-co&yearEnd=2026-03-31", { cookie: await sessionCookieFor(owner) }),
      undefined as unknown as never,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="Kowhai Dairies Ltd year-end pack 2026-03-31.zip"; filename*=UTF-8''${encodeURIComponent("Kōwhai Dairies Ltd year-end pack 2026-03-31.zip")}`,
    );
    const files = await unzip(Buffer.from(await response.arrayBuffer()));
    expect(files.get("Read me.txt")!.toString()).toContain("Kōwhai Dairies Ltd: year-end accountant pack");
  });
});
