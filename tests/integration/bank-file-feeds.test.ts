import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as feedsRoute from "@/app/api/bank-accounts/[accountId]/file-feeds/route";
import * as feedRoute from "@/app/api/bank-accounts/[accountId]/file-feeds/[feedId]/route";
import * as checkRoute from "@/app/api/bank-accounts/[accountId]/file-feeds/[feedId]/check/route";
import * as filesRoute from "@/app/api/bank-accounts/[accountId]/file-feeds/[feedId]/files/route";
import * as foldersRoute from "@/app/api/admin/bank-file-folders/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { listBankAccounts, listStatementLines } from "@/lib/bank/accounts";
import { checkDueFileFeeds, checkFileFeed, createFolderFeed, createMailboxFeed, deleteFileFeed, listFileFeeds } from "@/lib/bank/file-feeds";
import { setBankFilesFolder } from "@/lib/bank/file-folders";
import { deleteImport, importStatementFile, listImports } from "@/lib/bank/imports";
import { setMailHostResolverForTests } from "@/lib/analytics/mail-host";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { getOrganisation } from "@/lib/organisations/registry";
import { encryptSecret } from "@/lib/secrets";
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

const mocks = vi.hoisted(() => ({
  messages: [] as Array<{ id: string; receivedAt: string | null; attachments: Array<{ name: string; size: number; read: () => Promise<Buffer> }> }>,
  failToken: false,
}));
vi.mock("@/lib/crm/mail/service", async (original) => ({
  ...(await original<object>()),
  reportMailboxToken: vi.fn(async () => {
    if (mocks.failToken) throw new Error("Reconnect this mailbox in the CRM: its sign-in has expired.");
    return { provider: "google", token: "test-token" };
  }),
}));
vi.mock("@/lib/analytics/report-email-providers", () => ({
  listReportFolders: vi.fn(async () => [{ id: "Label_7", name: "Bank/ANZ" }]),
  listImapFolders: vi.fn(async () => [{ id: "INBOX", name: "Inbox" }]),
  reportMessages: async function* () {
    yield* mocks.messages;
  },
  imapReportMessages: async function* () {
    yield* mocks.messages;
  },
}));

const HEADING = "Date,Amount,Payee,Particulars,Code,Reference";
// The hand import that saves 1000's column layout (as BK1), in May.
const MAY = `${HEADING}\n20/05/2026,115.00,KOBE LTD,INV-0001,,\n`;
const BF1 = `${HEADING}
01/06/2026,-46.00,Z ENERGY,,,
01/06/2026,-4.50,CAFE,,,
01/06/2026,115.00,KOBE LTD,INV-0007,,
`;
const b64 = (text: string) => Buffer.from(text).toString("base64");

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Examples BF1-BF10 in docs/ACCOUNTING-EXAMPLES.md ("Automatic statement
 * files"). 1000 Business bank account, its column layout saved by a hand
 * import; a temporary folder stands in for the organisation's bank files
 * folder, and a mocked Gmail label for the mailbox. The examples run in order
 * on one organisation, as they build on each other.
 */
describeWithDatabase("automatic statement files (BF1-BF10)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  let ownerCookie: string;
  let bookkeeperCookie: string;
  let viewerCookie: string;
  const root = path.join(os.tmpdir(), `tohyee-bank-files-${randomUUID()}`);
  const anz = path.join(root, "ANZ business");
  const org = "bank-files-co";
  let bankId = "";
  let feedId = "";
  let bf2ImportId = "";
  let organisations = 0;

  const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>, organisationId = org) =>
    inOrganisation(organisationId, { userId: user.id, email: user.email }, work);
  const write = (name: string, text: string, folder = anz) => fs.writeFileSync(path.join(folder, name), text);
  const check = async (id = feedId, organisationId = org) =>
    checkFileFeed((await getOrganisation(organisationId))!, { userId: bookkeeper.id, email: bookkeeper.email }, id);
  const juneLines = async (accountId = bankId, organisationId = org) =>
    (await asUser(viewer, (tx) => listStatementLines(tx, accountId, { status: "all" }), organisationId)).lines.filter((line) => line.date >= "2026-06-01");
  const serverAdmin = () => ({ user: { id: owner.id, email: owner.email, isServerAdmin: true } });

  /** An organisation with the members, 1000's layout saved by a hand import, and (optionally) a bank files folder. */
  async function newOrganisation(id: string, folder: string | null) {
    await createTestOrganisation(owner, id);
    for (const [user, role] of [
      [bookkeeper, "bookkeeper"],
      [viewer, "viewer"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [id, user.id, role]);
    }
    const bank = (await asUser(viewer, (tx) => listBankAccounts(tx), id)).find((account) => account.code === "1000")!;
    await asUser(bookkeeper, (tx) => importStatementFile(tx, bank.id, { idempotencyKey: key("import"), fileName: "may.csv", fileBase64: b64(MAY) }), id);
    if (folder) await setBankFilesFolder(serverAdmin(), id, folder);
    return bank.id;
  }

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "test-secret-key-that-is-long-enough-123456";
    setMailHostResolverForTests(async () => ["203.0.113.10"]);
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("bookkeeper@example.com");
    viewer = await createTestUser("viewer@example.com");
    ownerCookie = await sessionCookieFor(owner);
    bookkeeperCookie = await sessionCookieFor(bookkeeper);
    viewerCookie = await sessionCookieFor(viewer);
    fs.mkdirSync(anz, { recursive: true });
    fs.mkdirSync(path.join(root, "Westpac"));
    bankId = await newOrganisation(org, root);
    const created = await asUser(owner, (tx) => createFolderFeed(tx, org, bankId, { subfolder: "ANZ business" }));
    feedId = created.id;
    expect(created).toMatchObject({ kind: "folder", subfolder: "ANZ business", syncEveryHours: 6, lastCheckAt: null });
  });

  afterAll(async () => {
    setMailHostResolverForTests(null);
    await server?.teardown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("BF1: a new file is imported as unreconciled lines, marked with its feed; nothing is posted", async () => {
    write("anz-2026-06-01.csv", BF1);
    const journalsBefore = await asUser(viewer, (tx) => tx.query("select count(*)::int as n from ledger_journals"));
    expect(await check()).toMatchObject({ status: "ok", filesRead: 1, linesAdded: 3, error: null });
    const lines = await juneLines();
    expect(lines.map((line) => line.amount).sort()).toEqual(["-4.50", "-46.00", "115.00"]);
    expect(lines.every((line) => line.status === "unreconciled")).toBe(true);
    const imports = (await asUser(viewer, (tx) => listImports(tx, bankId)));
    expect(imports[0]).toMatchObject({ fileName: "anz-2026-06-01.csv", fileFeed: "folder", lineCount: 3, source: "file" });
    const journalsAfter = await asUser(viewer, (tx) => tx.query("select count(*)::int as n from ledger_journals"));
    expect(journalsAfter.rows[0]).toEqual(journalsBefore.rows[0]);
    const [feed] = await asUser(viewer, (tx) => listFileFeeds(tx, bankId));
    expect(feed).toMatchObject({ lastStatus: "ok", lastFilesRead: 1, lastLinesAdded: 3 });
    expect(feed.lastCheckAt).not.toBeNull();
  });

  it("BF2: the next file adds only its new line; a check with no new files reads nothing", async () => {
    write("anz-2026-06-02.csv", `${BF1}02/06/2026,-69.00,CALTEX,,,\n`);
    expect(await check()).toMatchObject({ status: "ok", filesRead: 1, linesAdded: 1 });
    expect(await check()).toMatchObject({ status: "ok", filesRead: 0, linesAdded: 0 });
    expect(await juneLines()).toHaveLength(4);
    bf2ImportId = (await asUser(viewer, (tx) => listImports(tx, bankId))).find((entry) => entry.fileName === "anz-2026-06-02.csv")!.id;
  });

  it("BF3: an overwritten file is read again only when its contents change; repeated lines count as BK2", async () => {
    write("statement.csv", `${HEADING}\n02/06/2026,-69.00,CALTEX,,,\n03/06/2026,-11.50,Z ENERGY,,,\n`);
    expect(await check()).toMatchObject({ filesRead: 1, linesAdded: 1 });
    write("statement.csv", `${HEADING}\n02/06/2026,-69.00,CALTEX,,,\n03/06/2026,-11.50,Z ENERGY,,,\n`);
    expect(await check()).toMatchObject({ filesRead: 0, linesAdded: 0 });
    write("statement.csv", `${HEADING}\n03/06/2026,-11.50,Z ENERGY,,,\n05/06/2026,-20.00,BP,,,\n`);
    expect(await check()).toMatchObject({ filesRead: 1, linesAdded: 1 });
    const cafes = `${HEADING}\n05/06/2026,-4.50,CAFE,,,\n05/06/2026,-4.50,CAFE,,,\n`;
    write("cafe.csv", cafes);
    expect(await check()).toMatchObject({ filesRead: 1, linesAdded: 2 });
    write("cafe-again.csv", cafes);
    expect(await check()).toMatchObject({ filesRead: 1, linesAdded: 0 });
    expect(await juneLines()).toHaveLength(8);
  });

  it("BF4: a CSV with other columns waits for a hand import, which saves its layout for the feed", async () => {
    const exportCsv = "Date,Details,Debit,Credit\n07/06/2026,BUNNINGS,30.00,\n";
    write("anz-export.csv", exportCsv);
    expect(await check()).toMatchObject({ status: "ok", filesRead: 1, linesAdded: 0 });
    const files = await body(await filesRoute.GET(apiRequest(`/api/bank-accounts/${bankId}/file-feeds/${feedId}/files?organisationId=${org}`, { cookie: viewerCookie }), params({ accountId: bankId, feedId })));
    expect((files.files as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: "anz-export.csv",
      result: "failed",
      reason: "Columns don't match the last file imported by hand.",
    });
    expect(await check()).toMatchObject({ filesRead: 0 });
    await asUser(bookkeeper, (tx) => importStatementFile(tx, bankId, { idempotencyKey: key("import"), fileName: "anz-export.csv", fileBase64: b64(exportCsv) }));
    write("anz-export-2.csv", "Date,Details,Debit,Credit\n08/06/2026,MITRE 10,12.00,\n");
    expect(await check()).toMatchObject({ filesRead: 1, linesAdded: 1 });
    expect((await juneLines()).find((line) => line.date === "2026-06-08")).toMatchObject({ amount: "-12.00" });
  });

  it("BF5: OFX lines matching CSV lines are flagged possible duplicates; the same OFX again adds 0; bad files are listed", async () => {
    const ofx = `OFXHEADER:100\n<OFX><BANKTRANLIST>
<STMTTRN><DTPOSTED>20260601<TRNAMT>-46.00<FITID>J1<NAME>Z ENERGY
<STMTTRN><DTPOSTED>20260601<TRNAMT>-4.50<FITID>J2<NAME>CAFE
<STMTTRN><DTPOSTED>20260601<TRNAMT>115.00<FITID>J3<NAME>KOBE LTD
</BANKTRANLIST></OFX>`;
    write("june.ofx", ofx);
    expect(await check()).toMatchObject({ filesRead: 1, linesAdded: 3 });
    const flagged = (await juneLines()).filter((line) => line.externalId?.startsWith("ofx:"));
    expect(flagged).toHaveLength(3);
    expect(flagged.every((line) => line.possibleDuplicateOf !== null)).toBe(true);
    write("june-copy.ofx", ofx);
    write("empty.csv", "");
    write("old.xls", "not really excel");
    expect(await check()).toMatchObject({ status: "ok", filesRead: 3, linesAdded: 0 });
    const files = (await body(await filesRoute.GET(apiRequest(`/api/bank-accounts/${bankId}/file-feeds/${feedId}/files?organisationId=${org}`, { cookie: viewerCookie }), params({ accountId: bankId, feedId })))).files as Array<{ name: string; result: string; reason: string | null }>;
    expect(files.find((file) => file.name === "june-copy.ofx")).toMatchObject({ result: "no_new" });
    expect(files.find((file) => file.name === "empty.csv")).toMatchObject({ result: "failed", reason: "The file is empty." });
    expect(files.find((file) => file.name === "old.xls")?.reason).toContain("Older Excel files (.xls) aren't supported");
    expect(await check()).toMatchObject({ filesRead: 0 });
  });

  it("BF6: deleting a feed's import removes its lines, and the feed doesn't bring the file back", async () => {
    const before = (await juneLines()).length;
    await asUser(bookkeeper, (tx) => deleteImport(tx, bf2ImportId));
    expect(await juneLines()).toHaveLength(before - 1);
    expect(await check()).toMatchObject({ filesRead: 0, linesAdded: 0 });
    expect((await juneLines()).find((line) => line.amount === "-69.00" && line.date === "2026-06-02")).toBeUndefined();
  });

  it("BF7: a mailbox feed imports statement attachments, ignores PDFs, and reads each message once", async () => {
    const mailOrg = "bank-files-mail";
    const mailBank = await newOrganisation(mailOrg, null);
    const mailAccountId = await asUser(owner, async (tx) => {
      await tx.query("update organisation_settings set crm_enabled = true");
      const inserted = await tx.query<{ id: string }>(
        `insert into crm_connected_accounts (user_id, provider, email, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at)
         values ($1, 'google', $2, $3, $3, now() + interval '1 hour') returning id::text`,
        [owner.id, owner.email, encryptSecret("refresh-token")],
      );
      return inserted.rows[0].id;
    }, mailOrg);
    const mailbox = await asUser(owner, (tx) =>
      createMailboxFeed(tx, mailBank, { mailKind: "crm", mailAccountId, mailFolderId: "Label_7", mailFolderName: "Bank/ANZ" }), mailOrg);
    expect(mailbox).toMatchObject({ kind: "mailbox", mailKind: "crm", mailAccountEmail: owner.email, mailFolderName: "Bank/ANZ", yours: true });
    const csv = `${HEADING}\n06/06/2026,-230.00,KAURI SUPPLIES,,,\n`;
    const pdf = { name: "statement.pdf", size: 4, read: vi.fn(async () => Buffer.from("%PDF")) };
    const attachment = (name: string, text: string) => ({ name, size: Buffer.byteLength(text), read: vi.fn(async () => Buffer.from(text)) });
    mocks.messages = [{ id: "m1", receivedAt: "2026-06-06T08:00:00Z", attachments: [attachment("anz-2026-06-06.csv", csv), pdf] }];
    expect(await check(mailbox.id, mailOrg)).toMatchObject({ status: "ok", filesRead: 1, linesAdded: 1 });
    expect(pdf.read).not.toHaveBeenCalled();
    const imports = (await asUser(viewer, (tx) => listImports(tx, mailBank), mailOrg));
    expect(imports[0]).toMatchObject({ fileName: "anz-2026-06-06.csv", fileFeed: "mailbox", lineCount: 1 });
    const again = attachment("anz-2026-06-06.csv", csv);
    mocks.messages = [{ id: "m1", receivedAt: "2026-06-06T08:00:00Z", attachments: [again] }];
    expect(await check(mailbox.id, mailOrg)).toMatchObject({ filesRead: 0, linesAdded: 0 });
    expect(again.read).not.toHaveBeenCalled();
    mocks.messages = [{ id: "m2-forwarded", receivedAt: "2026-06-07T08:00:00Z", attachments: [attachment("anz-2026-06-06.csv", csv)] }];
    expect(await check(mailbox.id, mailOrg)).toMatchObject({ filesRead: 1, linesAdded: 0 });
    expect(await juneLines(mailBank, mailOrg)).toHaveLength(1);

    // BF8 for a mailbox: an expired sign-in adds nothing and the message waits.
    mocks.failToken = true;
    mocks.messages = [{ id: "m3", receivedAt: "2026-06-08T08:00:00Z", attachments: [attachment("anz-2026-06-08.csv", `${HEADING}\n08/06/2026,-9.00,PARKING,,,\n`)] }];
    const failed = await check(mailbox.id, mailOrg);
    expect(failed).toMatchObject({ status: "failed", filesRead: 0 });
    expect(failed.error).toContain("sign-in has expired");
    mocks.failToken = false;
    expect(await check(mailbox.id, mailOrg)).toMatchObject({ status: "ok", filesRead: 1, linesAdded: 1 });

    // An IMAP feed keeps its app password encrypted and never returns it.
    const imap = await asUser(owner, (tx) =>
      createMailboxFeed(tx, mailBank, { mailKind: "imap", imapHost: "imap.gmail.com", imapUsername: "kobe@example.com", imapPassword: "app-password-1", mailFolderId: "INBOX", mailFolderName: "Inbox" }), mailOrg);
    expect(JSON.stringify(imap)).not.toContain("app-password-1");
    const stored = await asUser(owner, (tx) => tx.query<{ imap_password_ciphertext: string }>("select imap_password_ciphertext from bank_file_feeds where id = $1", [imap.id]), mailOrg);
    expect(stored.rows[0].imap_password_ciphertext).not.toContain("app-password-1");
    // Someone else's connected mailbox can't be used.
    const other = await asUser(bookkeeper, async (tx) =>
      (await tx.query<{ id: string }>(
        `insert into crm_connected_accounts (user_id, provider, email, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at)
         values ($1, 'google', $2, $3, $3, now() + interval '1 hour') returning id::text`,
        [bookkeeper.id, bookkeeper.email, encryptSecret("refresh-token")],
      )).rows[0].id, mailOrg);
    await expect(asUser(owner, (tx) => createMailboxFeed(tx, mailBank, { mailKind: "crm", mailAccountId: other, mailFolderId: "x", mailFolderName: "x" }), mailOrg)).rejects.toThrow(
      "Choose your own connected mailbox.",
    );
  });

  it("BF8: a check that can't read its folder adds nothing, shows why, and reads the files once it's fixed", async () => {
    // 1000's saved layout is BF4's Debit/Credit one now.
    write("anz-2026-06-09.csv", "Date,Details,Debit,Credit\n09/06/2026,PAK N SAVE,15.00,\n");
    fs.renameSync(anz, `${anz} (moved)`);
    const failed = await check();
    expect(failed).toMatchObject({ status: "failed", filesRead: 0, linesAdded: 0 });
    expect(failed.error).toContain(`can't open the folder "ANZ business"`);
    const [feed] = await asUser(viewer, (tx) => listFileFeeds(tx, bankId));
    expect(feed).toMatchObject({ lastStatus: "failed", lastError: failed.error });
    fs.renameSync(`${anz} (moved)`, anz);
    expect(await check()).toMatchObject({ status: "ok", filesRead: 1, linesAdded: 1 });
  });

  it("BF9: admins set feeds up, bookkeepers check, viewers see; subfolders stay inside the bank files folder", async () => {
    const base = `/api/bank-accounts/${bankId}/file-feeds`;
    const create = (cookie: string, subfolder: string) =>
      feedsRoute.POST(apiRequest(base, { method: "POST", cookie, body: { organisationId: org, kind: "folder", subfolder } }), params({ accountId: bankId }));
    expect((await create(bookkeeperCookie, "Westpac")).status).toBe(403);
    expect((await create(ownerCookie, "..")).status).toBe(400);
    expect((await create(ownerCookie, "../Other Co")).status).toBe(400);
    expect((await create(ownerCookie, "ANZ business")).status).toBe(409);
    // A link inside the folder that points outside it is refused too.
    const outside = path.join(os.tmpdir(), `tohyee-outside-${randomUUID()}`);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, "Sneaky"));
    expect((await create(ownerCookie, "Sneaky")).status).toBe(400);
    fs.rmSync(path.join(root, "Sneaky"));
    fs.rmSync(outside, { recursive: true });

    const listed = await body(await feedsRoute.GET(apiRequest(`${base}?organisationId=${org}`, { cookie: viewerCookie }), params({ accountId: bankId })));
    expect(listed.folder).toEqual({ chosen: true, readable: true, subfolders: ["ANZ business", "Westpac"] });
    expect(JSON.stringify(listed)).not.toContain(root);
    expect((listed.feeds as unknown[]).length).toBe(1);

    const feedPath = `${base}/${feedId}`;
    expect((await checkRoute.POST(apiRequest(`${feedPath}/check`, { method: "POST", cookie: viewerCookie, body: { organisationId: org } }), params({ accountId: bankId, feedId }))).status).toBe(403);
    const checked = await checkRoute.POST(apiRequest(`${feedPath}/check`, { method: "POST", cookie: bookkeeperCookie, body: { organisationId: org } }), params({ accountId: bankId, feedId }));
    expect(checked.status).toBe(200);
    expect((await body(checked)).check).toMatchObject({ status: "ok", filesRead: 0 });
    expect((await feedRoute.PATCH(apiRequest(feedPath, { method: "PATCH", cookie: bookkeeperCookie, body: { organisationId: org, syncEveryHours: 12 } }), params({ accountId: bankId, feedId }))).status).toBe(403);
    expect((await feedRoute.PATCH(apiRequest(feedPath, { method: "PATCH", cookie: ownerCookie, body: { organisationId: org, syncEveryHours: 25 } }), params({ accountId: bankId, feedId }))).status).toBe(400);
    const patched = await feedRoute.PATCH(apiRequest(feedPath, { method: "PATCH", cookie: ownerCookie, body: { organisationId: org, syncEveryHours: 12 } }), params({ accountId: bankId, feedId }));
    expect((await body(patched)).feed).toMatchObject({ syncEveryHours: 12 });
    // The feed must belong to the account in the address.
    const card = (await asUser(viewer, (tx) => listBankAccounts(tx))).find((account) => account.code === "2400")!;
    expect((await feedRoute.DELETE(apiRequest(`/api/bank-accounts/${card.id}/file-feeds/${feedId}?organisationId=${org}`, { method: "DELETE", cookie: ownerCookie }), params({ accountId: card.id, feedId }))).status).toBe(404);

    // Only a server admin chooses the bank files folder.
    const putFolder = (cookie: string, organisationId: string, folder: string) =>
      foldersRoute.PUT(apiRequest("/api/admin/bank-file-folders", { method: "PUT", cookie, body: { organisationId, folder } }), { params: Promise.resolve({}) });
    expect((await putFolder(bookkeeperCookie, org, root)).status).toBe(403);
    expect((await putFolder(ownerCookie, org, "relative/folder")).status).toBe(400);
    const folders = await body(await foldersRoute.GET(apiRequest("/api/admin/bank-file-folders", { cookie: ownerCookie }), { params: Promise.resolve({}) }));
    expect((folders.folders as Array<{ organisationId: string; folder: string | null; readable: boolean }>).find((row) => row.organisationId === org)).toMatchObject({ folder: root, readable: true });

    // With no folder chosen, folder feeds can't be set up.
    organisations += 1;
    const bare = `bank-files-bare-${organisations}`;
    const bareBank = await newOrganisation(bare, null);
    await expect(asUser(owner, (tx) => createFolderFeed(tx, bare, bareBank, { subfolder: "ANZ business" }), bare)).rejects.toThrow(
      "A server admin needs to choose this organisation's bank files folder first.",
    );
    const bareList = await body(await feedsRoute.GET(apiRequest(`/api/bank-accounts/${bareBank}/file-feeds?organisationId=${bare}`, { cookie: viewerCookie }), params({ accountId: bareBank })));
    expect(bareList.folder).toEqual({ chosen: false, readable: false, subfolders: [] });
  });

  it("BF10: removing a feed keeps its imports and what it read; linking the folder again doesn't import old files twice", async () => {
    const importsBefore = (await asUser(viewer, (tx) => listImports(tx, bankId))).length;
    const linesBefore = (await juneLines()).length;
    await asUser(owner, (tx) => deleteFileFeed(tx, feedId));
    expect(await asUser(viewer, (tx) => listFileFeeds(tx, bankId))).toEqual([]);
    expect((await asUser(viewer, (tx) => listImports(tx, bankId)))).toHaveLength(importsBefore);
    const again = await asUser(owner, (tx) => createFolderFeed(tx, org, bankId, { subfolder: "ANZ business", syncEveryHours: 24 }));
    expect(await check(again.id)).toMatchObject({ status: "ok", filesRead: 0, linesAdded: 0 });
    expect(await juneLines()).toHaveLength(linesBefore);
    const audit = await asUser(viewer, (tx) =>
      tx.query<{ event_type: string }>("select event_type from audit_events where event_type like 'bank_file_feed.%' order by id"),
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual(["bank_file_feed.created", "bank_file_feed.updated", "bank_file_feed.deleted", "bank_file_feed.created"]);
  });

  it("checks due feeds on the schedule, and not again until they're due", async () => {
    await asUser(owner, (tx) => tx.query("update bank_file_feeds set last_check_at = now() - interval '25 hours'"));
    write("anz-2026-06-10.csv", "Date,Details,Debit,Credit\n10/06/2026,CAFE,8.00,\n");
    const first = await checkDueFileFeeds();
    expect(first.checked).toBeGreaterThanOrEqual(1);
    expect((await juneLines()).find((line) => line.date === "2026-06-10")).toBeDefined();
    const [feed] = await asUser(viewer, (tx) => listFileFeeds(tx, bankId));
    expect(feed.lastFilesRead).toBe(1);
    write("anz-2026-06-11.csv", "Date,Details,Debit,Credit\n11/06/2026,CAFE,8.00,\n");
    await checkDueFileFeeds();
    expect((await juneLines()).find((line) => line.date === "2026-06-11")).toBeUndefined();
  });
});
