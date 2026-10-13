import ExcelJS from "exceljs";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import {
  createPlan,
  recordApplication,
  saveProduct,
} from "@/lib/farming/fertiliser";
import {
  addPaddock,
  saveFarm,
  setFarmingEnabled,
  splitPaddock,
} from "@/lib/farming/paddocks";
import {
  addSoilTest,
  importSoilTests,
  listSoilTests,
  paddockHistory,
  previewSoilImport,
  removeSoilTest,
  soilSummary,
} from "@/lib/farming/soil";
import { addAttachment } from "@/lib/records/extras";
import {
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

/** A lab file with a title row above the headings, units in the headings, a "<1" result and a sample on no paddock. */
const LAB_CSV = [
  "Soil analysis report,,,,,,",
  "Sample Name,Lab No,Date Sampled,pH,Olsen P (mg/L),Potassium (MAF units),Sulphate S (mg/kg)",
  "12,3456/1,15/08/2026,5.9,28,7,<1",
  "14,3456/2,15/08/2026,6.1,31,9,6",
  "99,3456/3,15/08/2026,5.5,12,4,3",
].join("\n");

/** Soil tests (#249 stage 2). Each test gets its own organisation. */
describeWithDatabase("soil tests", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("soil-owner@example.com", {
      serverAdmin: true,
    });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `soil-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) =>
      inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) => setFarmingEnabled(tx, { enabled: true }));
    const farm = (
      await as((tx) => saveFarm(tx, { name: "Kōwhai Dairies home block" }))
    )[0];
    const paddock = (name: string, effectiveHa: string) =>
      as((tx) =>
        addPaddock(tx, {
          farmId: farm.id,
          name,
          effectiveHa,
          onDate: "2026-07-01",
        }),
      );
    return {
      as,
      farm,
      twelve: await paddock("12", "20.0"),
      thirteen: await paddock("13", "18.5"),
      fourteen: await paddock("14", "15.0"),
    };
  }

  it("imports a lab's CSV with a preview: headings matched, units kept, results as reported, the same file once", async () => {
    const w = await setup();
    const preview = await w.as((tx) =>
      previewSoilImport(tx, w.farm.id, {
        fileName: "hills.csv",
        content: LAB_CSV,
        lab: "Hill Labs",
      }),
    );
    expect(
      preview.columns.map((column) => [
        column.heading,
        column.role,
        column.measure,
        column.unit,
      ]),
    ).toEqual([
      ["Sample Name", "sample", null, null],
      ["Lab No", "labReference", null, null],
      ["Date Sampled", "date", null, null],
      ["pH", "measure", "pH", null],
      ["Olsen P (mg/L)", "measure", "Olsen P", "mg/L"],
      ["Potassium (MAF units)", "measure", "Potassium", "MAF units"],
      ["Sulphate S (mg/kg)", "measure", "Sulphate sulphur", "mg/kg"],
    ]);
    // With no paddock column, the sample name is matched to the paddock.
    expect(
      preview.rows.map((row) => [
        row.line,
        row.paddock,
        row.sampledOn,
        row.results,
        row.error,
      ]),
    ).toEqual([
      [3, "12", "2026-08-15", 4, null],
      [4, "14", "2026-08-15", 4, null],
      [5, "99", "2026-08-15", 4, "There's no current paddock 99 on this farm."],
    ]);
    expect(preview.counts).toEqual({ tests: 2, errors: 1 });
    expect(
      await w.as((tx) => listSoilTests(tx, { farmId: w.farm.id })),
    ).toEqual([]);

    const tests = await w.as((tx) =>
      importSoilTests(tx, w.farm.id, {
        fileName: "hills.csv",
        content: LAB_CSV,
        lab: "Hill Labs",
      }),
    );
    const twelve = tests.find((test) => test.paddockName === "12")!;
    expect(twelve).toMatchObject({
      sampledOn: "2026-08-15",
      sampleName: "12",
      lab: "Hill Labs",
      labReference: "3456/1",
      source: "Imported from hills.csv",
    });
    expect(twelve.results).toEqual([
      { measure: "pH", value: "5.9", valueText: "5.9", unit: null },
      { measure: "Olsen P", value: "28", valueText: "28", unit: "mg/L" },
      { measure: "Potassium", value: "7", valueText: "7", unit: "MAF units" },
      // Below the detection limit: kept as the lab wrote it, with no number.
      {
        measure: "Sulphate sulphur",
        value: null,
        valueText: "<1",
        unit: "mg/kg",
      },
    ]);
    await expect(
      w.as((tx) =>
        importSoilTests(tx, w.farm.id, {
          fileName: "again.csv",
          content: LAB_CSV,
        }),
      ),
    ).rejects.toThrow("already imported");

    // The summary shows each current paddock's latest test; 13 has none. No thresholds.
    const summary = await w.as((tx) => soilSummary(tx, { farmId: w.farm.id }));
    expect(summary.measures).toEqual([
      "pH",
      "Olsen P",
      "Potassium",
      "Sulphate sulphur",
    ]);
    expect(
      summary.paddocks.map((row) => [
        row.paddockName,
        row.lastSampledOn,
        row.tests,
        row.latest["Olsen P"]?.valueText ?? null,
      ]),
    ).toEqual([
      ["12", "2026-08-15", 1, "28"],
      ["13", null, 0, null],
      ["14", "2026-08-15", 1, "31"],
    ]);
  });

  it("lets the column choices be changed, takes a date for the whole file, and reads Excel workbooks", async () => {
    const w = await setup();
    const csv = "Paddock,Olsen P,Notes\n13,22,dry\n";
    const first = await w.as((tx) =>
      previewSoilImport(tx, w.farm.id, { fileName: "mine.csv", content: csv }),
    );
    expect(first.columns.map((column) => column.role)).toEqual([
      "paddock",
      "measure",
      "measure",
    ]);
    expect(first.rows[0].error).toBe(
      "There's no date sampled. Choose the date column, or enter the date for the whole file.",
    );
    const columns = first.columns.map((column) =>
      column.heading === "Notes"
        ? { ...column, role: "ignore" }
        : column.heading === "Olsen P"
          ? { ...column, unit: "mg/L" }
          : column,
    );
    const second = await w.as((tx) =>
      previewSoilImport(tx, w.farm.id, {
        fileName: "mine.csv",
        content: csv,
        columns,
        sampledOn: "2026-09-01",
      }),
    );
    expect(second.rows).toEqual([
      {
        line: 2,
        paddock: "13",
        sampledOn: "2026-09-01",
        sampleName: null,
        results: 1,
        error: null,
      },
    ]);
    await expect(
      w.as((tx) =>
        previewSoilImport(tx, w.farm.id, {
          fileName: "mine.csv",
          content: csv,
          columns: columns.map(() => ({ role: "paddock" })),
        }),
      ),
    ).rejects.toThrow("Only one column can be the paddock.");

    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Results").addRows([
      ["Paddock", "Date", "pH", "CEC (me/100g)"],
      ["12", "2026-09-20", 6.2, 14],
    ]);
    const contentBase64 = Buffer.from(
      await workbook.xlsx.writeBuffer(),
    ).toString("base64");
    const tests = await w.as((tx) =>
      importSoilTests(tx, w.farm.id, { fileName: "lab.xlsx", contentBase64 }),
    );
    expect(tests[0]).toMatchObject({
      paddockName: "12",
      sampledOn: "2026-09-20",
    });
    expect(
      tests[0].results.map((result) => [
        result.measure,
        result.valueText,
        result.unit,
      ]),
    ).toEqual([
      ["pH", "6.2", null],
      ["CEC", "14", "me/100g"],
    ]);
    await expect(
      w.as((tx) =>
        previewSoilImport(tx, w.farm.id, {
          fileName: "lab.xls",
          contentBase64,
        }),
      ),
    ).rejects.toThrow("Only .xlsx workbooks");
  });

  it("enters a test by hand, attaches the lab report, shows the paddock's history, and keeps it through a split", async () => {
    const w = await setup();
    await expect(
      w.as((tx) =>
        addSoilTest(tx, {
          paddockId: w.fourteen.id,
          sampledOn: "2026-08-15",
          results: [],
        }),
      ),
    ).rejects.toThrow("at least one result");
    await expect(
      w.as((tx) =>
        addSoilTest(tx, {
          paddockId: w.fourteen.id,
          sampledOn: "2026-08-15",
          results: [
            { measure: "olsen p", value: "30" },
            { measure: "Olsen P", value: "31" },
          ],
        }),
      ),
    ).rejects.toThrow("Olsen P appears twice.");
    const test = await w.as((tx) =>
      addSoilTest(tx, {
        paddockId: w.fourteen.id,
        sampledOn: "2026-08-15",
        lab: "ARL",
        depth: "0-75 mm",
        results: [
          { measure: "olsen p", value: "30", unit: "mg/L" },
          { measure: "Organic matter", value: "9.8", unit: "%" },
        ],
      }),
    );
    expect(test.results.map((result) => result.measure)).toEqual([
      "Olsen P",
      "Organic matter",
    ]);
    const added = await w.as((tx) =>
      addAttachment(tx, "owner", "soil-test", test.id, {
        idempotencyKey: key("file"),
        fileName: "ARL report.pdf",
        content: Buffer.from("%PDF-1.4\n% lab report\n"),
      }),
    );
    expect(added.attachment).toMatchObject({ fileName: "ARL report.pdf" });

    const urea = (
      await w.as((tx) => saveProduct(tx, { name: "Urea", nPct: "46" }))
    )[0];
    const plan = await w.as((tx) =>
      createPlan(tx, { farmId: w.farm.id, name: "Spring urea 2026" }),
    );
    await w.as((tx) =>
      recordApplication(tx, plan.id, {
        paddockId: w.fourteen.id,
        productId: urea.id,
        appliedOn: "2026-09-15",
        tonnes: "1.4",
      }),
    );
    const history = await w.as((tx) => paddockHistory(tx, w.fourteen.id));
    expect(history.applications).toEqual([
      expect.objectContaining({
        planName: "Spring urea 2026",
        productName: "Urea",
        appliedOn: "2026-09-15",
        tonnes: "1.400",
        treatedHa: "15.00",
      }),
    ]);
    expect(
      history.soilTests.map((entry) => [
        entry.sampledOn,
        entry.lab,
        entry.depth,
      ]),
    ).toEqual([["2026-08-15", "ARL", "0-75 mm"]]);

    // FB7: after a split, the test stays on 14; 14A and 14B start with none.
    await w.as((tx) =>
      splitPaddock(tx, w.fourteen.id, {
        onDate: "2026-11-01",
        parts: [
          { name: "14A", effectiveHa: "9.0" },
          { name: "14B", effectiveHa: "6.0" },
        ],
      }),
    );
    expect(
      (await w.as((tx) => paddockHistory(tx, w.fourteen.id))).soilTests,
    ).toHaveLength(1);
    const summary = await w.as((tx) => soilSummary(tx, { farmId: w.farm.id }));
    expect(summary.paddocks.map((row) => [row.paddockName, row.tests])).toEqual(
      [
        ["12", 0],
        ["13", 0],
        ["14A", 0],
        ["14B", 0],
      ],
    );
    await expect(
      w.as((tx) =>
        addSoilTest(tx, {
          paddockId: w.fourteen.id,
          sampledOn: "2026-12-01",
          results: [{ measure: "pH", value: "6" }],
        }),
      ),
    ).rejects.toThrow("14 is retired.");

    await w.as((tx) => removeSoilTest(tx, test.id));
    expect(
      (await w.as((tx) => paddockHistory(tx, w.fourteen.id))).soilTests,
    ).toEqual([]);
    await expect(w.as((tx) => removeSoilTest(tx, test.id))).rejects.toThrow(
      "wasn't found",
    );
  });
});
