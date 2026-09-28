import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as attachmentRoute from "@/app/api/records/[recordType]/[recordId]/attachments/[attachmentId]/route";
import * as attachmentsRoute from "@/app/api/records/[recordType]/[recordId]/attachments/route";
import * as noteRoute from "@/app/api/records/[recordType]/[recordId]/notes/[noteId]/route";
import * as notesRoute from "@/app/api/records/[recordType]/[recordId]/notes/route";
import * as recordRoute from "@/app/api/records/[recordType]/[recordId]/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { approveBill, createBill } from "@/lib/bills/service";
import { createContact } from "@/lib/contacts/service";
import { applyCreditNote } from "@/lib/credit-notes/applications";
import { approveCreditNote, createCreditNote } from "@/lib/credit-notes/service";
import { applyMigrations } from "@/lib/db/migrations/runner";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import { coreQuery } from "@/lib/db/transactions";
import { recordPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, deleteInvoice } from "@/lib/invoices/service";
import { postJournal } from "@/lib/ledger/journals";
import type { RecordExtras, RecordNote } from "@/lib/records/types";
import { createTaxCode } from "@/lib/tax/codes";
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
  testDatabaseUrl,
  type TestServer,
  withDb,
} from "../helpers/test-server";

const PDF_HEAD = "%PDF-1.7\n%âãÏÓ\n";

/** A PDF-looking file of `size` bytes. */
function pdfBytes(size: number, fill = 0x41): Uint8Array {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set(Buffer.from(PDF_HEAD, "latin1"));
  return bytes;
}

async function body<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/**
 * Examples NF1-NF14 in docs/ACCOUNTING-EXAMPLES.md ("Notes, files and
 * history"). Jess and Bo are bookkeepers, Ana an admin and Vic a viewer.
 */
describeWithDatabase("notes, files and history", () => {
  let server: TestServer;
  let owner: SessionUser;
  let jess: SessionUser;
  let bo: SessionUser;
  let ana: SessionUser;
  let vic: SessionUser;
  const cookies = new Map<string, string>();
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("nf-owner@example.com", { serverAdmin: true });
    jess = await createTestUser("jess@example.com");
    bo = await createTestUser("bo@example.com");
    ana = await createTestUser("ana@example.com");
    vic = await createTestUser("vic@example.com");
    for (const user of [owner, jess, bo, ana, vic]) cookies.set(user.email, await sessionCookieFor(user));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `nf-${organisations}-co`;
    await createTestOrganisation(owner, org);
    for (const [user, role] of [
      [jess, "bookkeeper"],
      [bo, "bookkeeper"],
      [ana, "admin"],
      [vic, "viewer"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [org, user.id, role]);
    }
    const as = <T>(user: SessionUser, work: Parameters<typeof inOrganisation<T>>[2]) =>
      inOrganisation(org, { userId: user.id, email: user.email }, work);
    await as(owner, (tx) =>
      createTaxCode(tx, { idempotencyKey: key("tax"), code: "GST", label: "GST", category: "standard", rate: "0.15", effectiveFrom: "2026-01-01" }),
    );
    const kobe = (await as(jess, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kobe Ltd", isCustomer: true }))).contact;
    const paw = (await as(jess, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Paw Supplies", isSupplier: true }))).contact;
    const draftInvoice = async () =>
      (
        await as(jess, (tx) =>
          createInvoice(tx, {
            idempotencyKey: key("invoice"),
            contactId: kobe.id,
            invoiceDate: "2026-04-10",
            dueDate: "2026-05-10",
            amountsMode: "exclusive",
            lines: [{ description: "Consulting", quantity: "1", unitPrice: "100.00", accountCode: "4000", taxCode: "GST" }],
          }),
        )
      ).invoice;

    const call = async (
      user: SessionUser,
      handler: (request: Request, context: never) => Promise<Response>,
      path: string,
      routeParams: Record<string, string>,
      options: { method?: string; body?: unknown } = {},
    ) => handler(apiRequest(path, { cookie: cookies.get(user.email), ...options }), params(routeParams) as never);

    const record = (type: string, id: string) => ({ recordType: type, recordId: id });
    const extras = async (user: SessionUser, type: string, id: string) => {
      const response = await call(user, recordRoute.GET, `/api/records/${type}/${id}?organisationId=${org}`, record(type, id));
      return { status: response.status, data: await body<RecordExtras & { error?: string }>(response) };
    };
    const addNote = (user: SessionUser, type: string, id: string, text: unknown, idempotencyKey = key("note")) =>
      call(user, notesRoute.POST, `/api/records/${type}/${id}/notes`, record(type, id), {
        method: "POST",
        body: { organisationId: org, idempotencyKey, body: text },
      });
    const editNote = (user: SessionUser, type: string, id: string, note: RecordNote, text: string, version = note.version) =>
      call(user, noteRoute.PATCH, `/api/records/${type}/${id}/notes/${note.id}`, { ...record(type, id), noteId: note.id }, {
        method: "PATCH",
        body: { organisationId: org, body: text, version },
      });
    const deleteNoteAs = (user: SessionUser, type: string, id: string, note: RecordNote, version = note.version) =>
      call(user, noteRoute.DELETE, `/api/records/${type}/${id}/notes/${note.id}`, { ...record(type, id), noteId: note.id }, {
        method: "DELETE",
        body: { organisationId: org, version },
      });
    const upload = async (
      user: SessionUser,
      type: string,
      id: string,
      fileName: string,
      content: Uint8Array,
      idempotencyKey = key("file"),
    ) => {
      const form = new FormData();
      form.set("organisationId", org);
      form.set("idempotencyKey", idempotencyKey);
      form.set("file", new File([new Uint8Array(content)], fileName));
      // Encode the form as a browser would, with its length.
      const encoded = new Response(form);
      const bytes = new Uint8Array(await encoded.arrayBuffer());
      const request = new Request(`http://tohyee.test/api/records/${type}/${id}/attachments`, {
        method: "POST",
        headers: {
          cookie: cookies.get(user.email)!,
          origin: "http://tohyee.test",
          "content-type": encoded.headers.get("content-type")!,
          "content-length": String(bytes.length),
        },
        body: bytes,
      });
      return attachmentsRoute.POST(request, params(record(type, id)) as never);
    };
    const download = (user: SessionUser, type: string, id: string, attachmentId: string) =>
      call(user, attachmentRoute.GET, `/api/records/${type}/${id}/attachments/${attachmentId}?organisationId=${org}`, {
        ...record(type, id),
        attachmentId,
      });
    const removeFile = (user: SessionUser, type: string, id: string, attachmentId: string) =>
      call(user, attachmentRoute.DELETE, `/api/records/${type}/${id}/attachments/${attachmentId}`, { ...record(type, id), attachmentId }, {
        method: "DELETE",
        body: { organisationId: org },
      });
    return { org, as, kobe, paw, draftInvoice, extras, addNote, editNote, deleteNoteAs, upload, download, removeFile };
  }

  it("NF1-NF3: a bookkeeper adds a note; retries return it; empty and over-long notes are refused", async () => {
    const world = await setup();
    const invoice = await world.draftInvoice();
    const idempotencyKey = key("note");
    const added = await world.addNote(jess, "invoice", invoice.id, "  Customer asked for 14-day terms ", idempotencyKey);
    expect(added.status).toBe(201);
    const { note } = await body<{ note: RecordNote }>(added);
    expect(note).toMatchObject({ body: "Customer asked for 14-day terms", version: 1, createdByEmail: "jess@example.com", canChange: true });

    const retried = await world.addNote(jess, "invoice", invoice.id, "Customer asked for 14-day terms", idempotencyKey);
    expect(retried.status).toBe(200);
    expect((await body<{ note: RecordNote }>(retried)).note.id).toBe(note.id);
    const reused = await world.addNote(jess, "invoice", invoice.id, "Something else", idempotencyKey);
    expect(reused.status).toBe(409);

    expect((await world.addNote(jess, "invoice", invoice.id, "   ")).status).toBe(400);
    const tooLong = await world.addNote(jess, "invoice", invoice.id, "x".repeat(5001));
    expect(tooLong.status).toBe(400);
    expect((await body(tooLong)).error).toMatch(/at most 5,000 characters/);
    expect((await world.addNote(jess, "invoice", invoice.id, "x".repeat(5000))).status).toBe(201);

    const { data } = await world.extras(vic, "invoice", invoice.id);
    expect(data.notes.map((entry) => entry.body.slice(0, 20))).toEqual(["Customer asked for 1", "xxxxxxxxxxxxxxxxxxxx"]);
    expect(data.canAdd).toBe(false);
    expect(data.notes.every((entry) => !entry.canChange)).toBe(true);
    expect(data.history.filter((entry) => entry.eventType === "note.added")).toHaveLength(2);
    // Nothing posted: the draft is unchanged.
    const invoiceNow = await world.as(owner, (tx) =>
      tx.query<{ status: string; total: string }>("select status, total::text from sales_invoices where id = $1", [invoice.id]),
    );
    expect(invoiceNow.rows[0]).toEqual({ status: "draft", total: "115.00" });
  });

  it("NF4-NF6: the author or an admin edits and deletes a note; the history keeps the old text", async () => {
    const world = await setup();
    const invoice = await world.draftInvoice();
    const { note } = await body<{ note: RecordNote }>(await world.addNote(jess, "invoice", invoice.id, "Customer asked for 14-day terms"));

    const edited = await world.editNote(jess, "invoice", invoice.id, note, "Customer asked for 20-day terms");
    expect(edited.status).toBe(200);
    const after = (await body<{ note: RecordNote }>(edited)).note;
    expect(after).toMatchObject({ body: "Customer asked for 20-day terms", version: 2, updatedByEmail: "jess@example.com" });

    const stale = await world.editNote(jess, "invoice", invoice.id, note, "Old version", 1);
    expect(stale.status).toBe(409);
    expect((await body(stale)).error).toBe("This note was changed by someone else. Reload and try again.");

    const other = await world.editNote(bo, "invoice", invoice.id, after, "Bo's change");
    expect(other.status).toBe(403);
    expect((await body(other)).error).toBe("Only the person who wrote a note, or an admin, can change it.");
    expect((await world.editNote(vic, "invoice", invoice.id, after, "Vic's change")).status).toBe(403);
    expect((await world.deleteNoteAs(bo, "invoice", invoice.id, after)).status).toBe(403);

    const byAdmin = await world.editNote(ana, "invoice", invoice.id, after, "Customer asked for 30-day terms");
    expect(byAdmin.status).toBe(200);
    const latest = (await body<{ note: RecordNote }>(byAdmin)).note;
    expect((await world.deleteNoteAs(ana, "invoice", invoice.id, latest)).status).toBe(200);

    const { data } = await world.extras(jess, "invoice", invoice.id);
    expect(data.notes).toEqual([]);
    const noteHistory = data.history
      .filter((entry) => entry.eventType.startsWith("note."))
      .map((entry) => [entry.summary, entry.actorEmail, entry.noteBefore, entry.noteAfter]);
    expect(noteHistory).toEqual([
      ["Note added", "jess@example.com", null, "Customer asked for 14-day terms"],
      ["Note edited", "jess@example.com", "Customer asked for 14-day terms", "Customer asked for 20-day terms"],
      ["Note edited", "ana@example.com", "Customer asked for 20-day terms", "Customer asked for 30-day terms"],
      ["Note deleted", "ana@example.com", "Customer asked for 30-day terms", null],
    ]);
    // The database keeps deleted notes and refuses to change them.
    await expect(
      world.as(owner, (tx) => tx.query("update record_notes set body = 'x', version = version + 1 where id = $1", [note.id])),
    ).rejects.toThrow("A deleted note can't be changed");
    await expect(world.as(owner, (tx) => tx.query("delete from record_notes where id = $1", [note.id]))).rejects.toThrow(
      /can't be removed from the database/,
    );
  });

  it("NF7, NF9, NF10: a file is attached, downloaded as the same bytes, retried, and removed", async () => {
    const world = await setup();
    const bill = await world.as(jess, async (tx) => {
      const { bill: draft } = await createBill(tx, {
        idempotencyKey: key("bill"),
        contactId: world.paw.id,
        billDate: "2026-04-12",
        dueDate: "2026-05-12",
        supplierInvoiceNumber: "S-1",
        amountsMode: "exclusive",
        lines: [{ description: "Stationery", quantity: "1", unitPrice: "200.00", accountCode: "6010", taxCode: "GST" }],
      });
      return (await approveBill(tx, draft.id, { idempotencyKey: key("approve") })).bill;
    });
    const content = pdfBytes(250 * 1024);
    const idempotencyKey = key("file");
    const added = await world.upload(jess, "bill", bill.id, "receipt.pdf", content, idempotencyKey);
    expect(added.status).toBe(201);
    const { attachment } = await body<{ attachment: RecordExtras["attachments"][number] }>(added);
    expect(attachment).toMatchObject({
      fileName: "receipt.pdf",
      contentType: "application/pdf",
      byteSize: 256000,
      createdByEmail: "jess@example.com",
      canRemove: true,
    });

    const file = await world.download(vic, "bill", bill.id, attachment.id);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/pdf");
    expect(file.headers.get("content-disposition")).toBe(`inline; filename="receipt.pdf"; filename*=UTF-8''receipt.pdf`);
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await file.arrayBuffer()).equals(Buffer.from(content))).toBe(true);

    const retried = await world.upload(jess, "bill", bill.id, "receipt.pdf", content, idempotencyKey);
    expect(retried.status).toBe(200);
    expect((await body<{ attachment: { id: string } }>(retried)).attachment.id).toBe(attachment.id);
    expect((await world.upload(jess, "bill", bill.id, "receipt.pdf", pdfBytes(1000), idempotencyKey)).status).toBe(409);
    expect((await world.upload(vic, "bill", bill.id, "receipt.pdf", content)).status).toBe(403);

    expect((await world.removeFile(bo, "bill", bill.id, attachment.id)).status).toBe(403);
    expect((await world.removeFile(vic, "bill", bill.id, attachment.id)).status).toBe(403);
    expect((await world.removeFile(jess, "bill", bill.id, attachment.id)).status).toBe(200);
    expect((await world.download(jess, "bill", bill.id, attachment.id)).status).toBe(404);
    expect((await world.removeFile(jess, "bill", bill.id, attachment.id)).status).toBe(404);

    const { data } = await world.extras(jess, "bill", bill.id);
    expect(data.attachments).toEqual([]);
    expect(data.history.filter((entry) => entry.eventType.startsWith("attachment.")).map((entry) => [entry.summary, entry.actorEmail])).toEqual([
      ["File added: receipt.pdf (250 KB)", "jess@example.com"],
      ["File removed: receipt.pdf (250 KB)", "jess@example.com"],
    ]);
    // The contents are gone from the database; the row stays.
    const stored = await world.as(owner, (tx) =>
      tx.query<{ content: Buffer | null; file_name: string }>("select content, file_name from record_attachments where id = $1", [attachment.id]),
    );
    expect(stored.rows[0]).toEqual({ content: null, file_name: "receipt.pdf" });
    await expect(
      world.as(owner, (tx) => tx.query("update record_attachments set file_name = 'x.pdf' where id = $1", [attachment.id])),
    ).rejects.toThrow("Files can't be changed, only removed once");

    // An admin can remove a file someone else added.
    const second = await body<{ attachment: { id: string } }>(await world.upload(jess, "bill", bill.id, "second.pdf", pdfBytes(100)));
    expect((await world.removeFile(ana, "bill", bill.id, second.attachment.id)).status).toBe(200);
  });

  it("NF8: wrong types, empty and over-10 MB files, mismatched contents and a 101st file are refused", async () => {
    const world = await setup();
    const kobe = world.kobe.id;
    const refused = async (fileName: string, content: Uint8Array, message: RegExp) => {
      const response = await world.upload(jess, "contact", kobe, fileName, content);
      expect(response.status, fileName).toBe(400);
      expect((await body(response)).error, fileName).toMatch(message);
    };
    await refused("big.pdf", pdfBytes(11 * 1024 * 1024), /at most 10 MB/);
    await refused("empty.pdf", new Uint8Array(0), /empty/);
    await refused("notes.txt", Buffer.from("hello"), /only PDF, JPG, PNG, HEIC, Word/);
    await refused("setup.exe", Buffer.from("MZ\u0090\u0000"), /only PDF, JPG, PNG, HEIC, Word/);
    await refused("photo.png", pdfBytes(100), /doesn't look like a PNG file/);
    expect((await world.upload(jess, "contact", kobe, "ten.pdf", pdfBytes(10 * 1024 * 1024))).status).toBe(201);

    await world.as(owner, async (tx) => {
      for (let index = 2; index <= 100; index += 1) {
        await tx.query(
          `insert into record_attachments (command_source, idempotency_key, request_hash, record_type, record_id, file_name,
                                           content_type, byte_size, sha256, content, created_by_email)
           values ('test', $1, 'h', 'contact', $2, $3, 'application/pdf', 5, repeat('0', 64), '%PDF-'::bytea, 'jess@example.com')`,
          [key("bulk"), kobe, `file-${index}.pdf`],
        );
      }
    });
    await refused("one-too-many.pdf", pdfBytes(100), /at most 100 files/);
  });

  it("NF11: an invoice's history lists its own events, payments, credit applied and notes in order", async () => {
    const world = await setup();
    const draft = await world.draftInvoice();
    const invoice = (await world.as(jess, (tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("approve") }))).invoice;
    await world.as(jess, (tx) =>
      recordPayment(tx, invoice.id, { idempotencyKey: key("pay"), paymentDate: "2026-04-20", amount: "50.00", bankAccountCode: "1000" }),
    );
    await world.as(jess, async (tx) => {
      const { creditNote } = await createCreditNote(tx, {
        idempotencyKey: key("cn"),
        contactId: world.kobe.id,
        creditNoteDate: "2026-04-21",
        amountsMode: "exclusive",
        lines: [{ description: "Discount", quantity: "1", unitPrice: "20.00", accountCode: "4000", taxCode: "GST" }],
      });
      const approved = (await approveCreditNote(tx, creditNote.id, { idempotencyKey: key("approve") })).creditNote;
      await applyCreditNote(tx, approved.id, {
        idempotencyKey: key("apply"),
        applicationDate: "2026-04-22",
        applications: [{ invoiceId: invoice.id, amount: "23.00" }],
      });
    });
    await world.addNote(jess, "invoice", invoice.id, "Customer asked for 14-day terms");
    const { data } = await world.extras(vic, "invoice", invoice.id);
    expect(data.history.map((entry) => [entry.summary, entry.actorEmail])).toEqual([
      ["Invoice created", "jess@example.com"],
      ["Invoice approved", "jess@example.com"],
      ["Payment recorded: 50.00", "jess@example.com"],
      ["Credit applied: 23.00 from CN-0001", "jess@example.com"],
      ["Note added", "jess@example.com"],
    ]);
  });

  it("NF12: deleting a draft deletes its notes and files", async () => {
    const world = await setup();
    const draft = await world.draftInvoice();
    await world.addNote(jess, "invoice", draft.id, "Draft note");
    const { attachment } = await body<{ attachment: { id: string } }>(await world.upload(jess, "invoice", draft.id, "quote.pdf", pdfBytes(100)));
    await world.as(jess, (tx) => deleteInvoice(tx, draft.id));
    const left = await world.as(owner, async (tx) => ({
      notes: (await tx.query("select deleted_at is not null as deleted from record_notes where record_id = $1 and record_type = 'sales_invoice'", [draft.id])).rows,
      files: (await tx.query("select content is null as emptied from record_attachments where id = $1", [attachment.id])).rows,
    }));
    expect(left).toEqual({ notes: [{ deleted: true }], files: [{ emptied: true }] });
    expect((await world.extras(jess, "invoice", draft.id)).status).toBe(404);
  });

  it("NF13, NF14: contacts and journals have notes and files; missing records and unknown types are refused", async () => {
    const world = await setup();
    expect((await world.addNote(jess, "contact", world.kobe.id, "Prefers email")).status).toBe(201);
    const journal = await world.as(jess, (tx) =>
      postJournal(tx, {
        idempotencyKey: key("journal"),
        postingDate: "2026-04-24",
        reference: "Board-approved write-off",
        lines: [
          { accountCode: "6010", debitAmount: "5.00" },
          { accountCode: "1000", creditAmount: "5.00" },
        ],
      }),
    );
    const journalId = journal.journal.id;
    expect((await world.upload(jess, "journal", journalId, "minute.pdf", pdfBytes(100))).status).toBe(201);
    const journalExtras = await world.extras(vic, "journal", journalId);
    expect(journalExtras.data.attachments.map((file) => file.fileName)).toEqual(["minute.pdf"]);
    expect(journalExtras.data.history.map((entry) => entry.summary)).toEqual(["Journal posted", "File added: minute.pdf (100 bytes)"]);
    expect((await world.extras(vic, "contact", world.kobe.id)).data.notes.map((note) => note.body)).toEqual(["Prefers email"]);

    const missing = await world.addNote(jess, "invoice", "999999", "Nobody home");
    expect(missing.status).toBe(404);
    expect((await body(missing)).error).toBe("Invoice not found.");
    const unknown = await world.extras(jess, "payslip", "1");
    expect(unknown.status).toBe(400);
  });

  it("migration 0013 upgrades an organisation database on 0012 with the notes and files tables", async () => {
    const databaseName = `${server.coreDatabase}_org_upgrade_extras`;
    const admin = new pg.Client({ connectionString: testDatabaseUrl! });
    await admin.connect();
    await admin.query(`create database "${databaseName}"`);
    await admin.end();
    const client = new pg.Client({ connectionString: withDb(testDatabaseUrl!, databaseName) });
    await client.connect();
    try {
      await applyMigrations(client, tenantMigrations.filter((migration) => migration.version <= "0012"), "test:upgrade");
      expect((await applyMigrations(client, tenantMigrations.filter((migration) => migration.version <= "0013"), "test:upgrade")).applied).toEqual(["0013"]);
      const tables = await client.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_name in ('record_notes', 'record_attachments') order by table_name",
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual(["record_attachments", "record_notes"]);
    } finally {
      await client.end();
    }
  });
});
