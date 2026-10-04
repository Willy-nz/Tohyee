import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { inspectSourceFile } from "@/lib/analytics/engine";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as mailboxesRoute from "@/app/api/organisations/[organisationId]/analytics/report-emails/route";
import * as checkRoute from "@/app/api/organisations/[organisationId]/analytics/report-emails/[id]/check/route";
import * as deleteRoute from "@/app/api/organisations/[organisationId]/analytics/report-emails/[id]/route";
import * as foldersRoute from "@/app/api/organisations/[organisationId]/analytics/report-emails/folders/route";
import { checkReportMailbox, runDueReportEmailChecks } from "@/lib/analytics/report-emails";
import { coreQuery } from "@/lib/db/transactions";
import { getOrganisation } from "@/lib/organisations/registry";
import { setMailFetchForTests } from "@/lib/crm/mail/providers";
import { setMailHostResolverForTests } from "@/lib/analytics/mail-host";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const mocks = vi.hoisted(() => ({
  messages: [] as Array<{ id: string; receivedAt: string | null; problem?: string; attachments: Array<{ name: string; size: number; read: () => Promise<Buffer> }> }>,
  token: vi.fn(async () => ({ provider: "google", token: "test-token" })),
}));
function storedCsvZip(name: string, bytes: Buffer): Buffer {
  const filename = Buffer.from(name);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50);
  header.writeUInt16LE(20, 4);
  header.writeUInt32LE((crc ^ 0xffffffff) >>> 0, 14);
  header.writeUInt32LE(bytes.length, 18);
  header.writeUInt32LE(bytes.length, 22);
  header.writeUInt16LE(filename.length, 26);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50);
  entry.writeUInt16LE(20, 4);
  header.copy(entry, 6, 4, 30);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(entry.length + filename.length, 12);
  end.writeUInt32LE(header.length + filename.length + bytes.length, 16);
  return Buffer.concat([header, filename, bytes, entry, filename, end]);
}
vi.mock("@/lib/crm/mail/service", async (original) => ({ ...await original<object>(), reportMailboxToken: mocks.token }));
vi.mock("@/lib/analytics/report-email-providers", () => ({
  listReportFolders: vi.fn(async () => [{ id: "reports", name: "Reports" }]),
  listImapFolders: vi.fn(async () => [{ id: "INBOX", name: "Inbox" }]),
  reportMessages: async function* () { yield* mocks.messages; },
  imapReportMessages: async function* () { yield* mocks.messages; },
}));

describeWithDatabase("report emails (decision 362)", () => {
  let server: TestServer;
  let cookie: string;
  let viewerCookie: string;
  let actor: { userId: string; email: string };
  let accountId: string;
  let otherAccountId: string;
  let mailboxId: string;
  const orgId = "email-reports";
  const root = path.join(os.tmpdir(), "tohyee-report-emails-" + randomUUID());
  const endpoint = `/api/organisations/${orgId}/analytics/report-emails`;
  const save = (body: object, asCookie = cookie) => mailboxesRoute.POST(apiRequest(endpoint, { method: "POST", cookie: asCookie, body }), params({ organisationId: orgId }));
  const attachment = (name: string, text: string) => ({ name, size: Buffer.byteLength(text), read: vi.fn(async () => Buffer.from(text)) });
  const attachmentBytes = (name: string, bytes: Buffer) => ({ name, size: bytes.length, read: vi.fn(async () => bytes) });

  beforeAll(async () => {
    // Made-up mail servers: public addresses, except the one pointed at this server.
    setMailHostResolverForTests(async (host) => (host === "mail.internal.example.com" ? ["10.0.0.5"] : ["203.0.113.10"]));
    server = await startTestServer();
    process.env.TOHYEE_SECRET_KEY = Buffer.alloc(32, 12).toString("base64");
    fs.mkdirSync(root);
    const owner = await createTestUser("owner@example.com");
    actor = { userId: owner.id, email: owner.email };
    await createTestOrganisation(owner, orgId);
    cookie = await sessionCookieFor(owner);
    const viewer = await createTestUser("viewer@example.com");
    viewerCookie = await sessionCookieFor(viewer);
    await coreQuery("insert into organisation_members (organisation_id,user_id,role) values ($1,$2,'viewer')", [orgId, viewer.id]);
    await coreQuery("insert into server_settings (key,value,updated_by_email) values ('analytics_folders',$1::jsonb,$2)", [JSON.stringify({ folders: { [orgId]: root } }), owner.email]);
    await inOrganisation(orgId, actor, async (tx) => {
      for (const userId of [owner.id, viewer.id]) {
        const result = await tx.query<{ id: string }>("insert into crm_connected_accounts (user_id,provider,email,refresh_token_ciphertext,access_token_ciphertext,access_token_expires_at) values ($1,'google',$2,$3,$3,now()+interval '1 hour') returning id::text", [userId, userId === owner.id ? owner.email : viewer.email, encryptSecret("refresh-token")]);
        if (userId === owner.id) accountId = result.rows[0].id;
        else otherAccountId = result.rows[0].id;
      }
      await tx.query("update organisation_settings set crm_enabled=true");
    });
  });
  afterAll(async () => { setMailHostResolverForTests(null); await server?.teardown(); fs.rmSync(root, { recursive: true, force: true }); delete process.env.TOHYEE_SECRET_KEY; });

  it("gates listing and saving when Analytics is off, and restricts routes to admins", async () => {
    expect((await mailboxesRoute.GET(apiRequest(endpoint, { cookie }), params({ organisationId: orgId }))).status).toBe(409);
    expect((await save({ kind: "crm", accountId, folderId: "reports", folderName: "Reports", replace: false })).status).toBe(409);
    await inOrganisation(orgId, actor, (tx) => tx.query("update organisation_settings set analytics_enabled=true"));
    expect((await save({ kind: "crm", accountId, folderId: "reports", folderName: "Reports", replace: false }, viewerCookie)).status).toBe(403);
    expect((await save({ kind: "crm", accountId: otherAccountId, folderId: "reports", folderName: "Reports", replace: false })).status).toBe(403);
  });
  it("lists only the caller's CRM accounts and returns no encrypted secrets", async () => {
    const response = await save({ kind: "crm", accountId, folderId: "reports", folderName: "Reports", replace: false });
    expect(response.status).toBe(200);
    const mailbox = await response.json();
    mailboxId = mailbox.id;
    expect(mailbox).toMatchObject({ kind: "crm", accountId, replace: false, hasPassword: false });
    const listed = await (await mailboxesRoute.GET(apiRequest(endpoint, { cookie }), params({ organisationId: orgId }))).json();
    expect(listed.accounts).toEqual([{ id: accountId, email: actor.email, provider: "google" }]);
    expect(listed.mailboxes).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toMatch(/ciphertext|refresh-token/);
  });
  it("remembers messages before reading attachments again", async () => {
    const file = attachment("sales.csv", "region,total\nOtago,123\n");
    mocks.messages = [{ id: "first", receivedAt: "2026-10-01T10:00:00Z", attachments: [file] }];
    const response = await checkRoute.POST(apiRequest(`${endpoint}/${mailboxId}/check`, { method: "POST", cookie }), params({ organisationId: orgId, id: mailboxId }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(Object.keys(result)).toEqual(["check"]);
    expect(result.check).toMatchObject({ filesSaved: 1, status: "ok", error: null });
    const organisation = (await getOrganisation(orgId))!;
    expect(await checkReportMailbox(organisation, actor, mailboxId)).toMatchObject({ filesSaved: 0, status: "ok" });
    expect(file.read).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(root, { recursive: true }).filter((name) => String(name).endsWith(".csv"))).toHaveLength(1);
  });
  it("continues after unsafe and oversized attachments, never exposing provider errors", async () => {
    const huge = { name: "huge.csv", size: 26 * 1024 * 1024, read: vi.fn(async () => Buffer.from("large")) };
    const good = attachment("good.csv", "value\n2\n");
    mocks.messages = [{ id: "bad-path", receivedAt: "2026-10-02T10:00:00Z", attachments: [attachment("../secret.csv", "secret"), huge, good] }];
    const result = await checkReportMailbox((await getOrganisation(orgId))!, actor, mailboxId);
    expect(result).toMatchObject({ status: "failed", filesSaved: 1 });
    expect(huge.read).not.toHaveBeenCalled();
    expect(result.error).not.toContain("secret");
    expect(result.error).not.toMatch(/Excel/i);
  });
  it("keeps the newest report in replace mode even when newest messages arrive first", async () => {
    expect((await save({ id: mailboxId, kind: "crm", accountId, folderId: "reports", folderName: "Reports", replace: true })).status).toBe(200);
    mocks.messages = [
      { id: "latest", receivedAt: "2026-10-03T10:00:00Z", attachments: [attachment("daily.csv", "value\n300\n")] },
      { id: "older", receivedAt: "2026-10-02T10:00:00Z", attachments: [attachment("daily.csv", "value\n200\n")] },
    ];
    await checkReportMailbox((await getOrganisation(orgId))!, actor, mailboxId);
    const csvs = fs.readdirSync(root, { recursive: true }).map(String).filter((name) => name.endsWith(".csv"));
    expect(csvs.filter((name) => fs.readFileSync(path.join(root, name), "utf8") === "value\n300\n")).toHaveLength(1);
    expect(csvs.some((name) => fs.readFileSync(path.join(root, name), "utf8") === "value\n200\n")).toBe(false);
  });
  it("clears remembered messages and replacement reservations when the source folder changes", async () => {
    const response = await save({ id: mailboxId, kind: "crm", accountId, folderId: "different-folder", folderName: "Different reports", replace: true });
    expect(response.status).toBe(200);
    const state = await inOrganisation(orgId, actor, async (tx) => ({
      messages: (await tx.query("select 1 from analytics_report_email_messages where mailbox_id=$1", [mailboxId])).rowCount,
      outputs: (await tx.query("select 1 from analytics_report_email_outputs where mailbox_id=$1", [mailboxId])).rowCount,
    }));
    expect(state).toEqual({ messages: 0, outputs: 0 });
    const file = attachment("daily.csv", "value\n100\n");
    mocks.messages = [{ id: "first", receivedAt: "2026-10-01T10:00:00Z", attachments: [file] }];
    expect(await checkReportMailbox((await getOrganisation(orgId))!, actor, mailboxId)).toMatchObject({ status: "ok", filesSaved: 1 });
    expect(file.read).toHaveBeenCalledOnce();
    const outputs = await inOrganisation(orgId, actor, (tx) => tx.query("select message_id from analytics_report_email_outputs where mailbox_id=$1 and output_name='daily.csv'", [mailboxId]));
    expect(outputs.rows).toEqual([{ message_id: "first" }]);
  });
  it("reserves newest replacement before writing so a retry cannot publish an older receipt", async () => {
    await inOrganisation(orgId, actor, (tx) => tx.query(
      `insert into analytics_report_email_outputs (mailbox_id,output_name,received_at,message_id)
       values ($1,'reserved.csv','2026-10-05T10:00:00Z','crashed-newest')`, [mailboxId]));
    mocks.messages = [{ id: "old-reserved", receivedAt: "2026-10-04T10:00:00Z", attachments: [attachment("reserved.csv", "old")] }];
    expect(await checkReportMailbox((await getOrganisation(orgId))!, actor, mailboxId)).toMatchObject({ status: "ok", filesSaved: 0 });
    mocks.messages = [{ id: "crashed-newest", receivedAt: "2026-10-05T10:00:00Z", attachments: [attachment("reserved.csv", "new")] }];
    expect(await checkReportMailbox((await getOrganisation(orgId))!, actor, mailboxId)).toMatchObject({ status: "ok", filesSaved: 1 });
  });
  it("commits the job claim before network reads and prevents concurrent checks or config edits", async () => {
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const file = { name: "blocked.csv", size: 2, read: async () => { started(); await blocked; return Buffer.from("1\n"); } };
    mocks.messages = [{ id: "blocked", receivedAt: "2026-10-06T10:00:00Z", attachments: [file] }];
    const organisation = (await getOrganisation(orgId))!;
    const first = checkReportMailbox(organisation, actor, mailboxId);
    await entered;
    try {
      await expect(checkReportMailbox(organisation, actor, mailboxId)).rejects.toThrow(/already being checked/);
      expect((await save({ id: mailboxId, kind: "crm", accountId, folderId: "reports", folderName: "Reports", replace: true })).status).toBe(409);
      const runs = await inOrganisation(orgId, actor, (tx) => tx.query("select status from analytics_report_email_checks where mailbox_id=$1 and status='running'", [mailboxId]));
      expect(runs.rows).toHaveLength(1);
    } finally { release(); }
    expect(await first).toMatchObject({ status: "ok", filesSaved: 1 });
  });
  it("applies the analytics and account privacy gates to folder listing and checking too", async () => {
    expect((await foldersRoute.GET(apiRequest(`${endpoint}/folders?accountId=${otherAccountId}`, { cookie }), params({ organisationId: orgId }))).status).toBe(403);
    await inOrganisation(orgId, actor, (tx) => tx.query("update organisation_settings set analytics_enabled=false"));
    expect((await foldersRoute.GET(apiRequest(`${endpoint}/folders?accountId=${accountId}`, { cookie }), params({ organisationId: orgId }))).status).toBe(409);
    expect((await checkRoute.POST(apiRequest(`${endpoint}/${mailboxId}/check`, { method: "POST", cookie }), params({ organisationId: orgId, id: mailboxId }))).status).toBe(409);
    expect((await deleteRoute.DELETE(apiRequest(`${endpoint}/${mailboxId}`, { method: "DELETE", cookie }), params({ organisationId: orgId, id: mailboxId }))).status).toBe(409);
    await inOrganisation(orgId, actor, (tx) => tx.query("update organisation_settings set analytics_enabled=true"));
  });
  it("schedules due checks and recovers an abandoned committed lease without overlapping", async () => {
    mocks.messages = [];
    const organisation = (await getOrganisation(orgId))!;
    await inOrganisation(orgId, actor, async (tx) => {
      await tx.query("update analytics_report_mailboxes set last_check_at=now()-interval '20 minutes',lease_id=$2,lease_until=now()-interval '1 minute' where id=$1", [mailboxId, randomUUID()]);
      await tx.query("insert into analytics_report_email_checks (mailbox_id,trigger,requested_by_email) values ($1,'schedule',$2)", [mailboxId, actor.email]);
    });
    // Once a night, after 3am business time (before the 4am reload).
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    tomorrow.setUTCHours(18, 0, 0, 0);
    expect(await runDueReportEmailChecks(tomorrow)).toMatchObject([{ mailboxId, status: "ok", filesSaved: 0 }]);
    expect(await runDueReportEmailChecks(tomorrow)).toEqual([]);
    expect(await runDueReportEmailChecks(new Date(tomorrow.getTime() + 60 * 60 * 1000))).toEqual([]);
    await expect(checkReportMailbox(organisation, actor, mailboxId, "schedule", tomorrow)).rejects.toThrow(/not due/);
    const failed = await inOrganisation(orgId, actor, (tx) => tx.query("select error from analytics_report_email_checks where mailbox_id=$1 and error='The previous check stopped. Retrying.'", [mailboxId]));
    expect(failed.rows).toHaveLength(1);
  });
  it("does not schedule checks for a deactivated mailbox owner", async () => {
    await inOrganisation(orgId, actor, (tx) => tx.query("update analytics_report_mailboxes set last_check_at=now()-interval '20 minutes' where id=$1", [mailboxId]));
    await coreQuery("update users set is_active=false where id=$1", [actor.userId]);
    try { expect(await runDueReportEmailChecks()).toEqual([]); }
    finally { await coreQuery("update users set is_active=true where id=$1", [actor.userId]); }
  });
  it("saves Excel attachments and skips unsupported PDFs", async () => {
    const pdf = attachment("report.pdf", "PDF data");
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Sales").addRows([["Day", "Total"], ["2026-10-08", 12.5]]);
    const excelBytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const excel = attachmentBytes("report.xlsx", excelBytes);
    mocks.messages = [{ id: "unsupported", receivedAt: "2026-10-08T10:00:00Z", attachments: [pdf, excel] }];
    expect(await checkReportMailbox((await getOrganisation(orgId))!, actor, mailboxId)).toMatchObject({ status: "ok", filesSaved: 1 });
    expect(pdf.read).not.toHaveBeenCalled();
    expect(excel.read).toHaveBeenCalledOnce();
    const saved = fs.readdirSync(root, { recursive: true }).map(String).find((name) => name.endsWith("/report.xlsx"));
    expect(saved).toBeDefined();
    expect(fs.readFileSync(path.join(root, saved!))).toEqual(excelBytes);
    // The saved workbook is ready to set up as a data source.
    expect((await inspectSourceFile(root, saved!)).rows).toEqual([["2026-10-08", "12.5"]]);

    // A password-protected workbook is refused, and the email says why.
    const locked = attachmentBytes("locked.xlsx", Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(504)]));
    mocks.messages = [{ id: "locked-excel", receivedAt: "2026-10-08T11:00:00Z", attachments: [locked] }];
    expect(await checkReportMailbox((await getOrganisation(orgId))!, actor, mailboxId)).toMatchObject({ status: "failed", filesSaved: 0 });
    const stored = await inOrganisation(orgId, actor, (tx) =>
      tx.query<{ error: string }>("select error from analytics_report_email_messages where mailbox_id=$1 and message_id='locked-excel'", [mailboxId]));
    expect(stored.rows[0].error).toMatch(/^An Excel attachment couldn't be saved: This file is password-protected/);
  });
  it("refreshes an expired CRM token outside transactions and then reuses the fresh token", async () => {
    const actual = await vi.importActual<typeof import("@/lib/crm/mail/service")>("@/lib/crm/mail/service");
    const organisation = (await getOrganisation(orgId))!;
    await inOrganisation(orgId, actor, async (tx) => {
      await tx.query("update crm_mail_settings set google_client_id='report-test-client',google_client_secret_ciphertext=$1", [encryptSecret("report-client-secret")]);
      await tx.query("update crm_connected_accounts set refresh_token_ciphertext=$2,access_token_ciphertext=$3,access_token_expires_at=now()-interval '1 minute' where id=$1",
        [accountId, encryptSecret("refresh-before"), encryptSecret("expired-access")]);
    });
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      expect(new URL(input).pathname).toBe("/token");
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(form.get("refresh_token")).toBe("refresh-before");
      expect(form.get("client_id")).toBe("report-test-client");
      const open = await coreQuery<{ count: number }>("select count(*)::integer as count from pg_stat_activity where datname=$1 and state='idle in transaction'", [organisation.databaseName]);
      expect(open.rows[0].count).toBe(0);
      return new Response(JSON.stringify({ access_token: "fresh-access", refresh_token: "refresh-after", expires_in: 3600 }), { headers: { "content-type": "application/json" } });
    });
    setMailFetchForTests(fetch);
    mocks.token.mockImplementation(async () => actual.reportMailboxToken(organisation, actor, accountId));
    mocks.messages = [];
    try {
      const first = await checkReportMailbox(organisation, actor, mailboxId);
      expect(first.status).toBe("ok");
      expect(JSON.stringify(first)).not.toMatch(/fresh-access|refresh-after/);
      const stored = await inOrganisation(orgId, actor, (tx) => tx.query<{ access_token_ciphertext: string; refresh_token_ciphertext: string; fresh: boolean }>(
        "select access_token_ciphertext,refresh_token_ciphertext,access_token_expires_at>now()+interval '50 minutes' as fresh from crm_connected_accounts where id=$1", [accountId]));
      expect(decryptSecret(stored.rows[0].access_token_ciphertext)).toBe("fresh-access");
      expect(decryptSecret(stored.rows[0].refresh_token_ciphertext)).toBe("refresh-after");
      expect(stored.rows[0].fresh).toBe(true);
      expect(await checkReportMailbox(organisation, actor, mailboxId)).toMatchObject({ status: "ok" });
      expect(fetch).toHaveBeenCalledOnce();
      await expect(actual.reportMailboxToken(organisation, actor, otherAccountId)).rejects.toThrow(/your own/);
    } finally {
      mocks.token.mockImplementation(async () => ({ provider: "google", token: "test-token" }));
      setMailFetchForTests(null);
    }
  });
  it("defers an unread or underreported file after the 100 MB check budget and retries it", async () => {
    const files = Array.from({ length: 5 }, (_, index) => ({
      name: `cap-${index}.csv`, size: 1, read: vi.fn(async () => Buffer.alloc(21 * 1024 * 1024, "0")),
    }));
    const last = attachment("after-cap.csv", "value\n1\n");
    mocks.messages = files.map((file, index) => ({ id: `cap-${index}`, receivedAt: "2026-10-08T11:00:00Z", attachments: [file] }));
    mocks.messages.push({ id: "after-cap", receivedAt: "2026-10-08T12:00:00Z", attachments: [last] });
    const organisation = (await getOrganisation(orgId))!;
    expect(await checkReportMailbox(organisation, actor, mailboxId)).toMatchObject({ status: "failed", filesSaved: 4 });
    expect(last.read).not.toHaveBeenCalled();
    const remembered = await inOrganisation(orgId, actor, (tx) => tx.query("select message_id from analytics_report_email_messages where mailbox_id=$1 and message_id in ('cap-4','after-cap')", [mailboxId]));
    expect(remembered.rows).toEqual([]);
    expect(await checkReportMailbox(organisation, actor, mailboxId)).toMatchObject({ status: "ok", filesSaved: 2 });
    expect(files[4].read).toHaveBeenCalledTimes(2);
    expect(last.read).toHaveBeenCalledOnce();
    for (const file of files.slice(0, 4)) expect(file.read).toHaveBeenCalledOnce();
  });
  it("defers a safe ZIP when raw bytes plus expansion no longer fit, without remembering it", async () => {
    const files = Array.from({ length: 4 }, (_, index) => ({
      name: `zip-cap-${index}.csv`, size: 21 * 1024 * 1024, read: vi.fn(async () => Buffer.alloc(21 * 1024 * 1024, "0")),
    }));
    const bytes = storedCsvZip("expanded.csv", Buffer.alloc(8 * 1024 * 1024, "0"));
    const archive = { name: "budget.zip", size: bytes.length, read: vi.fn(async () => bytes) };
    mocks.messages = files.map((file, index) => ({ id: `zip-cap-${index}`, receivedAt: "2026-10-09T11:00:00Z", attachments: [file] }));
    mocks.messages.push({ id: "deferred-zip", receivedAt: "2026-10-09T12:00:00Z", attachments: [archive] });
    const organisation = (await getOrganisation(orgId))!;
    expect(await checkReportMailbox(organisation, actor, mailboxId)).toMatchObject({ status: "failed", filesSaved: 4 });
    const remembered = await inOrganisation(orgId, actor, (tx) => tx.query("select 1 from analytics_report_email_messages where mailbox_id=$1 and message_id='deferred-zip'", [mailboxId]));
    expect(remembered.rows).toEqual([]);
    expect(await checkReportMailbox(organisation, actor, mailboxId)).toMatchObject({ status: "ok", filesSaved: 1 });
    expect(archive.read).toHaveBeenCalledTimes(2);
  });
  it("records a safe failed check when no source folder has been chosen", async () => {
    await coreQuery("update server_settings set value=$1::jsonb where key='analytics_folders'", [JSON.stringify({ folders: {} })]);
    try {
      const response = await checkRoute.POST(apiRequest(`${endpoint}/${mailboxId}/check`, { method: "POST", cookie }), params({ organisationId: orgId, id: mailboxId }));
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.check).toMatchObject({ status: "failed", filesSaved: 0 });
      expect(result.check.error).toMatch(/source folder/);
      expect(JSON.stringify(result)).not.toContain(root);
    } finally {
      await coreQuery("update server_settings set value=$1::jsonb where key='analytics_folders'", [JSON.stringify({ folders: { [orgId]: root } })]);
    }
  });
  it("encrypts IMAP passwords, keeps saved passwords on edit, refuses non-TLS ports", async () => {
    const input = { kind: "imap", host: "imap.example.com", port: 993, username: "reports@example.com", password: "private-password", folderId: "INBOX", folderName: "Inbox", replace: false };
    expect((await save({ ...input, port: 143 })).status).toBe(400);
    const saved = await (await save(input)).json();
    expect(saved).toMatchObject({ hasPassword: true, port: 993 });
    expect(JSON.stringify(saved)).not.toContain("private-password");
    const edited = await (await save({ ...input, id: saved.id, password: "" })).json();
    expect(edited.hasPassword).toBe(true);
    const folders = await foldersRoute.POST(apiRequest(`${endpoint}/folders`, { method: "POST", cookie, body: { ...input, password: "", mailboxId: saved.id } }), params({ organisationId: orgId }));
    expect(await folders.json()).toEqual({ folders: [{ id: "INBOX", name: "Inbox" }] });
    mocks.messages = [{ id: "imap-failure", receivedAt: "2026-10-07T10:00:00Z", attachments: [{ name: "report.csv", size: 2, read: async () => { throw new Error("IMAP auth private-password rejected"); } }] }];
    const checked = await checkReportMailbox((await getOrganisation(orgId))!, actor, saved.id);
    expect(checked.status).toBe("failed");
    expect(checked.error).not.toMatch(/private-password|IMAP auth/);
    const checkResponse = await checkRoute.POST(apiRequest(`${endpoint}/${saved.id}/check`, { method: "POST", cookie }), params({ organisationId: orgId, id: saved.id }));
    const publicResult = await checkResponse.json();
    expect(publicResult.check).toMatchObject({ status: "failed" });
    expect(JSON.stringify(publicResult)).not.toMatch(/private-password|ciphertext|IMAP auth/);
    const stored = await inOrganisation(orgId, actor, (tx) => tx.query("select password_ciphertext from analytics_report_mailboxes where id=$1", [saved.id]));
    expect(stored.rows[0].password_ciphertext).not.toContain("private-password");
    const audit = await inOrganisation(orgId, actor, (tx) => tx.query("select details from audit_events where event_type like 'analytics.report_%'"));
    expect(JSON.stringify(audit.rows)).not.toContain("private-password");
    expect((await deleteRoute.DELETE(apiRequest(`${endpoint}/${saved.id}`, { method: "DELETE", cookie }), params({ organisationId: orgId, id: saved.id }))).status).toBe(200);
  });

  it("carries on past a message it can't read, and gives up on one after three tries", async () => {
    const organisation = (await getOrganisation(orgId))!;
    const good = attachment("after-bad.csv", "value\n1\n");
    const unsaved = { name: "nested/../escape.csv", size: 5, read: vi.fn(async () => Buffer.from("value")) };
    mocks.messages = [
      { id: "unreadable", receivedAt: null, attachments: [], problem: "The report email has too many MIME parts." },
      { id: "unsafe-name", receivedAt: "2026-10-10T09:00:00Z", attachments: [unsaved] },
      { id: "after-bad", receivedAt: "2026-10-10T10:00:00Z", attachments: [good] },
    ];
    const attemptsOf = async () =>
      (await inOrganisation(orgId, actor, (tx) =>
        tx.query<{ message_id: string; status: string; attempts: number; error: string | null }>(
          "select message_id, status, attempts, error from analytics_report_email_messages where mailbox_id=$1 and message_id in ('unreadable','unsafe-name','after-bad') order by message_id", [mailboxId]))).rows;
    for (let check = 1; check <= 4; check++) {
      expect(await checkReportMailbox(organisation, actor, mailboxId)).toMatchObject({ status: check <= 3 ? "failed" : "ok" });
    }
    expect(good.read).toHaveBeenCalledOnce();
    expect(await attemptsOf()).toEqual([
      { message_id: "after-bad", status: "saved", attempts: 1, error: null },
      { message_id: "unreadable", status: "failed", attempts: 3, error: "The report email has too many MIME parts." },
      { message_id: "unsafe-name", status: "failed", attempts: 3, error: "An attachment has an unsafe file name." },
    ]);
  });

  it("refuses mail servers on this server's network, and never sends a saved password to another server", async () => {
    const input = { kind: "imap", host: "imap.example.com", port: 993, username: "reports@example.com", password: "first-password", folderId: "INBOX", folderName: "Inbox", replace: true };
    for (const host of ["localhost", "127.0.0.1", "169.254.169.254", "mail.internal.example.com"]) {
      const refused = await save({ ...input, host });
      expect(refused.status).toBe(400);
      expect((await refused.json()).error).toMatch(/on the internet|Couldn't find/);
    }
    const saved = await (await save(input)).json();
    const moved = await save({ ...input, id: saved.id, host: "imap.elsewhere.example.com", password: "" });
    expect(moved.status).toBe(400);
    expect((await moved.json()).error).toMatch(/app password/);
    const renamed = await save({ ...input, id: saved.id, username: "other@example.com", password: "" });
    expect(renamed.status).toBe(400);
    expect((await deleteRoute.DELETE(apiRequest(`${endpoint}/${saved.id}`, { method: "DELETE", cookie }), params({ organisationId: orgId, id: saved.id }))).status).toBe(200);
  });

  it("lets another admin see and remove a mailbox someone else set up, but not check or change it", async () => {
    const admin = await createTestUser("second-admin@example.com");
    await coreQuery("insert into organisation_members (organisation_id,user_id,role) values ($1,$2,'admin')", [orgId, admin.id]);
    const adminCookie = await sessionCookieFor(admin);
    const listed = await (await mailboxesRoute.GET(apiRequest(endpoint, { cookie: adminCookie }), params({ organisationId: orgId }))).json();
    const theirs = listed.mailboxes.find((mailbox: { id: string }) => mailbox.id === mailboxId);
    expect(theirs).toMatchObject({ setUpBy: actor.email, yours: false });
    const checked = await checkRoute.POST(apiRequest(`${endpoint}/${mailboxId}/check`, { method: "POST", cookie: adminCookie }), params({ organisationId: orgId, id: mailboxId }));
    expect(checked.status).toBe(403);
    expect((await save({ id: mailboxId, kind: "crm", accountId, folderId: "reports", folderName: "Reports", replace: true }, adminCookie)).status).toBe(403);
    expect((await deleteRoute.DELETE(apiRequest(`${endpoint}/${mailboxId}`, { method: "DELETE", cookie: adminCookie }), params({ organisationId: orgId, id: mailboxId }))).status).toBe(200);
    const checks = await inOrganisation(orgId, actor, (tx) => tx.query("select 1 from analytics_report_email_checks where mailbox_id=$1", [mailboxId]));
    expect(checks.rows).toEqual([]);
  });
});
