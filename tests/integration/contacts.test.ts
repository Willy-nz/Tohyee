import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as contactRoute from "@/app/api/contacts/[contactId]/route";
import * as contactsRoute from "@/app/api/contacts/route";
import type { SessionUser } from "@/lib/auth/sessions";
import {
  archiveContact,
  type Contact,
  createContact,
  listContacts,
  unarchiveContact,
  updateContact,
} from "@/lib/contacts/service";
import { applyMigrations } from "@/lib/db/migrations/runner";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
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

const ORG = "contacts-co";
const noContext = undefined as unknown;

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

type AuditRow = {
  event_type: string;
  actor_user_id: string | null;
  actor_email: string | null;
  details: Record<string, unknown>;
};

describeWithDatabase("contacts (customers and suppliers)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  let outsider: SessionUser;

  const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) =>
    inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const create = (fields: { name: unknown } & Record<string, unknown>) =>
    asUser(bookkeeper, (tx) => createContact(tx, { idempotencyKey: key("contact"), ...fields }));
  const auditFor = async (contactId: string) =>
    (
      await asUser(owner, (tx) =>
        tx.query<AuditRow>(
          `select event_type, actor_user_id, actor_email, details from audit_events
            where entity_type = 'contact' and entity_id = $1
            order by id`,
          [contactId],
        ),
      )
    ).rows;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    bookkeeper = await createTestUser("bookkeeper@example.com");
    viewer = await createTestUser("viewer@example.com");
    outsider = await createTestUser("outsider@example.com");
    for (const [user, role] of [
      [bookkeeper, "bookkeeper"],
      [viewer, "viewer"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [
        ORG,
        user.id,
        role,
      ]);
    }
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("creates, edits, archives and unarchives a contact; archived contacts are hidden from the default list", async () => {
    const created = await create({
      name: "  Kōwhai Plumbing Ltd  ",
      isSupplier: true,
      email: "accounts@kowhai.example.nz",
      phone: "+64 9 555 0100",
      postalAddress: "PO Box 12\nAuckland 1140",
      gstNumber: "123-456-789",
    });
    expect(created.created).toBe(true);
    expect(created.contact).toMatchObject({
      name: "Kōwhai Plumbing Ltd",
      isCustomer: false,
      isSupplier: true,
      email: "accounts@kowhai.example.nz",
      phone: "+64 9 555 0100",
      postalAddress: "PO Box 12\nAuckland 1140",
      gstNumber: "123456789",
      isArchived: false,
    });
    const id = created.contact.id;

    // Only the fields sent change; blank optional fields are cleared.
    const edited = await asUser(bookkeeper, (tx) =>
      updateContact(tx, id, { isCustomer: true, phone: "", gstNumber: "12 345 678" }),
    );
    expect(edited).toMatchObject({
      id,
      name: "Kōwhai Plumbing Ltd",
      isCustomer: true,
      isSupplier: true,
      email: "accounts@kowhai.example.nz",
      phone: null,
      gstNumber: "12345678",
      isArchived: false,
    });

    const archived = await asUser(bookkeeper, (tx) => archiveContact(tx, id));
    expect(archived.isArchived).toBe(true);
    expect((await asUser(viewer, (tx) => listContacts(tx))).map((contact) => contact.id)).not.toContain(id);
    const everything = await asUser(viewer, (tx) => listContacts(tx, { includeArchived: true }));
    expect(everything.find((contact) => contact.id === id)).toMatchObject({ isArchived: true, isCustomer: true });

    const restored = await asUser(bookkeeper, (tx) => unarchiveContact(tx, id));
    expect(restored.isArchived).toBe(false);
    expect((await asUser(viewer, (tx) => listContacts(tx))).map((contact) => contact.id)).toContain(id);
  });

  it("searches by name or email, ignoring case; archived contacts only when asked for", async () => {
    const cafe = await create({ name: "Harbourside Café", isCustomer: true, email: "hello@harbourside.example.nz" });
    const timber = await create({ name: "Tōtara Timber", isSupplier: true, email: "orders@totaratimber.example.nz" });
    const organics = await create({ name: "100% Organics", isCustomer: true });
    const names = async (search: string, includeArchived = false) =>
      (await asUser(viewer, (tx) => listContacts(tx, { search, includeArchived }))).map((contact) => contact.name);

    expect(await names("HARBOURSIDE")).toEqual(["Harbourside Café"]);
    expect(await names("TOTARATIMBER.example")).toEqual(["Tōtara Timber"]); // matched on email
    expect(await names("%")).toEqual(["100% Organics"]); // wildcards are matched literally
    expect(await names("no-such-contact")).toEqual([]);

    await asUser(bookkeeper, (tx) => archiveContact(tx, timber.contact.id));
    expect(await names("totaratimber")).toEqual([]);
    expect(await names("totaratimber", true)).toEqual(["Tōtara Timber"]);
    expect(cafe.contact.id).not.toBe(organics.contact.id);
  });

  it("refuses an empty name, neither customer nor supplier, a bad email and a GST number with the wrong number of digits", async () => {
    const valid = { name: "Refusal Test Ltd", isCustomer: true };
    await expect(create({ ...valid, name: "" })).rejects.toThrow("name is required.");
    await expect(create({ ...valid, name: "   " })).rejects.toThrow("name is required.");
    await expect(create({ ...valid, name: "x".repeat(151) })).rejects.toThrow("name can be at most 150 characters.");
    await expect(create({ ...valid, isCustomer: false, isSupplier: false })).rejects.toThrow(
      /must be a customer, a supplier or both/,
    );
    await expect(create({ name: valid.name })).rejects.toThrow(/must be a customer, a supplier or both/);
    await expect(create({ ...valid, email: "not-an-email" })).rejects.toThrow(/valid email address/);
    await expect(create({ ...valid, email: "jo@example" })).rejects.toThrow(/valid email address/);
    await expect(create({ ...valid, gstNumber: "1234567" })).rejects.toThrow(/8 or 9 digits/);
    await expect(create({ ...valid, gstNumber: "123-456-7890" })).rejects.toThrow(/8 or 9 digits/);
    await expect(create({ ...valid, gstNumber: "GST 123456789" })).rejects.toThrow(/only digits, spaces and dashes/);
    await expect(create({ ...valid, gstNumber: 123456789 })).rejects.toThrow(/GST number must be text/);
    expect((await asUser(viewer, (tx) => listContacts(tx, { search: valid.name }))).length).toBe(0);

    // Edits are checked the same way, and a refused edit changes nothing.
    const { contact } = await create(valid);
    const edit = (fields: Record<string, unknown>) => asUser(bookkeeper, (tx) => updateContact(tx, contact.id, fields));
    await expect(edit({ name: "" })).rejects.toThrow("name is required.");
    await expect(edit({ isCustomer: false })).rejects.toThrow(/must be a customer, a supplier or both/);
    await expect(edit({ email: "still wrong@example.nz" })).rejects.toThrow(/valid email address/);
    await expect(edit({ gstNumber: "12-345" })).rejects.toThrow(/8 or 9 digits/);
    await expect(asUser(bookkeeper, (tx) => updateContact(tx, "999999", { name: "Nobody" }))).rejects.toThrow(
      "Contact not found.",
    );
    const [unchanged] = await asUser(viewer, (tx) => listContacts(tx, { search: valid.name }));
    expect(unchanged).toEqual(contact);
  });

  it("refuses a duplicate active name in any case, and unarchiving once an active contact has the same name", async () => {
    const first = await create({ name: "Harbour Traders", isCustomer: true });
    await expect(create({ name: "HARBOUR traders", isSupplier: true })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('There\'s already an active contact called "Harbour Traders"'),
    });

    // An edit can't take another active contact's name, but can change the case of its own.
    const second = await create({ name: "Kauri Supplies", isSupplier: true });
    await expect(asUser(bookkeeper, (tx) => updateContact(tx, second.contact.id, { name: " harbour TRADERS " }))).rejects.toMatchObject({
      status: 409,
    });
    const recased = await asUser(bookkeeper, (tx) => updateContact(tx, second.contact.id, { name: "KAURI SUPPLIES" }));
    expect(recased.name).toBe("KAURI SUPPLIES");

    // Archiving frees the name for a new contact...
    await asUser(bookkeeper, (tx) => archiveContact(tx, first.contact.id));
    const reused = await create({ name: "harbour traders", isCustomer: true });
    expect(reused.created).toBe(true);

    // ...so the archived one can't come back with the same name.
    await expect(asUser(bookkeeper, (tx) => unarchiveContact(tx, first.contact.id))).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/already an active contact called "harbour traders"\. Rename one of them/),
    });
    const [stillArchived] = await asUser(viewer, (tx) =>
      listContacts(tx, { search: "Harbour Traders", includeArchived: true }),
    ).then((contacts) => contacts.filter((contact) => contact.id === first.contact.id));
    expect(stillArchived.isArchived).toBe(true);

    // Renaming the archived contact first lets it be unarchived.
    await asUser(bookkeeper, (tx) => updateContact(tx, first.contact.id, { name: "Harbour Traders (old)" }));
    const restored = await asUser(bookkeeper, (tx) => unarchiveContact(tx, first.contact.id));
    expect(restored).toMatchObject({ name: "Harbour Traders (old)", isArchived: false });
  });

  it("D1/D2: the same key and content returns the same contact; the same key with different content is a 409", async () => {
    const command = { idempotencyKey: key("retry"), name: "Rimu Roofing", isCustomer: true, gstNumber: "111-222-333" };
    const first = await create(command);
    expect(first.created).toBe(true);

    // Same content once normalised (the GST number is stored as digits either way).
    const retry = await create({ ...command, gstNumber: "111 222 333" });
    expect(retry.created).toBe(false);
    expect(retry.contact).toEqual(first.contact);

    await expect(create({ ...command, name: "Rimu Roofing Ltd" })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/already used for a different contact/),
    });
    expect(await asUser(viewer, (tx) => listContacts(tx, { search: "Rimu Roofing", includeArchived: true }))).toHaveLength(1);

    // The key is checked first: a retry still returns the original after it was
    // archived and its name was given to a new contact.
    await asUser(bookkeeper, (tx) => archiveContact(tx, first.contact.id));
    await create({ name: "Rimu Roofing", isCustomer: true });
    const late = await create(command);
    expect(late).toMatchObject({ created: false, contact: { id: first.contact.id, isArchived: true } });
  });

  it("D1: a copy of the request sent while the first is still saving waits for it and returns the same contact", async () => {
    const command = { idempotencyKey: key("twin"), name: "Tawa Transport", isSupplier: true };
    let saved!: () => void;
    let release!: () => void;
    const firstSaved = new Promise<void>((resolve) => (saved = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));

    // The first request inserts the contact, then holds its transaction open.
    const first = asUser(bookkeeper, async (tx) => {
      const result = await createContact(tx, command);
      saved();
      await gate;
      return result;
    });
    await firstSaved;
    const second = create(command);
    try {
      // The copy can't see the uncommitted contact, so its insert waits on the first.
      let waiting = 0;
      for (let attempt = 0; attempt < 500 && waiting === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const result = await asUser(owner, (tx) =>
          tx.query<{ waiting: number }>(
            `select count(*)::int as waiting from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'`,
          ),
        );
        waiting = result.rows[0].waiting;
      }
      expect(waiting).toBe(1);
    } finally {
      release();
    }

    const [a, b] = await Promise.all([first, second]);
    expect(a.created).toBe(true);
    expect(b).toEqual({ created: false, contact: a.contact });
    expect(await auditFor(a.contact.id)).toHaveLength(1);
  });

  it("D1: a copy of the request whose original commits just after the copy checked its key returns the same contact", async () => {
    const command = { idempotencyKey: key("late"), name: "Kauri Couriers", isCustomer: true };
    let saved!: () => void;
    let release!: () => void;
    const firstSaved = new Promise<void>((resolve) => (saved = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));

    const first = asUser(bookkeeper, async (tx) => {
      const result = await createContact(tx, command);
      saved();
      await gate;
      return result;
    });
    await firstSaved;

    // The copy looks up its key while the first is still uncommitted, then the
    // first commits before the copy runs anything else.
    let rowsFoundByKey: number | null = null;
    const second = asUser(bookkeeper, (tx) =>
      createContact(
        {
          ...tx,
          async query<T>(sql: string, values?: readonly unknown[]) {
            const result = await tx.query<T>(sql, values);
            if (rowsFoundByKey === null && sql.includes("idempotency_key = $2")) {
              rowsFoundByKey = result.rows.length;
              release();
              await first;
            }
            return result;
          },
        },
        command,
      ),
    ).finally(release);

    const [a, b] = await Promise.all([first, second]);
    expect(rowsFoundByKey).toBe(0);
    expect(a.created).toBe(true);
    expect(b).toEqual({ created: false, contact: a.contact });
    expect(await auditFor(a.contact.id)).toHaveLength(1);
  });

  it("the audit trail records who made each change", async () => {
    const { contact } = await create({ name: "Audit Trail Ltd", isCustomer: true });
    await asUser(owner, (tx) => updateContact(tx, contact.id, { email: "ap@audittrail.example.nz" }));
    await asUser(bookkeeper, (tx) => archiveContact(tx, contact.id));
    await asUser(owner, (tx) => unarchiveContact(tx, contact.id));
    // Requests that change nothing aren't recorded.
    await asUser(owner, (tx) => unarchiveContact(tx, contact.id));
    await asUser(owner, (tx) => updateContact(tx, contact.id, { email: " ap@audittrail.example.nz " }));

    const events = await auditFor(contact.id);
    expect(events.map((event) => [event.event_type, event.actor_email, event.actor_user_id])).toEqual([
      ["contact.created", bookkeeper.email, bookkeeper.id],
      ["contact.updated", owner.email, owner.id],
      ["contact.archived", bookkeeper.email, bookkeeper.id],
      ["contact.unarchived", owner.email, owner.id],
    ]);
    expect(events[0].details).toMatchObject({ name: "Audit Trail Ltd", isCustomer: true, isSupplier: false });
    expect(events[1].details).toEqual({ changes: { email: { from: null, to: "ap@audittrail.example.nz" } } });

    // Over HTTP it's the signed-in user, whatever names the request body claims.
    const cookie = await sessionCookieFor(bookkeeper);
    const claims = { actorEmail: owner.email, actorUserId: owner.id, createdBy: "Someone Else" };
    const posted = await contactsRoute.POST(
      apiRequest("/api/contacts", {
        method: "POST",
        cookie,
        body: { organisationId: ORG, idempotencyKey: key("http"), name: "Claims Ltd", isSupplier: true, ...claims },
      }),
      noContext,
    );
    expect(posted.status).toBe(201);
    const claimed = (await body(posted)).contact as Contact;
    const patched = await contactRoute.PATCH(
      apiRequest(`/api/contacts/${claimed.id}`, {
        method: "PATCH",
        cookie,
        body: { organisationId: ORG, phone: "04 555 0123", ...claims },
      }),
      params({ contactId: claimed.id }),
    );
    expect(patched.status).toBe(200);
    expect((await auditFor(claimed.id)).map((event) => [event.event_type, event.actor_email, event.actor_user_id])).toEqual([
      ["contact.created", bookkeeper.email, bookkeeper.id],
      ["contact.updated", bookkeeper.email, bookkeeper.id],
    ]);
  });

  it("over HTTP: viewers can list but not change; bookkeepers can; non-members get 404", async () => {
    const [ownerCookie, bookkeeperCookie, viewerCookie, outsiderCookie] = await Promise.all(
      [owner, bookkeeper, viewer, outsider].map((user) => sessionCookieFor(user)),
    );
    const list = (cookie: string, query = "") =>
      contactsRoute.GET(apiRequest(`/api/contacts?organisationId=${ORG}${query}`, { cookie }), noContext);
    const post = (cookie: string, fields: Record<string, unknown>) =>
      contactsRoute.POST(apiRequest("/api/contacts", { method: "POST", cookie, body: { organisationId: ORG, ...fields } }), noContext);
    const patch = (cookie: string, contactId: string, fields: Record<string, unknown>) =>
      contactRoute.PATCH(
        apiRequest(`/api/contacts/${contactId}`, { method: "PATCH", cookie, body: { organisationId: ORG, ...fields } }),
        params({ contactId }),
      );
    const command = {
      idempotencyKey: key("http"),
      source: "ui",
      name: "Mānuka Honey Co",
      isCustomer: true,
      email: "sales@manukahoney.example.nz",
    };

    expect((await post(viewerCookie, command)).status).toBe(403);

    const created = await post(bookkeeperCookie, command);
    expect(created.status).toBe(201);
    const contact = (await body(created)).contact as Contact;
    const retried = await post(bookkeeperCookie, command);
    expect(retried.status).toBe(200);
    expect(await body(retried)).toMatchObject({ created: false, contact: { id: contact.id } });
    expect((await post(bookkeeperCookie, { ...command, name: "Different Honey Co" })).status).toBe(409);
    const refused = await post(bookkeeperCookie, { ...command, idempotencyKey: key("http"), gstNumber: "1234" });
    expect(refused.status).toBe(400);
    expect((await body(refused)).error).toMatch(/GST number must have 8 or 9 digits/);

    const viewerList = await list(viewerCookie, "&search=HONEY");
    expect(viewerList.status).toBe(200);
    expect(((await body(viewerList)).contacts as Contact[]).map((entry) => entry.id)).toEqual([contact.id]);

    expect((await patch(viewerCookie, contact.id, { phone: "021 555 0199" })).status).toBe(403);
    expect((await patch(viewerCookie, contact.id, { isArchived: true })).status).toBe(403);

    const edited = await patch(bookkeeperCookie, contact.id, { phone: "021 555 0199" });
    expect(edited.status).toBe(200);
    expect((await body(edited)).contact).toMatchObject({ id: contact.id, phone: "021 555 0199", name: "Mānuka Honey Co" });

    const archived = await patch(bookkeeperCookie, contact.id, { isArchived: true });
    expect(archived.status).toBe(200);
    expect((await body(archived)).contact).toMatchObject({ isArchived: true });
    expect(((await body(await list(viewerCookie, "&search=honey"))).contacts as Contact[]).length).toBe(0);
    const withArchived = await list(viewerCookie, "&search=honey&includeArchived=true");
    expect(((await body(withArchived)).contacts as Contact[]).map((entry) => entry.id)).toEqual([contact.id]);
    const unarchived = await patch(ownerCookie, contact.id, { isArchived: false });
    expect((await body(unarchived)).contact).toMatchObject({ isArchived: false });

    // Archiving is its own request, so it can't be mixed up with other edits.
    const mixed = await patch(bookkeeperCookie, contact.id, { isArchived: true, name: "Renamed" });
    expect(mixed.status).toBe(400);
    expect((await body(mixed)).error).toMatch(/on its own/);
    expect((await patch(bookkeeperCookie, "999999", { phone: "1" })).status).toBe(404);

    // Non-members can't tell the organisation exists; nobody signed in gets nothing.
    expect((await list(outsiderCookie)).status).toBe(404);
    expect((await post(outsiderCookie, { ...command, idempotencyKey: key("http") })).status).toBe(404);
    expect((await patch(outsiderCookie, contact.id, { isArchived: true })).status).toBe(404);
    expect((await contactsRoute.GET(apiRequest(`/api/contacts?organisationId=${ORG}`), noContext)).status).toBe(401);
  });

  it("the database itself refuses contacts that break the rules, and deleting contacts", async () => {
    const insert = (name: string, isCustomer: boolean, isSupplier: boolean, gstNumber: string | null = null) =>
      asUser(owner, (tx) =>
        tx.query(
          `insert into contacts (command_source, idempotency_key, request_hash, name, is_customer, is_supplier, gst_number)
           values ('sql', $1, 'h', $2, $3, $4, $5)`,
          [key("sql"), name, isCustomer, isSupplier, gstNumber],
        ),
      );
    await expect(insert("Raw Contact", false, false)).rejects.toThrow(/check constraint/);
    await expect(insert("Raw Contact", true, false, "123-456-789")).rejects.toThrow(/check constraint/);
    await expect(insert("", true, false)).rejects.toThrow(/check constraint/);
    await insert("Raw Contact", true, false);
    await expect(insert("RAW CONTACT", false, true)).rejects.toThrow(/duplicate key/);

    await expect(asUser(owner, (tx) => tx.query("delete from contacts"))).rejects.toThrow(
      "contacts can't be deleted; archive them instead",
    );
    // Invoices refer to contacts, so a plain truncate is refused before the trigger runs.
    await expect(asUser(owner, (tx) => tx.query("truncate contacts"))).rejects.toThrow(
      "cannot truncate a table referenced in a foreign key constraint",
    );
    await expect(asUser(owner, (tx) => tx.query("truncate contacts cascade"))).rejects.toThrow(
      "contacts can't be deleted; archive them instead",
    );
  });

  it("migration 0002 upgrades an organisation database that is still on 0001, keeping its data", async () => {
    const databaseName = `${server.coreDatabase}_org_upgrade`;
    const admin = new pg.Client({ connectionString: testDatabaseUrl! });
    await admin.connect();
    await admin.query(`create database "${databaseName}"`);
    await admin.end();

    const client = new pg.Client({ connectionString: withDb(testDatabaseUrl!, databaseName) });
    await client.connect();
    try {
      const baseline = tenantMigrations.filter((migration) => migration.version === "0001");
      expect((await applyMigrations(client, baseline, "test:upgrade")).applied).toEqual(["0001"]);
      await client.query(
        `insert into tax_codes (command_source, idempotency_key, request_hash, code, label, category, rate, effective_from)
         values ('t', 'before-0002', 'h', 'GST', 'GST', 'standard', 0.15, '2026-04-01')`,
      );

      const upgraded = await applyMigrations(client, tenantMigrations, "test:upgrade");
      expect(upgraded.applied).toContain("0002");
      expect((await client.query("select code from tax_codes")).rows).toEqual([{ code: "GST" }]);
      expect((await client.query("select count(*)::int as count from contacts")).rows).toEqual([{ count: 0 }]);
    } finally {
      await client.end();
    }
  });
});
