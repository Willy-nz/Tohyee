import { afterAll, beforeAll, expect, it } from "vitest";
import * as factsRoute from "@/app/api/organisations/[organisationId]/hire-facts/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { listBankAccounts } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import { coreQuery } from "@/lib/db/transactions";
import type { HireFacts } from "@/lib/organisations/hire-brief";
import { writeBrief } from "@/lib/organisations/hire-brief";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "hire-org";

/** Hire help (decisions 1475-1480): facts from the books are counts and periods only. Made-up data. */
describeWithDatabase("hire help brief facts", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("hire-owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("hire-bk@example.com");
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [ORG, bookkeeper.id]);
    const asOwner = <T>(work: Parameters<typeof inOrganisation<T>>[2]) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
    const bank = (await asOwner((tx) => listBankAccounts(tx))).find((account) => account.code === "1000")!;
    await asOwner((tx) =>
      importStatementFile(tx, bank.id, {
        idempotencyKey: key("import"),
        fileName: "s.csv",
        fileBase64: Buffer.from("Date,Amount,Payee\n21/05/2026,-46.00,Z ENERGY\n02/07/2026,1250.00,Hemi Customer\n15/07/2026,-12.50,Bakery\n").toString("base64"),
      }),
    );
  });

  afterAll(async () => {
    await server?.teardown();
  });

  const get = async (as: SessionUser) => factsRoute.GET(apiRequest(`/api/organisations/${ORG}/hire-facts`, { cookie: await sessionCookieFor(as) }), params({ organisationId: ORG }));

  it("counts lines not reconciled and the months they're in, for admins and owners only", async () => {
    const response = await get(owner);
    expect(response.status).toBe(200);
    const facts = ((await response.json()) as { facts: HireFacts }).facts;
    expect(facts).toMatchObject({ unreconciledLines: 3, unreconciledFrom: "2026-05", unreconciledTo: "2026-07", unreconciledMonths: 2, employees: expect.any(Number) });
    expect(facts.bankAccounts).toBeGreaterThanOrEqual(1);
    expect(facts.modules).toContain("Accounting");
    // Nothing about who was paid or how much reaches the brief.
    const brief = writeBrief(facts, { tasks: ["bank_reconciliation", "gst_return", "year_end"], catchUpMonths: 3, role: "bookkeeper", startDate: "2026-11-10", length: "1_month", untilDate: "" });
    expect(brief).toContain("about 3 bank statement lines");
    for (const secret of ["Hemi", "Bakery", "ENERGY", "1250", "46", "Test hire-org", ORG]) expect(brief).not.toContain(secret);
    expect((await get(bookkeeper)).status).toBe(403);
  });
});
