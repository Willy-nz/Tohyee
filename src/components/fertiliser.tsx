"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import type { ApplicationImportPreview, FertiliserProduct, LinkableBillLine, PlanReport, PlanSummary } from "@/lib/farming/fertiliser";
import type { Farm, Paddock } from "@/lib/farming/paddocks";
import { formatDate, formatMoney, todayInBrowser } from "@/lib/format";

/**
 * Fertiliser plans (#249 stage 2, examples FB1-FB8): products, plans in
 * versions, linking the bills that bought and spread it, recording or
 * importing what was applied, and planned against actual by paddock.
 * Nothing here posts: the bills already did.
 */

function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(action: () => Promise<T>, done?: (result: T) => void) {
    setBusy(true);
    setError(null);
    try {
      done?.(await action());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

export function FertiliserHome({ organisationId, planId }: { organisationId: string; planId: string | null }) {
  const farms = useApiData<{ farms: Farm[] }>("/api/farming/farms", { organisationId });
  const [farmId, setFarmId] = useState<string | null>(null);
  if (farms.error) return <Notice tone="error">{farms.error}</Notice>;
  if (!farms.data) return <p className={ui.muted}>Loading…</p>;
  if (planId) return <PlanView organisationId={organisationId} planId={planId} />;
  const active = farms.data.farms.filter((farm) => farm.isActive);
  const farm = active.find((entry) => entry.id === farmId) ?? active[0] ?? null;
  if (!farm) {
    return (
      <Empty>
        Add your farm and its paddocks first, under <Link href="/operations/farming">Farms and paddocks</Link>.
      </Empty>
    );
  }
  return (
    <>
      {active.length > 1 ? (
        <div className={ui.tabs} role="tablist" aria-label="Farms">
          {active.map((entry) => (
            <button key={entry.id} type="button" role="tab" aria-selected={entry.id === farm.id} className={`${ui.tab} ${entry.id === farm.id ? ui.tabActive : ""}`} onClick={() => setFarmId(entry.id)}>
              {entry.name}
            </button>
          ))}
        </div>
      ) : null}
      <PlanList key={farm.id} organisationId={organisationId} farm={farm} />
      <Products organisationId={organisationId} />
    </>
  );
}

function PlanList({ organisationId, farm }: { organisationId: string; farm: Farm }) {
  const { can } = useWorkspace();
  const router = useRouter();
  const plans = useApiData<{ plans: PlanSummary[] }>(`/api/farming/farms/${farm.id}/plans`, { organisationId });
  const [name, setName] = useState("");
  const { busy, error, run } = useRun();
  return (
    <Card title={`Fertiliser plans for ${farm.name}`} description="A plan is a budget: what goes on which paddock, at what rate and price. It posts nothing. Each change is saved as a new version.">
      {plans.error ? <Notice tone="error">{plans.error}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {plans.data && plans.data.plans.length === 0 ? <Empty>No plans yet.</Empty> : null}
      {plans.data && plans.data.plans.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Plan</th>
                <th>Latest version</th>
                <th>Added</th>
              </tr>
            </thead>
            <tbody>
              {plans.data.plans.map((plan) => (
                <tr key={plan.id}>
                  <td data-label="Plan">
                    <Link href={`/operations/farming/fertiliser?plan=${plan.id}`}>
                      <strong>{plan.name}</strong>
                    </Link>
                  </td>
                  <td data-label="Latest version">{plan.latestVersion ? `Version ${plan.latestVersion}` : <span className={ui.muted}>No lines yet</span>}</td>
                  <td data-label="Added">{formatDate(plan.createdAt.slice(0, 10))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {can("bookkeeper") ? (
        <div className={ui.inlineForm}>
          <Field label="New plan">
            <input value={name} maxLength={100} placeholder="Spring urea 2026" onChange={(event) => setName(event.target.value)} />
          </Field>
          <Button
            disabled={busy || !name.trim()}
            onClick={() =>
              void run(
                () => api<{ plan: PlanSummary }>(`/api/farming/farms/${farm.id}/plans`, { method: "POST", body: { organisationId, name } }),
                (result) => {
                  router.push(`/operations/farming/fertiliser?plan=${result.plan.id}`);
                },
              )
            }
          >
            Add plan
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function Products({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const products = useApiData<{ products: FertiliserProduct[] }>("/api/farming/products", { organisationId });
  const [form, setForm] = useState({ name: "", nPct: "", pPct: "", kPct: "", sPct: "" });
  const { busy, error, run } = useRun();
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });
  return (
    <Card title="Products" description="Fertiliser products and their nutrient content, as a percentage by weight. Plans and applications work out kg of N from these.">
      {products.error ? <Notice tone="error">{products.error}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {products.data && products.data.products.length === 0 ? <Empty>No products yet. Add one, such as Urea at 46% N.</Empty> : null}
      {products.data && products.data.products.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Product</th>
                <th className={ui.num}>N %</th>
                <th className={ui.num}>P %</th>
                <th className={ui.num}>K %</th>
                <th className={ui.num}>S %</th>
              </tr>
            </thead>
            <tbody>
              {products.data.products.map((product) => (
                <tr key={product.id}>
                  <td data-label="Product">{product.name}</td>
                  <td data-label="N %" className={ui.num}>
                    {product.nPct}
                  </td>
                  <td data-label="P %" className={ui.num}>
                    {product.pPct}
                  </td>
                  <td data-label="K %" className={ui.num}>
                    {product.kPct}
                  </td>
                  <td data-label="S %" className={ui.num}>
                    {product.sPct}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {can("bookkeeper") ? (
        <div className={ui.inlineForm}>
          <Field label="New product">
            <input value={form.name} maxLength={100} onChange={set("name")} />
          </Field>
          {(["nPct", "pPct", "kPct", "sPct"] as const).map((key) => (
            <Field key={key} label={`${key[0].toUpperCase()} %`}>
              <input inputMode="decimal" size={5} value={form[key]} onChange={set(key)} />
            </Field>
          ))}
          <Button
            disabled={busy || !form.name.trim()}
            onClick={() =>
              void run(
                () => api("/api/farming/products", { method: "POST", body: { organisationId, ...form } }),
                () => {
                  setForm({ name: "", nPct: "", pPct: "", kPct: "", sPct: "" });
                  products.reload();
                },
              )
            }
          >
            Add product
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

// One plan ---------------------------------------------------------------------------------------

function PlanView({ organisationId, planId }: { organisationId: string; planId: string }) {
  const { can } = useWorkspace();
  const loaded = useApiData<{ report: PlanReport }>(`/api/farming/plans/${planId}`, { organisationId });
  const [report, setReport] = useState<PlanReport | null>(null);
  const current = report ?? loaded.data?.report ?? null;
  const paddocks = useApiData<{ paddocks: Paddock[] }>(current ? `/api/farming/farms/${current.plan.farmId}/paddocks` : null, { organisationId });
  const products = useApiData<{ products: FertiliserProduct[] }>("/api/farming/products", { organisationId });
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!current) return <p className={ui.muted}>Loading…</p>;
  const editable = can("bookkeeper");
  const context = {
    organisationId,
    report: current,
    paddocks: (paddocks.data?.paddocks ?? []).filter((paddock) => paddock.status === "active"),
    products: (products.data?.products ?? []).filter((product) => product.isActive),
    onReport: setReport,
  };
  return (
    <>
      <p>
        <Link href="/operations/farming/fertiliser">All plans</Link>
      </p>
      <h2>{current.plan.name}</h2>
      {current.warnings.map((warning) => (
        <Notice key={warning} tone="warning">
          {warning}
        </Notice>
      ))}
      <PlanAgainstActual report={current} />
      <Versions {...context} editable={editable} />
      <Purchases {...context} editable={editable} />
      <Applications {...context} editable={editable} />
      <Spreading {...context} editable={editable} />
    </>
  );
}

type PlanContext = { organisationId: string; report: PlanReport; paddocks: Paddock[]; products: FertiliserProduct[]; onReport: (report: PlanReport) => void; editable: boolean };

function PlanAgainstActual({ report }: { report: PlanReport }) {
  if (report.versions.length === 0 && report.applications.length === 0) return null;
  return (
    <Card
      title="Planned against actual"
      description={`Against version ${report.versions[0]?.version ?? "–"}. The books show what the bills expensed; the paddock costs show what was applied where, with spreading shared by hectares. Nothing here posts.`}
    >
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th>Product</th>
              <th className={ui.num}>Planned t</th>
              <th className={ui.num}>Bought t</th>
              <th className={ui.num}>Applied t</th>
              <th className={ui.num}>Planned cost</th>
              <th className={ui.num}>Expensed</th>
              <th className={ui.num}>Applied</th>
              <th className={ui.num}>Not yet applied</th>
            </tr>
          </thead>
          <tbody>
            {report.products.map((product) => (
              <tr key={product.productId}>
                <td data-label="Product">{product.productName}</td>
                <td data-label="Planned t" className={ui.num}>
                  {product.plannedTonnes}
                </td>
                <td data-label="Bought t" className={ui.num}>
                  {product.boughtTonnes}
                </td>
                <td data-label="Applied t" className={ui.num}>
                  {product.appliedTonnes}
                </td>
                <td data-label="Planned cost" className={ui.num}>
                  {formatMoney(product.plannedCost)}
                </td>
                <td data-label="Expensed" className={ui.num}>
                  {formatMoney(product.expensed)}
                </td>
                <td data-label="Applied" className={ui.num}>
                  {formatMoney(product.appliedCost)}
                </td>
                <td data-label="Not yet applied" className={ui.num}>
                  {formatMoney(product.notYetApplied)} ({product.notYetAppliedTonnes} t)
                </td>
              </tr>
            ))}
            <tr>
              <td data-label="Product">Spreading</td>
              <td colSpan={3}></td>
              <td data-label="Planned cost" className={ui.num}>
                {formatMoney(report.spreadingTotals.planned)}
              </td>
              <td data-label="Expensed" className={ui.num}>
                {formatMoney(report.spreadingTotals.actual)}
              </td>
              <td colSpan={2}></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th>Paddock</th>
              <th className={ui.num}>Planned kg N/ha</th>
              <th className={ui.num}>Actual kg N/ha</th>
              <th className={ui.num}>Planned cost</th>
              <th className={ui.num}>Actual cost</th>
              <th className={ui.num}>Actual a hectare</th>
            </tr>
          </thead>
          <tbody>
            {report.paddocks.map((paddock) => (
              <tr key={paddock.paddockId}>
                <td data-label="Paddock">
                  <strong>{paddock.paddockName}</strong>
                </td>
                <td data-label="Planned kg N/ha" className={ui.num}>
                  {paddock.plannedNKgHa ?? "–"}
                </td>
                <td data-label="Actual kg N/ha" className={ui.num}>
                  {paddock.actualNKgHa}
                </td>
                <td data-label="Planned cost" className={ui.num}>
                  {paddock.plannedCost ? formatMoney(paddock.plannedCost) : "–"}
                </td>
                <td data-label="Actual cost" className={ui.num}>
                  {formatMoney(paddock.actualCost)}
                </td>
                <td data-label="Actual a hectare" className={ui.num}>
                  {formatMoney(paddock.actualPerHa)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={ui.muted}>No rates are recommended, and nothing about nutrient loss or compliance is worked out.</p>
    </Card>
  );
}

type DraftLine = { paddockId: string; productId: string; rateKgHa: string; treatedHa: string; pricePerTonne: string };

function Versions({ organisationId, report, paddocks, products, onReport, editable }: PlanContext) {
  const [shown, setShown] = useState(0);
  const [editing, setEditing] = useState(false);
  const latest = report.versions[0];
  const version = report.versions[shown] ?? latest;
  return (
    <Card
      title="Plan"
      description="Each paddock's treated hectares start as its effective area. Spreading is quoted a hectare, once per paddock. Saving makes a new version; earlier ones are kept."
      actions={
        editable && !editing ? (
          <Button size="small" onClick={() => setEditing(true)}>
            {latest ? "Change the plan" : "Add the plan's lines"}
          </Button>
        ) : null
      }
    >
      {report.versions.length > 1 ? (
        <div className={ui.tabs} role="tablist" aria-label="Versions">
          {report.versions.map((entry, index) => (
            <button key={entry.version} type="button" role="tab" aria-selected={index === shown} className={`${ui.tab} ${index === shown ? ui.tabActive : ""}`} onClick={() => setShown(index)}>
              Version {entry.version}
            </button>
          ))}
        </div>
      ) : null}
      {version ? (
        <>
          <p className={ui.muted}>
            Version {version.version}, saved {formatDate(version.createdAt.slice(0, 10))} by {version.createdByEmail}
            {version.note ? `: ${version.note}` : "."}
          </p>
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Paddock</th>
                  <th>Product</th>
                  <th className={ui.num}>kg/ha</th>
                  <th className={ui.num}>Treated ha</th>
                  <th className={ui.num}>Tonnes</th>
                  <th className={ui.num}>kg N/ha</th>
                  <th className={ui.num}>Price a tonne</th>
                  <th className={ui.num}>Product cost</th>
                  <th className={ui.num}>Spreading</th>
                </tr>
              </thead>
              <tbody>
                {version.lines.map((line) => (
                  <tr key={`${line.paddockId}-${line.productId}`}>
                    <td data-label="Paddock">
                      <strong>{line.paddockName}</strong>
                    </td>
                    <td data-label="Product">{line.productName}</td>
                    <td data-label="kg/ha" className={ui.num}>
                      {line.rateKgHa}
                    </td>
                    <td data-label="Treated ha" className={ui.num}>
                      {line.treatedHa}
                    </td>
                    <td data-label="Tonnes" className={ui.num}>
                      {line.tonnes}
                    </td>
                    <td data-label="kg N/ha" className={ui.num}>
                      {line.nKgHa}
                    </td>
                    <td data-label="Price a tonne" className={ui.num}>
                      {line.pricePerTonne ? formatMoney(line.pricePerTonne) : "–"}
                    </td>
                    <td data-label="Product cost" className={ui.num}>
                      {line.productCost ? formatMoney(line.productCost) : "–"}
                    </td>
                    <td data-label="Spreading" className={ui.num}>
                      {line.spreadingCost ? formatMoney(line.spreadingCost) : "–"}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={4}>
                    <strong>Total, excluding GST</strong>
                  </td>
                  <td data-label="Tonnes" className={ui.num}>
                    <strong>{version.totals.tonnes}</strong>
                  </td>
                  <td data-label="kg N">{version.totals.nKg} kg N</td>
                  <td></td>
                  <td data-label="Product cost" className={ui.num}>
                    <strong>{formatMoney(version.totals.productCost)}</strong>
                  </td>
                  <td data-label="Spreading" className={ui.num}>
                    <strong>{formatMoney(version.totals.spreadingCost)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            Plan total <strong>{formatMoney(version.totals.total)}</strong> excluding GST.
          </p>
        </>
      ) : (
        <Empty>No lines yet.</Empty>
      )}
      {editing ? (
        <EditVersion
          organisationId={organisationId}
          report={report}
          paddocks={paddocks}
          products={products}
          onCancel={() => setEditing(false)}
          onSaved={(next) => {
            onReport(next);
            setShown(0);
            setEditing(false);
          }}
        />
      ) : null}
    </Card>
  );
}

function EditVersion({
  organisationId,
  report,
  paddocks,
  products,
  onCancel,
  onSaved,
}: {
  organisationId: string;
  report: PlanReport;
  paddocks: Paddock[];
  products: FertiliserProduct[];
  onCancel: () => void;
  onSaved: (report: PlanReport) => void;
}) {
  const latest = report.versions[0];
  const blank = (): DraftLine => ({ paddockId: "", productId: products[0]?.id ?? "", rateKgHa: "", treatedHa: "", pricePerTonne: "" });
  const [lines, setLines] = useState<DraftLine[]>(
    latest ? latest.lines.map((line) => ({ paddockId: line.paddockId, productId: line.productId, rateKgHa: line.rateKgHa, treatedHa: line.treatedHa, pricePerTonne: line.pricePerTonne ?? "" })) : [blank()],
  );
  const [spreadingPerHa, setSpreading] = useState(latest?.spreadingPerHa ?? "");
  const [note, setNote] = useState("");
  const { busy, error, run } = useRun();
  const change = (index: number, key: keyof DraftLine, value: string) => setLines(lines.map((line, i) => (i === index ? { ...line, [key]: value } : line)));
  return (
    <>
      <h3>{latest ? `Version ${latest.version + 1}` : "Version 1"}</h3>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {lines.map((line, index) => (
        <div className={ui.inlineForm} key={index}>
          <Field label="Paddock">
            <select value={line.paddockId} onChange={(event) => change(index, "paddockId", event.target.value)}>
              <option value="">Choose…</option>
              {paddocks.map((paddock) => (
                <option key={paddock.id} value={paddock.id}>
                  {paddock.name}
                  {paddock.effectiveHa ? ` (${paddock.effectiveHa} ha)` : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Product">
            <select value={line.productId} onChange={(event) => change(index, "productId", event.target.value)}>
              <option value="">Choose…</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="kg/ha">
            <input inputMode="decimal" size={6} value={line.rateKgHa} onChange={(event) => change(index, "rateKgHa", event.target.value)} />
          </Field>
          <Field label="Treated ha" hint="Blank: effective area">
            <input inputMode="decimal" size={6} value={line.treatedHa} onChange={(event) => change(index, "treatedHa", event.target.value)} />
          </Field>
          <Field label="Price a tonne">
            <input inputMode="decimal" size={8} value={line.pricePerTonne} onChange={(event) => change(index, "pricePerTonne", event.target.value)} />
          </Field>
          <Button size="small" variant="secondary" onClick={() => setLines(lines.filter((_, i) => i !== index))} disabled={lines.length === 1}>
            Remove
          </Button>
        </div>
      ))}
      <p>
        <Button size="small" variant="secondary" onClick={() => setLines([...lines, blank()])}>
          Add a line
        </Button>
      </p>
      <div className={ui.inlineForm}>
        <Field label="Spreading a hectare">
          <input inputMode="decimal" size={8} value={spreadingPerHa} onChange={(event) => setSpreading(event.target.value)} />
        </Field>
        <Field label="What changed">
          <input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
        </Field>
        <Button
          disabled={busy}
          onClick={() =>
            void run(
              () => api<{ report: PlanReport }>(`/api/farming/plans/${report.plan.id}/versions`, { method: "POST", body: { organisationId, spreadingPerHa, note, lines } }),
              (result) => onSaved(result.report),
            )
          }
        >
          Save as a new version
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </>
  );
}

function useBillLines(organisationId: string, editable: boolean) {
  return useApiData<{ lines: LinkableBillLine[] }>(editable ? "/api/farming/bill-lines" : null, { organisationId });
}

function Purchases({ organisationId, report, products, onReport, editable }: PlanContext) {
  const billLines = useBillLines(organisationId, editable);
  const [billLineId, setBillLineId] = useState("");
  const [productId, setProductId] = useState("");
  const [tonnes, setTonnes] = useState("");
  const { busy, error, run } = useRun();
  const choices = (billLines.data?.lines ?? []).filter((line) => line.accountCode === "6310" && !line.linked);
  const done = (result: { report: PlanReport }) => {
    onReport(result.report);
    billLines.reload();
    setBillLineId("");
    setTonnes("");
  };
  return (
    <Card title="Bought" description="Fertiliser is expensed when its bill is approved (6310). Link the bill lines here so the plan knows what was bought and at what price. Linking posts nothing.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {report.purchases.length === 0 ? <Empty>No bills linked yet.</Empty> : null}
      {report.purchases.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Bill</th>
                <th>Product</th>
                <th className={ui.num}>Tonnes</th>
                <th className={ui.num}>Excluding GST</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {report.purchases.map((purchase) => (
                <tr key={purchase.billLineId}>
                  <td data-label="Bill">
                    {purchase.supplier}, {formatDate(purchase.billDate)} {purchase.voided ? <Badge tone="red">Voided</Badge> : null}
                  </td>
                  <td data-label="Product">{purchase.productName}</td>
                  <td data-label="Tonnes" className={ui.num}>
                    {purchase.tonnes}
                  </td>
                  <td data-label="Excluding GST" className={ui.num}>
                    {formatMoney(purchase.net)}
                  </td>
                  <td>
                    {editable ? (
                      <Button
                        size="small"
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => api<{ report: PlanReport }>(`/api/farming/plans/${report.plan.id}/purchases`, { method: "DELETE", query: { organisationId, billLineId: purchase.billLineId } }),
                            done,
                          )
                        }
                      >
                        Unlink
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {editable ? (
        choices.length === 0 ? (
          <p className={ui.muted}>No approved bill lines on 6310 Fertiliser and lime are waiting to be linked. Code the fertiliser line of a bill to 6310 and approve it, and it shows here.</p>
        ) : (
          <div className={ui.inlineForm}>
            <Field label="Bill line">
              <select value={billLineId} onChange={(event) => setBillLineId(event.target.value)}>
                <option value="">Choose…</option>
                {choices.map((line) => (
                  <option key={line.id} value={line.id}>
                    {line.supplier}, {formatDate(line.billDate)}: {line.description} ({line.quantity}, {formatMoney(line.net)})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Product">
              <select value={productId} onChange={(event) => setProductId(event.target.value)}>
                <option value="">Choose…</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tonnes" hint="Blank: the line's quantity">
              <input inputMode="decimal" size={7} value={tonnes} onChange={(event) => setTonnes(event.target.value)} />
            </Field>
            <Button
              disabled={busy || !billLineId || !productId}
              onClick={() =>
                void run(() => api<{ report: PlanReport }>(`/api/farming/plans/${report.plan.id}/purchases`, { method: "POST", body: { organisationId, billLineId, productId, tonnes } }), done)
              }
            >
              Link
            </Button>
          </div>
        )
      ) : null}
    </Card>
  );
}

function Applications({ organisationId, report, paddocks, products, onReport, editable }: PlanContext) {
  const [form, setForm] = useState({ paddockId: "", productId: "", appliedOn: todayInBrowser(), tonnes: "", treatedHa: "" });
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [preview, setPreview] = useState<ApplicationImportPreview | null>(null);
  const { busy, error, run } = useRun();
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });
  const path = `/api/farming/plans/${report.plan.id}`;
  return (
    <Card title="Applied" description="What went on each paddock. Each application is costed at the linked bills' average price; anything beyond what they bought uses the plan's quoted price, marked quoted. Nothing posts.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {report.applications.length === 0 ? <Empty>Nothing recorded yet.</Empty> : null}
      {report.applications.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Paddock</th>
                <th>Product</th>
                <th className={ui.num}>Tonnes</th>
                <th className={ui.num}>Treated ha</th>
                <th className={ui.num}>kg/ha</th>
                <th className={ui.num}>kg N/ha</th>
                <th className={ui.num}>Product cost</th>
                <th className={ui.num}>Spreading</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {report.applications.map((app) => (
                <tr key={app.id}>
                  <td data-label="Date">{formatDate(app.appliedOn)}</td>
                  <td data-label="Paddock">
                    <strong>{app.paddockName}</strong>
                  </td>
                  <td data-label="Product">{app.productName}</td>
                  <td data-label="Tonnes" className={ui.num}>
                    {app.tonnes}
                  </td>
                  <td data-label="Treated ha" className={ui.num}>
                    {app.treatedHa}
                  </td>
                  <td data-label="kg/ha" className={ui.num}>
                    {app.kgHa}
                  </td>
                  <td data-label="kg N/ha" className={ui.num}>
                    {app.nKgHa}
                  </td>
                  <td data-label="Product cost" className={ui.num}>
                    {app.productCost ? formatMoney(app.productCost) : "No price"} {app.quoted ? <Badge tone="amber">Quoted</Badge> : null}
                  </td>
                  <td data-label="Spreading" className={ui.num}>
                    {formatMoney(app.spreadingCost)}
                  </td>
                  <td>
                    {editable ? (
                      <Button
                        size="small"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void run(() => api<{ report: PlanReport }>(`/api/farming/applications/${app.id}`, { method: "DELETE", query: { organisationId } }), (result) => onReport(result.report))}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {editable ? (
        <>
          <h3>Record an application</h3>
          <div className={ui.inlineForm}>
            <Field label="Paddock">
              <select value={form.paddockId} onChange={set("paddockId")}>
                <option value="">Choose…</option>
                {paddocks.map((paddock) => (
                  <option key={paddock.id} value={paddock.id}>
                    {paddock.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Product">
              <select value={form.productId} onChange={set("productId")}>
                <option value="">Choose…</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Date">
              <input type="date" value={form.appliedOn} onChange={set("appliedOn")} />
            </Field>
            <Field label="Tonnes">
              <input inputMode="decimal" size={7} value={form.tonnes} onChange={set("tonnes")} />
            </Field>
            <Field label="Treated ha" hint="Blank: effective area">
              <input inputMode="decimal" size={6} value={form.treatedHa} onChange={set("treatedHa")} />
            </Field>
            <Button
              disabled={busy || !form.paddockId || !form.productId || !form.tonnes}
              onClick={() =>
                void run(
                  () => api<{ report: PlanReport }>(`${path}/applications`, { method: "POST", body: { organisationId, ...form } }),
                  (result) => {
                    onReport(result.report);
                    setForm({ ...form, tonnes: "", treatedHa: "" });
                  },
                )
              }
            >
              Record
            </Button>
          </div>
          <h3>Import from a spreader or contractor file</h3>
          <div className={ui.inlineForm}>
            <Field label="CSV file" hint="Columns Paddock, Product, Date, Tonnes, and optionally Treated ha">
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={async (event) => {
                  const picked = event.target.files?.[0];
                  setPreview(null);
                  setFile(picked ? { name: picked.name, content: await picked.text() } : null);
                }}
              />
            </Field>
            <Button
              variant="secondary"
              disabled={busy || !file}
              onClick={() =>
                void run(
                  () => api<{ preview: ApplicationImportPreview }>(`${path}/import`, { method: "POST", body: { organisationId, fileName: file?.name, content: file?.content, preview: true } }),
                  (result) => setPreview(result.preview),
                )
              }
            >
              Check the file
            </Button>
          </div>
          {preview ? (
            <>
              {preview.alreadyImportedOn ? <Notice tone="warning">This file was already imported on {formatDate(preview.alreadyImportedOn.slice(0, 10))}.</Notice> : null}
              <p>
                {preview.valid} row{preview.valid === 1 ? "" : "s"} to import, {preview.errors} skipped.
              </p>
              {preview.errors > 0 ? (
                <ul>
                  {preview.rows
                    .filter((row) => row.error)
                    .map((row) => (
                      <li key={row.line}>
                        Line {row.line}: {row.error}
                      </li>
                    ))}
                </ul>
              ) : null}
              <Button
                disabled={busy || preview.valid === 0 || Boolean(preview.alreadyImportedOn)}
                onClick={() =>
                  void run(
                    () => api<{ report: PlanReport }>(`${path}/import`, { method: "POST", body: { organisationId, fileName: file?.name, content: file?.content } }),
                    (result) => {
                      onReport(result.report);
                      setPreview(null);
                      setFile(null);
                    },
                  )
                }
              >
                Import {preview.valid} row{preview.valid === 1 ? "" : "s"}
              </Button>
            </>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

function Spreading({ organisationId, report, onReport, editable }: PlanContext) {
  const billLines = useBillLines(organisationId, editable);
  const [billLineId, setBillLineId] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const { busy, error, run } = useRun();
  const choices = (billLines.data?.lines ?? []).filter((line) => line.accountCode === "6320" && !line.linked);
  const done = (result: { report: PlanReport }) => {
    onReport(result.report);
    billLines.reload();
    setBillLineId("");
    setChosen([]);
  };
  return (
    <Card title="Spreading" description="The spreading contractor's bill posts once (6320). Link it to the applications it covered and it's shared across those paddocks by hectares, for paddock costs only.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {report.spreading.length === 0 ? <Empty>No spreading bills linked yet.</Empty> : null}
      {report.spreading.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Bill</th>
                <th className={ui.num}>Applications</th>
                <th className={ui.num}>Excluding GST</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {report.spreading.map((entry) => (
                <tr key={entry.billLineId}>
                  <td data-label="Bill">
                    {entry.supplier}, {formatDate(entry.billDate)} {entry.voided ? <Badge tone="red">Voided</Badge> : null}
                  </td>
                  <td data-label="Applications" className={ui.num}>
                    {entry.applications}
                  </td>
                  <td data-label="Excluding GST" className={ui.num}>
                    {formatMoney(entry.net)}
                  </td>
                  <td>
                    {editable ? (
                      <Button
                        size="small"
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          void run(() => api<{ report: PlanReport }>(`/api/farming/plans/${report.plan.id}/spreading`, { method: "DELETE", query: { organisationId, billLineId: entry.billLineId } }), done)
                        }
                      >
                        Unlink
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {editable && report.applications.length > 0 ? (
        choices.length === 0 ? (
          <p className={ui.muted}>No approved bill lines on 6320 Fertiliser spreading are waiting to be linked.</p>
        ) : (
          <>
            <div className={ui.inlineForm}>
              <Field label="Spreading bill line">
                <select value={billLineId} onChange={(event) => setBillLineId(event.target.value)}>
                  <option value="">Choose…</option>
                  {choices.map((line) => (
                    <option key={line.id} value={line.id}>
                      {line.supplier}, {formatDate(line.billDate)}: {line.description} ({formatMoney(line.net)})
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <fieldset>
              <legend>Applications it covered</legend>
              {report.applications.map((app) => (
                <label key={app.id} className={ui.checkbox}>
                  <input
                    type="checkbox"
                    checked={chosen.includes(app.id)}
                    onChange={(event) => setChosen(event.target.checked ? [...chosen, app.id] : chosen.filter((id) => id !== app.id))}
                  />{" "}
                  {app.paddockName}, {formatDate(app.appliedOn)}, {app.treatedHa} ha
                </label>
              ))}
            </fieldset>
            <Button
              disabled={busy || !billLineId || chosen.length === 0}
              onClick={() =>
                void run(() => api<{ report: PlanReport }>(`/api/farming/plans/${report.plan.id}/spreading`, { method: "POST", body: { organisationId, billLineId, applicationIds: chosen } }), done)
              }
            >
              Link and share by hectares
            </Button>
          </>
        )
      ) : null}
    </Card>
  );
}
