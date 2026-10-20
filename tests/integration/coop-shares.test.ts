import yauzl from "yauzl";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as holdingsRoute from "@/app/api/farming/coop-shares/route";
import * as movementsRoute from "@/app/api/farming/coop-share-movements/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { addDistribution, addHolding, addMovement, coopShareSchedule, removeDistribution, removeHolding, removeMovement } from "@/lib/farming/coop-shares";
import { setFarmingEnabled } from "@/lib/farming/paddocks";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { addAttachment, removeAttachment } from "@/lib/records/extras";
import { buildAccountantPack } from "@/lib/reports/accountant-pack";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "coop-shares";

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

const PDF = (label: string) => Buffer.from(`%PDF-1.4\n% ${label}\n`);

/** The co-op share register (CSR1-CSR10, #327; Codex, delegated by owner, 20 October 2026, not yet reviewed). */
describeWithDatabase("co-op share register", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  let fonterra = "";
  let ravensdown = "";
  let dividendFile = "";

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("coop-owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("coop-viewer@example.com");
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [ORG, viewer.id]);
    await as((tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 5 }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("CSR1: one holding per co-op and class, farming only", async () => {
    await expect(as((tx) => addHolding(tx, { coopName: "Fonterra", shareClass: "Co-operative shares" }))).rejects.toThrow(/Farming is off/);
    await as((tx) => setFarmingEnabled(tx, { enabled: true }));
    fonterra = (await as((tx) => addHolding(tx, { coopName: "Fonterra", shareClass: "Co-operative shares" }))).id;
    ravensdown = (await as((tx) => addHolding(tx, { coopName: "Ravensdown", shareClass: "Ordinary shares" }))).id;
    await expect(as((tx) => addHolding(tx, { coopName: "fonterra", shareClass: "CO-OPERATIVE SHARES" }))).rejects.toThrow(/already in the register/);
  });

  it("CSR2, CSR3, CSR5: opening, the year's movements and closing, each with its source", async () => {
    const move = (holdingId: string, date: string, kind: string, quantity: string, value: string, sourceReference: string | null = "Statement") =>
      as((tx) => addMovement(tx, { holdingId, date, kind, quantity, value, sourceReference }));
    await move(fonterra, "2025-05-31", "brought_forward", "120000", "660000.00", "2025 financial statements");
    await move(fonterra, "2025-09-15", "bought", "10000", "55800.00", "Share purchase confirmation");
    await move(fonterra, "2026-03-20", "sold", "5000", "27500.00", "Share surrender statement");
    await move(ravensdown, "2025-05-31", "brought_forward", "2000", "2000.00", "2025 financial statements");
    await move(ravensdown, "2025-09-30", "issued", "1500", "1500.00", "Rebate statement Sep 2025");
    // After the year end: not in this year's closing.
    await move(fonterra, "2026-06-10", "bought", "1000", "5600.00");

    // CSR2: one brought-forward balance, dated first.
    await expect(move(fonterra, "2025-05-31", "brought_forward", "1", "1.00")).rejects.toThrow(/already has a brought-forward/);
    await expect(move(ravensdown, "2025-05-30", "bought", "1", "1.00")).rejects.toThrow(/on or before every other movement/);
    // CSR5: a source is needed.
    await expect(move(fonterra, "2025-10-01", "bought", "1", "1.00", null)).rejects.toThrow(/which statement/);

    const schedule = await as((tx) => coopShareSchedule(tx, { yearEnd: "2026-05-31" }));
    expect(schedule.yearStart).toBe("2025-06-01");
    const [f, r] = schedule.holdings;
    expect([f.coopName, r.coopName]).toEqual(["Fonterra", "Ravensdown"]);
    expect(f.opening).toEqual({ quantity: "120000", value: "660000.00" });
    expect(f.movements.map((m) => [m.date, m.kindLabel, m.quantity, m.value, m.sourceReference])).toEqual([
      ["2025-09-15", "Bought or issued for payment", "10000", "55800.00", "Share purchase confirmation"],
      ["2026-03-20", "Sold, surrendered or redeemed", "-5000", "-27500.00", "Share surrender statement"],
    ]);
    expect(f.closing).toEqual({ quantity: "125000", value: "688300.00" });
    expect(r.opening).toEqual({ quantity: "2000", value: "2000.00" });
    expect(r.closing).toEqual({ quantity: "3500", value: "3500.00" });
    expect([schedule.totals.openingValue, schedule.totals.closingValue]).toEqual(["662000.00", "691800.00"]);

    // Next year opens at this year's closing.
    const next = await as((tx) => coopShareSchedule(tx, { yearEnd: "2027-05-31" }));
    expect(next.holdings[0].opening).toEqual({ quantity: "125000", value: "688300.00" });
    expect(next.holdings[0].closing).toEqual({ quantity: "126000", value: "693900.00" });
    await expect(as((tx) => coopShareSchedule(tx, { yearEnd: "2026-05-30" }))).rejects.toThrow(/financial year end/);
  });

  it("CSR4: never below nothing, checked over every movement", async () => {
    await expect(as((tx) => addMovement(tx, { holdingId: fonterra, date: "2025-08-01", kind: "sold", quantity: "130000", value: "1.00", sourceReference: "x" }))).rejects.toThrow(
      /fewer than no shares on 2025-08-01/,
    );
    await expect(as((tx) => addMovement(tx, { holdingId: fonterra, date: "2025-08-01", kind: "sold", quantity: "1", value: "700000.00", sourceReference: "x" }))).rejects.toThrow(
      /value below nothing/,
    );
    // A purchase a later sale relies on can't be removed.
    const holding = (await as((tx) => addHolding(tx, { coopName: "Silver Fern Farms", shareClass: "Rebate shares" }))).id;
    const bf = await as((tx) => addMovement(tx, { holdingId: holding, date: "2025-05-31", kind: "brought_forward", quantity: "100", value: "100.00", sourceReference: "x" }));
    const buy = await as((tx) => addMovement(tx, { holdingId: holding, date: "2025-07-01", kind: "bought", quantity: "50", value: "60.00", sourceReference: "x" }));
    const sale = await as((tx) => addMovement(tx, { holdingId: holding, date: "2025-08-01", kind: "sold", quantity: "140", value: "150.00", sourceReference: "x" }));
    await expect(as((tx) => removeMovement(tx, buy.id))).rejects.toThrow(/fewer than no shares on 2025-08-01/);
    // CSR8: entries removed first, then the holding.
    await expect(as((tx) => removeHolding(tx, holding))).rejects.toThrow(/movements and payments first/);
    for (const id of [sale.id, buy.id, bf.id]) await as((tx) => removeMovement(tx, id));
    await as((tx) => removeHolding(tx, holding));
    const again = await as((tx) => addHolding(tx, { coopName: "Silver Fern Farms", shareClass: "Rebate shares" }));
    await as((tx) => removeHolding(tx, again.id));
    const schedule = await as((tx) => coopShareSchedule(tx, { yearEnd: "2026-05-31" }));
    expect(schedule.holdings.map((h) => h.coopName)).toEqual(["Fonterra", "Ravensdown"]);
  });

  it("CSR5-CSR8: dividends, rebates and retentions apart, with statement files", async () => {
    dividendFile = (
      await as((tx) => addAttachment(tx, "owner", "coop-shareholding", fonterra, { idempotencyKey: key("f"), fileName: "Fonterra dividend Oct 2025.pdf", content: PDF("dividend") }))
    ).attachment.id;
    const otherFile = (
      await as((tx) => addAttachment(tx, "owner", "coop-shareholding", ravensdown, { idempotencyKey: key("f"), fileName: "Ravensdown rebate.pdf", content: PDF("rebate") }))
    ).attachment.id;
    const pay = (holdingId: string, date: string, kind: string, amount: string, extra: Record<string, unknown> = { sourceReference: "Statement" }) =>
      as((tx) => addDistribution(tx, { holdingId, date, kind, amount, ...extra }));
    // CSR5: only this holding's own files.
    await expect(pay(fonterra, "2025-10-15", "dividend", "18000.00", { attachmentId: otherFile })).rejects.toThrow(/isn't one of this holding's statements/);
    await pay(fonterra, "2025-10-15", "dividend", "18000.00", { attachmentId: dividendFile, imputationCredits: "7000.00" });
    await pay(fonterra, "2026-04-15", "dividend", "12000.00", { sourceReference: "Fonterra dividend statement Apr 2026", imputationCredits: "4666.67" });
    await pay(ravensdown, "2025-09-30", "rebate", "4500.00", { sourceReference: "Rebate statement Sep 2025", attachmentId: otherFile });
    await pay(ravensdown, "2025-09-30", "retention", "750.00");
    // CSR6: imputation credits only on dividends; amounts above zero.
    await expect(pay(ravensdown, "2025-09-30", "rebate", "10.00", { sourceReference: "x", imputationCredits: "1.00" })).rejects.toThrow(/Only dividends/);
    await expect(pay(ravensdown, "2025-09-30", "rebate", "0", { sourceReference: "x" })).rejects.toThrow(/must not be zero/);
    // CSR8: a mistake removed drops out.
    const mistake = await pay(fonterra, "2026-01-01", "dividend", "99.00");
    await as((tx) => removeDistribution(tx, mistake.id));

    const schedule = await as((tx) => coopShareSchedule(tx, { yearEnd: "2026-05-31" }));
    const [f, r] = schedule.holdings;
    expect(f.distributions.map((d) => [d.date, d.kindLabel, d.amount, d.imputationCredits, d.file?.fileName ?? null])).toEqual([
      ["2025-10-15", "Dividend", "18000.00", "7000.00", "Fonterra dividend Oct 2025.pdf"],
      ["2026-04-15", "Dividend", "12000.00", "4666.67", null],
    ]);
    expect(f.totals).toEqual({ dividends: "30000.00", imputationCredits: "11666.67", rebates: "0.00", retentions: "0.00" });
    expect(r.totals).toEqual({ dividends: "0.00", imputationCredits: "0.00", rebates: "4500.00", retentions: "750.00" });
    // CSR7: the rebate doesn't change the shares' value; the issued shares are their own movement.
    expect(r.closing.value).toBe("3500.00");
    expect(schedule.totals).toEqual({ openingValue: "662000.00", closingValue: "691800.00", dividends: "30000.00", imputationCredits: "11666.67", rebates: "4500.00", retentions: "750.00" });

    // CSR5: a file removed later still shows its name, marked removed.
    await as((tx) => removeAttachment(tx, "owner", "coop-shareholding", ravensdown, otherFile));
    const after = await as((tx) => coopShareSchedule(tx, { yearEnd: "2026-05-31" }));
    expect(after.holdings[1].distributions[0].file).toEqual({ id: otherFile, fileName: "Ravensdown rebate.pdf", removed: true });
  });

  it("CSR9: in the year-end pack, with the statements the year's entries name", async () => {
    const pack = await as((tx) => buildAccountantPack(tx, { yearEnd: "2026-05-31" }, new Date("2026-10-20T00:00:00Z")));
    const files = await unzip(pack.bytes);
    expect(pack.files).toContain("Co-op shares.csv");
    const csv = files.get("Co-op shares.csv")!.toString("utf8");
    expect(csv).toContain("Fonterra,Co-operative shares,01/06/2025,Opening,120000,660000.00,");
    expect(csv).toContain("Fonterra,Co-operative shares,20/03/2026,\"Sold, surrendered or redeemed\",-5000,-27500.00,Share surrender statement");
    expect(csv).toContain("Fonterra,Co-operative shares,31/05/2026,Closing,125000,688300.00,");
    expect(csv).toContain(",,,Total closing value,,691800.00,");
    expect(csv).toContain("Fonterra,Co-operative shares,15/10/2025,Dividend,18000.00,7000.00,Fonterra dividend Oct 2025.pdf");
    expect(csv).toContain("Ravensdown,Ordinary shares,30/09/2025,Rebate,4500.00,,Rebate statement Sep 2025; Ravensdown rebate.pdf (removed)");
    expect(csv).toContain(",,,Total dividends,30000.00,11666.67,");
    expect(csv).toContain(",,,Total retentions,750.00,,");
    expect(csv).not.toContain("10/06/2026");
    // Only the file that's still there; the removed one isn't included.
    const statements = [...files.keys()].filter((name) => name.startsWith("Co-op share statements/"));
    expect(statements).toEqual([`Co-op share statements/${dividendFile} Fonterra dividend Oct 2025.pdf`]);
    expect(files.get(statements[0])!.toString()).toContain("dividend");
    expect(files.get("Read me.txt")!.toString()).toContain("Co-op shares.csv");

    // No farming, no register in the pack.
    await as((tx) => setFarmingEnabled(tx, { enabled: false }));
    const without = await as((tx) => buildAccountantPack(tx, { yearEnd: "2026-05-31" }));
    expect(without.files.some((name) => name.startsWith("Co-op"))).toBe(false);
    await as((tx) => setFarmingEnabled(tx, { enabled: true }));
  });

  it("CSR1: viewers read the register; only bookkeepers and up change it", async () => {
    const cookie = await sessionCookieFor(viewer);
    const read = await holdingsRoute.GET(apiRequest(`/api/farming/coop-shares?organisationId=${ORG}&yearEnd=2026-05-31`, { cookie }), undefined as unknown as never);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { holdings: unknown[] }).holdings).toHaveLength(2);
    const add = await holdingsRoute.POST(
      apiRequest("/api/farming/coop-shares", { method: "POST", cookie, body: { organisationId: ORG, coopName: "LIC", shareClass: "Co-operative shares" } }),
      undefined as unknown as never,
    );
    expect(add.status).toBe(403);
    const move = await movementsRoute.POST(
      apiRequest("/api/farming/coop-share-movements", {
        method: "POST",
        cookie: await sessionCookieFor(owner),
        body: { organisationId: ORG, holdingId: fonterra, date: "2025-11-01", kind: "issued", quantity: "10", value: "0", sourceReference: "Bonus issue notice" },
      }),
      undefined as unknown as never,
    );
    expect(move.status).toBe(201);
  });
});
