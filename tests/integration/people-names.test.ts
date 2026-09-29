import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as invoiceRoute from "@/app/api/invoices/[invoiceId]/route";
import * as invoicesRoute from "@/app/api/invoices/route";
import * as journalRoute from "@/app/api/ledger/journals/[journalId]/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import { coreQuery } from "@/lib/db/transactions";
import { postJournal } from "@/lib/ledger/journals";
import { addPersonNames } from "@/lib/people/names";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  params,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

const ORG = "names-co";
const noContext = undefined as unknown;

/**
 * People are shown by name, not email: organisation databases record who did
 * something by email, and names are looked up from the core users table
 * when data is read (one lookup of the organisation's members per request).
 */
describeWithDatabase("people's names on screens", () => {
  let server: TestServer;
  let owner: SessionUser;
  let aroha: SessionUser;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("william.j.kelly1@example.com", { serverAdmin: true, displayName: "William Kelly" });
    aroha = await createTestUser("aroha@example.com", { displayName: "Aroha Ngata" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [ORG, aroha.id]);
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("an invoice's 'saved by' comes back as the person's name, and still does after they leave", async () => {
    const customer = await inOrganisation(ORG, { userId: owner.id, email: owner.email }, (tx) =>
      createContact(tx, { idempotencyKey: key("c"), name: "Kobe Ltd", isCustomer: true }),
    );
    const arohaCookie = await sessionCookieFor(aroha);
    const created = await invoicesRoute.POST(
      apiRequest("/api/invoices", {
        method: "POST",
        cookie: arohaCookie,
        body: {
          organisationId: ORG,
          idempotencyKey: key("invoice"),
          contactId: customer.contact.id,
          invoiceDate: "2026-07-01",
          dueDate: "2026-07-20",
          amountsMode: "exclusive",
          lines: [{ description: "Paw print pendant", quantity: "1", unitPrice: "100.00", accountCode: "4000", taxCode: "GST" }],
        },
      }),
      noContext,
    );
    expect(created.status).toBe(201);
    const { invoice } = (await created.json()) as { invoice: { id: string; createdByEmail: string; createdByName: string } };
    expect([invoice.createdByEmail, invoice.createdByName]).toEqual([aroha.email, "Aroha Ngata"]);

    const ownerCookie = await sessionCookieFor(owner);
    const read = async () =>
      ((await (await invoiceRoute.GET(apiRequest(`/api/invoices/${invoice.id}?organisationId=${ORG}`, { cookie: ownerCookie }), params({ invoiceId: invoice.id }))).json()) as {
        invoice: { createdByEmail: string; createdByName: string };
      }).invoice;
    expect(await read()).toMatchObject({ createdByEmail: aroha.email, createdByName: "Aroha Ngata" });

    // A renamed person shows their current name (nothing was copied).
    await coreQuery("update users set display_name = 'Aroha Ngata-Smith' where id = $1", [aroha.id]);
    expect((await read()).createdByName).toBe("Aroha Ngata-Smith");

    // Someone who's left the organisation is still found by name.
    await coreQuery("delete from organisation_members where organisation_id = $1 and user_id = $2", [ORG, aroha.id]);
    expect((await read()).createdByName).toBe("Aroha Ngata-Smith");
  });

  it("a journal's 'posted by' is the name; anyone who can't be found shows as the email recorded", async () => {
    const posted = await inOrganisation(ORG, { userId: owner.id, email: owner.email }, (tx) =>
      postJournal(tx, {
        idempotencyKey: key("j"),
        postingDate: "2026-07-02",
        reference: "OF-1",
        description: "Owner funds",
        lines: [
          { accountCode: "1000", debitAmount: "50.00", creditAmount: "0" },
          { accountCode: "3000", debitAmount: "0", creditAmount: "50.00" },
        ],
      }),
    );
    const cookie = await sessionCookieFor(owner);
    const journalId = posted.journal.id;
    const response = await journalRoute.GET(apiRequest(`/api/ledger/journals/${journalId}?organisationId=${ORG}`, { cookie }), params({ journalId }));
    const body = JSON.stringify(await response.json());
    expect(body).toContain('"createdByName":"William Kelly"');

    const unknown = await addPersonNames({ rows: [{ createdByEmail: "cli", voidedByEmail: null }], other: { email: "kobe@example.com" } });
    expect(unknown).toEqual({ rows: [{ createdByEmail: "cli", createdByName: "cli", voidedByEmail: null }], other: { email: "kobe@example.com" } });
  });
});

describe("addPersonNames", () => {
  it("leaves contact and mail addresses alone", async () => {
    const value = { fromEmail: "a@b.c", toEmails: ["d@e.f"], email: "g@h.i" };
    expect(await addPersonNames(value, new Map([["a@b.c", "A"]]))).toEqual({ fromEmail: "a@b.c", toEmails: ["d@e.f"], email: "g@h.i" });
  });
});
