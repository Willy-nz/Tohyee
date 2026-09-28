"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import type { TrackingCategory, TrackingSetup, TrackingTags } from "@/lib/tracking/service";

/**
 * Tracking categories on screen (examples TC1-TC10): the setup hook, the
 * per-line selects used by every line editor, tags as text, and the
 * settings screens. Everything here shows only when advanced features are on.
 */
export function useTracking(organisationId: string | null) {
  return useApiData<TrackingSetup>(organisationId ? "/api/tracking" : null, { organisationId });
}

/** The categories to show on a line: none unless advanced features are on. */
export function activeCategories(setup: TrackingSetup | null | undefined): TrackingCategory[] {
  return setup?.advancedFeatures ? setup.categories : [];
}

/** One select per category for a line. `value` is the line's tags; archived values show only if already chosen. */
export function TrackingSelects({
  setup,
  value,
  onChange,
  disabled,
  labelPrefix,
}: {
  setup: TrackingSetup | null | undefined;
  value: TrackingTags;
  onChange: (tags: TrackingTags) => void;
  disabled?: boolean;
  labelPrefix?: string;
}) {
  const categories = activeCategories(setup);
  if (categories.length === 0) return null;
  return (
    <div className={ui.trackingSelects}>
      {categories.map((category) => (
        <select
          key={category.id}
          aria-label={`${labelPrefix ? `${labelPrefix} ` : ""}${category.name}`}
          title={category.name}
          value={value[category.id] ?? ""}
          disabled={disabled}
          onChange={(event) => {
            const next = { ...value };
            if (event.target.value) next[category.id] = event.target.value;
            else delete next[category.id];
            onChange(next);
          }}
        >
          <option value="">{category.name}{category.isRequired ? " (required)" : ""}</option>
          {category.values
            .filter((option) => option.isActive || value[category.id] === option.id)
            .map((option) => (
              <option key={option.id} value={option.id}>
                {"  ".repeat(option.depth)}
                {option.name}
                {option.isActive ? "" : " (archived)"}
              </option>
            ))}
        </select>
      ))}
    </div>
  );
}

/** "Department: Retail · Location: Otago › Dunedin", or nothing. */
export function trackingText(setup: TrackingSetup | null | undefined, tags: TrackingTags | undefined): string {
  if (!setup || !tags) return "";
  return setup.categories
    .flatMap((category) => {
      const valueId = tags[category.id];
      if (!valueId) return [];
      const found = category.values.find((value) => value.id === valueId);
      return [`${category.name}: ${found?.path ?? `#${valueId}`}`];
    })
    .join(" · ");
}

export function TrackingTagsText({ setup, tags }: { setup: TrackingSetup | null | undefined; tags: TrackingTags | undefined }) {
  const text = trackingText(setup, tags);
  return text ? <div className={ui.muted}>{text}</div> : null;
}

/** Settings: the Advanced (ERP) features switch (TC1). */
export function AdvancedFeaturesCard({ organisationId }: { organisationId: string }) {
  const setup = useTracking(organisationId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = setup.data?.advancedFeatures ?? false;
  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/organisations/${organisationId}/settings`, { method: "PATCH", body: { advancedFeatures: !on } });
      setup.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card
      title="Advanced (ERP) features"
      description="For bigger organisations: tracking categories (Department, Class and Location) on every invoice, bill, credit note, spend and receive money and journal line, with profit and loss split and filtered by them. Off, the extra fields are hidden; anything already tagged is kept."
      actions={on ? <Badge tone="green">On</Badge> : <Badge>Off</Badge>}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {setup.error ? <Notice tone="error">{setup.error}</Notice> : null}
      <div className={ui.actions}>
        <Button variant={on ? "secondary" : "primary"} disabled={busy || !setup.data} onClick={() => void toggle()}>
          {busy ? "Saving…" : on ? "Turn off" : "Turn on"}
        </Button>
        {on ? <Link href="/operations/settings/tracking">Tracking categories and their values</Link> : null}
      </div>
    </Card>
  );
}

function CategoryCard({ organisationId, category, onChanged }: { organisationId: string; category: TrackingCategory; onChanged: (setup: TrackingSetup, message: string) => void }) {
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string; parentId: string } | null>(null);
  const [categoryName, setCategoryName] = useState(category.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(work: () => Promise<{ setup: TrackingSetup; message: string }>) {
    setBusy(true);
    setError(null);
    try {
      const result = await work();
      onChanged(result.setup, result.message);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  const patchValue = (id: string, body: Record<string, unknown>, message: string) =>
    run(async () => ({ setup: await api<TrackingSetup>(`/api/tracking/values/${id}`, { method: "PATCH", body: { organisationId, ...body } }), message }));

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(async () => {
      const setup = await api<TrackingSetup>("/api/tracking/values", { method: "POST", body: { organisationId, categoryId: category.id, name, parentId: parentId || null } });
      setName("");
      return { setup, message: `Added ${name.trim()}.` };
    });
  }

  const parents = (excludeId?: string) => {
    // A value can't go under itself or its own children.
    const blocked = new Set<string>();
    if (excludeId) {
      blocked.add(excludeId);
      let grew = true;
      while (grew) {
        grew = false;
        for (const value of category.values) {
          if (value.parentId && blocked.has(value.parentId) && !blocked.has(value.id)) {
            blocked.add(value.id);
            grew = true;
          }
        }
      }
    }
    return category.values.filter((value) => value.isActive && !blocked.has(value.id));
  };

  return (
    <Card
      title={category.name}
      description={category.isRequired ? "Required on every income and expense line before it's approved or posted." : "Optional on lines."}
      actions={
        <label className={ui.checkbox}>
          <input
            type="checkbox"
            checked={category.isRequired}
            disabled={busy}
            onChange={(event) =>
              void run(async () => ({
                setup: await api<TrackingSetup>(`/api/tracking/categories/${category.id}`, {
                  method: "PATCH",
                  body: { organisationId, isRequired: event.target.checked },
                }),
                message: event.target.checked ? `${category.name} is now required.` : `${category.name} is now optional.`,
              }))
            }
          />{" "}
          Required
        </label>
      }
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <form
        className={ui.actions}
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => ({
            setup: await api<TrackingSetup>(`/api/tracking/categories/${category.id}`, { method: "PATCH", body: { organisationId, name: categoryName } }),
            message: `Renamed to ${categoryName.trim()}.`,
          }));
        }}
      >
        <input aria-label={`Rename ${category.name}`} style={{ maxWidth: 260 }} value={categoryName} maxLength={60} onChange={(event) => setCategoryName(event.target.value)} />
        <Button type="submit" size="small" variant="secondary" disabled={busy || categoryName.trim() === category.name}>
          Rename category
        </Button>
      </form>
      {category.values.length === 0 ? <Empty>No values yet.</Empty> : null}
      {category.values.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Value</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {category.values.map((value) =>
                renaming?.id === value.id ? (
                  <tr key={value.id}>
                    <td colSpan={3}>
                      <form
                        className={ui.actions}
                        onSubmit={(event) => {
                          event.preventDefault();
                          void patchValue(value.id, { name: renaming.name, parentId: renaming.parentId || null }, `Saved ${renaming.name.trim()}.`).then(() =>
                            setRenaming(null),
                          );
                        }}
                      >
                        <input aria-label="Name" value={renaming.name} maxLength={100} onChange={(event) => setRenaming({ ...renaming, name: event.target.value })} />
                        <select aria-label="Under" value={renaming.parentId} onChange={(event) => setRenaming({ ...renaming, parentId: event.target.value })}>
                          <option value="">At the top</option>
                          {parents(value.id).map((option) => (
                            <option key={option.id} value={option.id}>
                              Under {option.path}
                            </option>
                          ))}
                        </select>
                        <Button type="submit" size="small" disabled={busy}>
                          Save
                        </Button>
                        <Button type="button" size="small" variant="secondary" onClick={() => setRenaming(null)}>
                          Cancel
                        </Button>
                      </form>
                    </td>
                  </tr>
                ) : (
                  <tr key={value.id}>
                    <td style={{ paddingLeft: 12 + value.depth * 20 }}>{value.name}</td>
                    <td>{value.isActive ? <Badge tone="green">Active</Badge> : <Badge>Archived</Badge>}</td>
                    <td className={ui.num}>
                      <span className={ui.rowButtons}>
                        <Button size="small" variant="secondary" disabled={busy} onClick={() => setRenaming({ id: value.id, name: value.name, parentId: value.parentId ?? "" })}>
                          Rename or move
                        </Button>
                        <Button
                          size="small"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => void patchValue(value.id, { isActive: !value.isActive }, value.isActive ? `Archived ${value.name}.` : `Restored ${value.name}.`)}
                        >
                          {value.isActive ? "Archive" : "Restore"}
                        </Button>
                      </span>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      ) : null}
      <form className={ui.actions} onSubmit={(event) => void add(event)}>
        <Field label="New value">
          <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} required />
        </Field>
        <Field label="Under">
          <select value={parentId} onChange={(event) => setParentId(event.target.value)}>
            <option value="">At the top</option>
            {parents().map((option) => (
              <option key={option.id} value={option.id}>
                {option.path}
              </option>
            ))}
          </select>
        </Field>
        <Button type="submit" disabled={busy || !name.trim()}>
          Add
        </Button>
      </form>
    </Card>
  );
}

/** Settings › Tracking categories (TC2, TC6). */
export function TrackingManager({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const setup = useTracking(organisationId);
  const [current, setCurrent] = useState<TrackingSetup | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (setup.error) return <Notice tone="error">{setup.error}</Notice>;
  if (!setup.data) return <p className={ui.muted}>Loading…</p>;
  const data = current ?? setup.data;
  if (!data.advancedFeatures) {
    return (
      <Notice tone="info">
        Advanced features are off. Turn them on in <Link href="/operations/settings">Settings</Link> to use tracking categories.
      </Notice>
    );
  }
  if (!can("admin")) return <Notice tone="warning">Only organisation admins and owners can change tracking categories.</Notice>;
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      <p className={ui.muted}>
        Values sit in a tree: a value under another (Otago › Dunedin) counts in its parent when reports are split or filtered. Values are archived, never
        deleted, so old lines keep them.
      </p>
      {data.categories.map((category) => (
        <CategoryCard
          key={category.id}
          organisationId={organisationId}
          category={category}
          onChanged={(next, text) => {
            setCurrent(next);
            setMessage(text);
          }}
        />
      ))}
    </>
  );
}
