import { afterAll, beforeAll, expect, it } from "vitest";
import * as draftRoute from "@/app/api/ledger/journal-drafts/[draftId]/route";
import * as postRoute from "@/app/api/ledger/journal-drafts/[draftId]/post/route";
import * as draftsRoute from "@/app/api/ledger/journal-drafts/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import {
  createJournalDraft,
  deleteJournalDraft,
  getJournalDraft,
  listJournalDrafts,
  postJournalDraft,
  updateJournalDraft,
} from "@/lib/ledger/journal-drafts";
import { getJournal, postJournal } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { trialBalance } from "@/lib/reports/financial";
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

const ORG = "drafts-co";
const noContext = undefined as unknown;

const prepay = (amount: string, postingDate = "2026-06-30") => ({
  postingDate,
  reference: "PREPAY-JUN",
  description: "Six months of the software subscription still to come",
  lines: [
    { accountCode: "1200", debitAmount: amount, description: "Prepaid software" },
    { accountCode: "6040", creditAmount: amount },
  ],
});

/** Examples MJD1-MJD9 in docs/ACCOUNTING-EXAMPLES.md ("Draft manual journals"). */
describeWithDatabase("draft manual journals", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;

  const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>, via?: string) =>
    inOrganisation(ORG, { userId: user.id, email: user.email, ...(via ? { via } : {}) }, work);
  const journalCount = async () =>
    Number((await asUser(owner, (tx) => tx.query<{ count: string }>("select count(*)::text as count from ledger_journals"))).rows[0].count);
  const balances = async (asAt: string) => {
    const report = await asUser(owner, (tx) => trialBalance(tx, { asAt }));
    const of = (code: string) => {
      const row = report.rows.find((entry) => entry.code === code);
      return row ? { debit: row.debit, credit: row.credit } : { debit: "0.00", credit: "0.00" };
    };
    return { prepayments: of("1200"), software: of("6040") };
  };

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    bookkeeper = await createTestUser("bookkeeper@example.com");
    viewer = await createTestUser("viewer@example.com");
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper'), ($1, $3, 'viewer')", [
      ORG,
      bookkeeper.id,
      viewer.id,
    ]);
    // The year's subscription, expensed on 1 Apr 2026.
    await asUser(bookkeeper, (tx) =>
      postJournal(tx, {
        idempotencyKey: key("sub"),
        postingDate: "2026-04-01",
        reference: "SOFTWARE-SUB",
        lines: [
          { accountCode: "6040", debitAmount: "1200.00" },
          { accountCode: "1000", creditAmount: "1200.00" },
        ],
      }),
    );
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("MJD1-MJD5: a draft posts nothing until it's posted, then posts exactly once and links the journal", async () => {
    const journalsBefore = await journalCount();
    const saved = await asUser(bookkeeper, (tx) => createJournalDraft(tx, { idempotencyKey: key("draft"), ...prepay("600.00") }));
    expect(saved.created).toBe(true);
    expect(saved.draft).toMatchObject({
      status: "draft",
      postingDate: "2026-06-30",
      reference: "PREPAY-JUN",
      total: "600.00",
      createdByEmail: bookkeeper.email,
      createdVia: null,
      postedJournalId: null,
    });
    expect(saved.draft.lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount])).toEqual([
      ["1200", "600.00", "0.00"],
      ["6040", "0.00", "600.00"],
    ]);
    // MJD1: nothing posted.
    expect(await journalCount()).toBe(journalsBefore);
    expect(await balances("2026-06-30")).toEqual({ prepayments: { debit: "0.00", credit: "0.00" }, software: { debit: "1200.00", credit: "0.00" } });

    // MJD2: checked like a journal; nothing saved.
    const draftsBefore = (await asUser(owner, (tx) => listJournalDrafts(tx))).length;
    const unbalanced = { ...prepay("600.00"), lines: [{ accountCode: "1200", debitAmount: "600.00" }, { accountCode: "6040", creditAmount: "550.00" }] };
    await expect(asUser(bookkeeper, (tx) => createJournalDraft(tx, { idempotencyKey: key("bad"), ...unbalanced }))).rejects.toThrow(/doesn't balance/);
    await expect(
      asUser(bookkeeper, (tx) => createJournalDraft(tx, { idempotencyKey: key("bad"), ...prepay("600.00"), lines: [{ accountCode: "1200", debitAmount: "600.00" }] })),
    ).rejects.toThrow(/at least two lines/);
    await expect(
      asUser(bookkeeper, (tx) =>
        createJournalDraft(tx, {
          idempotencyKey: key("bad"),
          ...prepay("600.00"),
          lines: [{ accountCode: "9999", debitAmount: "600.00" }, { accountCode: "6040", creditAmount: "600.00" }],
        }),
      ),
    ).rejects.toThrow(/no account with the code 9999/);
    expect((await asUser(owner, (tx) => listJournalDrafts(tx))).length).toBe(draftsBefore);

    // MJD3: edit; still nothing posted.
    const edited = await asUser(owner, (tx) => updateJournalDraft(tx, saved.draft.id, prepay("650.00")));
    expect(edited).toMatchObject({ status: "draft", total: "650.00", updatedByEmail: owner.email });
    expect(await journalCount()).toBe(journalsBefore);

    // MJD4: posting posts one manual journal and links it.
    const posted = await asUser(owner, (tx) => postJournalDraft(tx, saved.draft.id));
    expect(posted.created).toBe(true);
    expect(posted.draft).toMatchObject({ status: "posted", postedJournalId: posted.journal.id, postedByEmail: owner.email });
    expect(posted.journal).toMatchObject({ origin: "manual", postingDate: "2026-06-30", reference: "PREPAY-JUN", totalDebit: "650.00", createdByEmail: owner.email });
    expect(posted.journal.lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount])).toEqual([
      ["1200", "650.00", "0.00"],
      ["6040", "0.00", "650.00"],
    ]);
    expect(await journalCount()).toBe(journalsBefore + 1);
    expect(await balances("2026-06-30")).toEqual({ prepayments: { debit: "650.00", credit: "0.00" }, software: { debit: "550.00", credit: "0.00" } });

    // MJD5: posting again returns the same journal; a posted draft can't change or be deleted.
    const again = await asUser(owner, (tx) => postJournalDraft(tx, saved.draft.id));
    expect(again).toMatchObject({ created: false, journal: { id: posted.journal.id } });
    expect(await journalCount()).toBe(journalsBefore + 1);
    await expect(asUser(owner, (tx) => updateJournalDraft(tx, saved.draft.id, prepay("700.00")))).rejects.toThrow(/has been posted/);
    await expect(asUser(owner, (tx) => deleteJournalDraft(tx, saved.draft.id))).rejects.toThrow(/has been posted/);
    // The database refuses it too.
    await expect(asUser(owner, (tx) => tx.query("delete from ledger_journal_drafts where id = $1", [saved.draft.id]))).rejects.toThrow(/has been posted/);
    await expect(asUser(owner, (tx) => tx.query("update ledger_journal_draft_lines set debit_amount = 1 where draft_id = $1 and line_order = 1", [saved.draft.id]))).rejects.toThrow(
      /has been posted/,
    );
  });

  it("MJD6: posting into a locked period is refused and the draft stays a draft", async () => {
    const { draft } = await asUser(bookkeeper, (tx) => createJournalDraft(tx, { idempotencyKey: key("locked"), ...prepay("100.00") }));
    await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: "2026-06-30" }));
    try {
      const before = await journalCount();
      await expect(asUser(owner, (tx) => postJournalDraft(tx, draft.id))).rejects.toThrow(/lock|locked|closed/i);
      expect(await journalCount()).toBe(before);
      expect((await asUser(owner, (tx) => getJournalDraft(tx, draft.id))).status).toBe("draft");
      await asUser(owner, (tx) => updateJournalDraft(tx, draft.id, prepay("100.00", "2026-07-01")));
      const posted = await asUser(owner, (tx) => postJournalDraft(tx, draft.id));
      expect(posted.journal.postingDate).toBe("2026-07-01");
    } finally {
      await asUser(owner, (tx) => updatePeriodControls(tx, { lockDate: null, reason: "Test done" }));
    }
  });

  it("MJD7: a draft can be deleted (bookkeeper and up); viewers can see but not save, post or delete", async () => {
    const before = await journalCount();
    const { draft } = await asUser(bookkeeper, (tx) => createJournalDraft(tx, { idempotencyKey: key("del"), ...prepay("50.00") }));
    const viewerCookie = await sessionCookieFor(viewer);
    const listed = await draftsRoute.GET(apiRequest(`/api/ledger/journal-drafts?organisationId=${ORG}&status=draft`, { cookie: viewerCookie }), noContext);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { drafts: { id: string }[] }).drafts.map((entry) => entry.id)).toContain(draft.id);
    const viewerPost = await postRoute.POST(
      apiRequest(`/api/ledger/journal-drafts/${draft.id}/post`, { method: "POST", cookie: viewerCookie, body: { organisationId: ORG } }),
      params({ draftId: draft.id }),
    );
    expect(viewerPost.status).toBe(403);
    const viewerSave = await draftsRoute.POST(
      apiRequest("/api/ledger/journal-drafts", { method: "POST", cookie: viewerCookie, body: { organisationId: ORG, idempotencyKey: key("v"), ...prepay("1.00") } }),
      noContext,
    );
    expect(viewerSave.status).toBe(403);
    const viewerDelete = await draftRoute.DELETE(
      apiRequest(`/api/ledger/journal-drafts/${draft.id}?organisationId=${ORG}`, { method: "DELETE", cookie: viewerCookie }),
      params({ draftId: draft.id }),
    );
    expect(viewerDelete.status).toBe(403);

    const bookkeeperCookie = await sessionCookieFor(bookkeeper);
    const deleted = await draftRoute.DELETE(
      apiRequest(`/api/ledger/journal-drafts/${draft.id}?organisationId=${ORG}`, { method: "DELETE", cookie: bookkeeperCookie }),
      params({ draftId: draft.id }),
    );
    expect(deleted.status).toBe(200);
    await expect(asUser(owner, (tx) => getJournalDraft(tx, draft.id))).rejects.toThrow(/not found/);
    expect(await journalCount()).toBe(before);
  });

  it("MJD8: the same idempotency key returns the same draft; different content is refused", async () => {
    const idempotencyKey = key("same");
    const first = await asUser(bookkeeper, (tx) => createJournalDraft(tx, { idempotencyKey, ...prepay("20.00") }));
    const second = await asUser(bookkeeper, (tx) => createJournalDraft(tx, { idempotencyKey, ...prepay("20.00") }));
    expect(second).toMatchObject({ created: false, draft: { id: first.draft.id } });
    await expect(asUser(bookkeeper, (tx) => createJournalDraft(tx, { idempotencyKey, ...prepay("21.00") }))).rejects.toThrow(/already used/);
  });

  it("MJD9: a draft saved and posted by an AI key records the person and the key", async () => {
    const via = 'AI key "Claude on my laptop"';
    const { draft } = await asUser(bookkeeper, (tx) => createJournalDraft(tx, { source: "ai-1", idempotencyKey: key("ai"), ...prepay("30.00") }), via);
    expect(draft).toMatchObject({ createdByEmail: bookkeeper.email, createdVia: via });
    const posted = await asUser(bookkeeper, (tx) => postJournalDraft(tx, draft.id), via);
    expect(posted.draft).toMatchObject({ postedByEmail: bookkeeper.email, postedVia: via });
    const journal = await asUser(owner, (tx) => getJournal(tx, posted.journal.id));
    expect(journal.createdByEmail).toBe(bookkeeper.email);
    const audit = await asUser(owner, (tx) =>
      tx.query<{ event_type: string; actor_email: string; via: string | null }>(
        `select event_type, actor_email, details->>'via' as via from audit_events
          where (entity_type = 'journal_draft' and entity_id = $1) or event_type = 'ledger.journal_posted' and entity_id = $2
          order by id`,
        [draft.id, posted.journal.id],
      ),
    );
    expect(audit.rows).toEqual([
      { event_type: "journal_draft.created", actor_email: bookkeeper.email, via },
      expect.objectContaining({ event_type: "ledger.journal_posted", actor_email: bookkeeper.email, via }),
      { event_type: "journal_draft.posted", actor_email: bookkeeper.email, via },
    ]);
  });
});
