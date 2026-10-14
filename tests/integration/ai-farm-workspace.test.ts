import ExcelJS from "exceljs";
import JSZip from "jszip";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as mcpRoute from "@/app/api/mcp/route";
import { addAiFile } from "@/lib/ai-workspace/files";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { headCount, setOpenings, updateLivestockSettings } from "@/lib/livestock/movements";
import { acceptLivestockSuggestion, declineLivestockSuggestion } from "@/lib/livestock/suggestions";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { createEmployee } from "@/lib/payroll/employees";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "ai-farm";
const noContext = undefined as unknown;
type Json = Record<string, unknown>;

let rpcId = 0;
async function rpc(token: string, method: string, rpcParams?: unknown) {
  rpcId += 1;
  const response = await mcpRoute.POST(
    new Request("http://tohyee.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params: rpcParams }),
    }),
    noContext,
  );
  return (await response.json()) as Json;
}

async function call(token: string, name: string, args: Json = {}): Promise<Json> {
  const body = await rpc(token, "tools/call", { name, arguments: args });
  if (body.error) throw new Error(`rpc ${(body.error as Json).code}: ${(body.error as Json).message}`);
  const result = body.result as { content: { text: string }[]; isError?: boolean };
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text) as Json;
}

/** The AI's farm workspace (AIW1-AIW9, decision 533; not yet reviewed). */
describeWithDatabase("the AI's farm workspace", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  const tokens: Record<string, string> = {};
  const asOwner = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);

  async function makeKey(user: SessionUser, name: string, accessLevel: string) {
    const response = await tokensRoute.POST(
      apiRequest("/api/ai/tokens", { method: "POST", cookie: await sessionCookieFor(user), body: { organisationId: ORG, name, accessLevel } }),
      noContext,
    );
    tokens[name] = ((await response.json()) as { token: string }).token;
  }

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "payroll-integration-test-secret-key-32-characters";
    server = await startTestServer();
    owner = await createTestUser("farm-ai-owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    bookkeeper = await createTestUser("farm-ai-bookkeeper@example.com");
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [ORG, bookkeeper.id]);
    await asOwner((tx) =>
      tx.query("insert into payroll_access (user_id, granted_by_user_id, granted_by_email) values ($1, $1, 'test') on conflict do nothing", [owner.id]),
    );
    await asOwner((tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 5 }));
    await asOwner((tx) => updateLivestockSettings(tx, { enabled: true, firstYearStart: "2025-06-01" }));
    await asOwner((tx) => setOpenings(tx, { lines: [{ kind: "dairy_cattle", classCode: "ma_cows", head: 300, value: "750000.00" }] }));
    await makeKey(owner, "owner-drafts", "draft");
    await makeKey(owner, "owner-read", "read");
    await makeKey(bookkeeper, "bookkeeper-drafts", "draft");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("AIW1, AIW2: the AI reads and adds to the farm notebook; a look-only key can't write", async () => {
    const added = await call(tokens["owner-drafts"], "add_farm_note", { category: "goals", title: "Lift production", body: "Aim for 450 kgMS per cow by 2028.", happenedOn: "2026-06-01" });
    expect(added).toMatchObject({ category: "goals", writtenBy: "ai", title: "Lift production" });
    await call(tokens["owner-drafts"], "update_farm_note", { noteId: added.id, category: "goals", title: "Lift production", body: "Aim for 460 kgMS per cow by 2028." });
    const notes = (await call(tokens["owner-read"], "farm_notebook", { search: "kgms" })).notes as Json[];
    expect(notes.map((note) => note.body)).toEqual(["Aim for 460 kgMS per cow by 2028."]);
    await expect(call(tokens["owner-read"], "add_farm_note", { category: "goals", title: "x", body: "y" })).rejects.toThrow();
  });

  it("AIW3-AIW7: files read as text (Excel sheet by sheet), organised into a table, queried exactly and laid out as a dashboard", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Calving 2025");
    sheet.addRow(["Tag", "Calved", "Sex", "Weight kg"]);
    sheet.addRow(["101", new Date(Date.UTC(2025, 7, 1)), "F", 32.5]);
    sheet.addRow(["102", new Date(Date.UTC(2025, 7, 3)), "M", 35.25]);
    sheet.addRow(["103", new Date(Date.UTC(2025, 8, 2)), "F", 30.1]);
    const file = await asOwner(async (tx) => addAiFile(tx, { fileName: "calving.xlsx", contentBase64: Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64"), note: "From the herd app" }));
    await expect(asOwner((tx) => addAiFile(tx, { fileName: "photo.jpg", contentBase64: "AAAA" }))).rejects.toThrow(/CSV, TSV, text, JSON and Excel/);
    // Decision 534: no macro workbooks, and a workbook is checked before it's opened.
    const plain = Buffer.from(await workbook.xlsx.writeBuffer());
    await expect(asOwner((tx) => addAiFile(tx, { fileName: "calving.xlsm", contentBase64: plain.toString("base64") }))).rejects.toThrow(/CSV, TSV, text, JSON and Excel/);
    const bomb = await JSZip.loadAsync(plain);
    bomb.file("xl/media/zeros.bin", Buffer.alloc(20 * 1024 * 1024));
    const bombBytes = await bomb.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
    await expect(asOwner((tx) => addAiFile(tx, { fileName: "bomb.xlsx", contentBase64: bombBytes.toString("base64") }))).rejects.toThrow(/unsafe|limit/);
    const listed = (await call(tokens["owner-read"], "list_ai_uploads")).files as Json[];
    expect(listed.map((entry) => entry.fileName)).toEqual(["calving.xlsx"]);
    const read = await call(tokens["owner-read"], "read_ai_upload", { fileId: file.id });
    expect(read.text).toBe("## Sheet: Calving 2025\nTag,Calved,Sex,Weight kg\n101,2025-08-01,F,32.5\n102,2025-08-03,M,35.25\n103,2025-09-02,F,30.1");

    await call(tokens["owner-drafts"], "save_dataset", {
      name: "calvings",
      description: "Calves born, from calving.xlsx",
      columns: [
        { name: "tag", type: "text" },
        { name: "calved_on", type: "date" },
        { name: "sex", type: "text" },
        { name: "weight_kg", type: "number" },
      ],
    });
    await expect(call(tokens["owner-drafts"], "add_dataset_rows", { name: "calvings", rows: [{ tag: "104", calved_on: "1 Aug", sex: "F", weight_kg: "31" }] })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(call(tokens["owner-drafts"], "add_dataset_rows", { name: "calvings", rows: [{ tag: "104", colour: "red" }] })).rejects.toThrow(/isn't a column/);
    await call(tokens["owner-drafts"], "add_dataset_rows", {
      name: "calvings",
      rows: [
        { tag: "101", calved_on: "2025-08-01", sex: "F", weight_kg: "32.5" },
        { tag: "102", calved_on: "2025-08-03", sex: "M", weight_kg: 35.25 },
        { tag: "103", calved_on: "2025-09-02", sex: "F", weight_kg: "30.1" },
      ],
    });
    // 0.1 + 0.2 style sums stay exact: 32.5 + 35.25 + 30.1 = 97.85.
    const totals = await call(tokens["owner-read"], "query_dataset", {
      name: "calvings",
      groupBy: [{ field: "calved_on", grain: "month" }],
      measures: [{ aggregate: "count", label: "calves" }, { aggregate: "sum", field: "weight_kg", label: "kg" }],
    });
    expect(totals.rows).toEqual([
      { calved_on: "2025-08", calves: "2", kg: "67.75" },
      { calved_on: "2025-09", calves: "1", kg: "30.1" },
    ]);
    const heifers = await call(tokens["owner-read"], "query_dataset", { name: "calvings", filters: [{ field: "sex", op: "eq", value: "F" }, { field: "weight_kg", op: "gt", value: "31" }] });
    expect(heifers.rows).toEqual([{ tag: "101", calved_on: "2025-08-01", sex: "F", weight_kg: "32.5" }]);
    const all = await call(tokens["owner-read"], "query_dataset", { name: "calvings", measures: [{ aggregate: "sum", field: "weight_kg", label: "kg" }] });
    expect(all.rows).toEqual([{ kg: "97.85" }]);

    await expect(call(tokens["owner-drafts"], "save_ai_dashboard", { name: "Broken", tiles: [{ title: "x", kind: "column", dataset: "calvings", groupBy: ["colour"], measures: [{ aggregate: "count" }] }] })).rejects.toThrow(/Tile 1/);
    const dashboard = await call(tokens["owner-drafts"], "save_ai_dashboard", {
      name: "Calving",
      tiles: [
        { title: "Calves by month", kind: "column", dataset: "calvings", groupBy: [{ field: "calved_on", grain: "month" }], measures: [{ aggregate: "count", label: "calves" }], width: 2 },
        { title: "Total weight", kind: "kpi", dataset: "calvings", measures: [{ aggregate: "sum", field: "weight_kg", label: "kg" }] },
      ],
    });
    expect((dashboard.results as Json[]).map((result) => result.rows)).toEqual([
      [
        { calved_on: "2025-08", calves: "2" },
        { calved_on: "2025-09", calves: "1" },
      ],
      [{ kg: "97.85" }],
    ]);
  });

  it("AIW8: the AI suggests livestock movements; a person accepts (recorded with every check) or declines", async () => {
    const before = await asOwner((tx) => headCount(tx, { yearEnd: "2026-05-31" }));
    expect(before.rows.find((row) => row.classCode === "ma_cows")!.died).toBe(0);
    const suggested = (await call(tokens["owner-drafts"], "suggest_livestock_movements", {
      suggestions: [
        { movement: { movementType: "death", movementDate: "2026-01-20", kind: "dairy_cattle", classCode: "ma_cows", head: 2 }, evidence: "calving.xlsx row 7: two cows died" },
        { movement: { movementType: "sale", movementDate: "2026-03-10", kind: "dairy_cattle", classCode: "ma_cows", head: 40, amount: "44000.00" }, evidence: "Agent's sheet" },
      ],
    })).suggestions as Json[];
    expect(suggested.map((entry) => entry.decision)).toEqual([null, null]);
    // Nothing is recorded until a person accepts.
    expect((await asOwner((tx) => headCount(tx, { yearEnd: "2026-05-31" }))).rows.find((row) => row.classCode === "ma_cows")!.closing).toBe(300);
    const accepted = await asOwner((tx) => acceptLivestockSuggestion(tx, suggested[0].id, { idempotencyKey: key("accept") }));
    expect(accepted.suggestion).toMatchObject({ decision: "accepted", movementId: accepted.movement.id });
    await asOwner((tx) => declineLivestockSuggestion(tx, suggested[1].id));
    await expect(asOwner((tx) => declineLivestockSuggestion(tx, suggested[1].id))).rejects.toThrow(/already declined/);
    const count = (await call(tokens["owner-read"], "livestock_overview", { yearEnd: "2026-05-31" })).headCount as { rows: Json[] };
    expect(count.rows.find((row) => row.classCode === "ma_cows")).toMatchObject({ died: 2, sold: 0, closing: 298 });
    expect(((await call(tokens["owner-read"], "list_livestock_suggestions", { open: true })).suggestions as Json[]).length).toBe(0);
    await expect(call(tokens["owner-drafts"], "suggest_livestock_movements", { suggestions: [{ movement: { movementType: "teleport" }, evidence: "x" }] })).rejects.toThrow(/movementType/);
  });

  it("AIW9: staff with pay only for someone with payroll access; never IRD, bank or birth dates", async () => {
    await asOwner((tx) =>
      createEmployee(tx, {
        idempotencyKey: key("employee"),
        firstName: "Aroha",
        lastName: "Ngata",
        email: "aroha@example.nz",
        phone: "021 555 0123",
        postalAddress: "12 Example Street",
        dateOfBirth: "1990-02-03",
        taxCode: "M",
        irdNumber: "123456789",
        kiwiSaverStatus: "enrolled",
        kiwiSaverEmployeeRate: "4",
        kiwiSaverEmployerRate: "3.5",
        studentLoan: false,
        payFrequency: "fortnightly",
        payBasis: "salary",
        annualSalary: "70000.00",
        hourlyRate: null,
        ordinaryHoursPerWeek: null,
        startDate: "2026-04-01",
        finishDate: null,
        bankAccount: "03-1234-0123456-00",
      }),
    );
    const withPay = await call(tokens["owner-read"], "list_staff");
    expect(withPay.includesPay).toBe(true);
    expect((withPay.staff as Json[])[0]).toMatchObject({ name: "Aroha Ngata", annualSalary: "70000" });
    const text = JSON.stringify(withPay);
    for (const secret of ["123456789", "0123456", "1990-02-03"]) expect(text).not.toContain(secret);
    const noPay = await call(tokens["bookkeeper-drafts"], "list_staff");
    expect(noPay.includesPay).toBe(false);
    expect(noPay.staff).toEqual([{ name: "Aroha Ngata", jobTitle: null, startDate: "2026-04-01", finishDate: null, reportsTo: null, group: null, archived: false }]);
    expect(JSON.stringify(noPay)).not.toContain("70000");
  });
});
