"use client";

import { useState } from "react";
import { readFileAsBase64 } from "@/components/bank/common";
import { useApiData } from "@/components/hooks";
import { Button, Card, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime, personName } from "@/lib/format";
import type { LogoInfo } from "@/lib/organisations/logo";
import { formatFileSize } from "@/lib/records/file-types";
import { useConfirm } from "@/components/confirm-dialog";

/**
 * Settings: the organisation's logo (admins). A PNG or JPEG of at most
 * 512 KB, shown top left on printed documents, PDFs and statements and at
 * the top of emails. Kept in the organisation's database, so backups have it.
 */
export function LogoCard({ organisationId }: { organisationId: string }) {
  const confirm = useConfirm();
  const loaded = useApiData<{ logo: LogoInfo | null }>(`/api/organisations/${organisationId}/logo`, { info: "1" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const logo = loaded.data?.logo ?? null;

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api(`/api/organisations/${organisationId}/logo`, { method: "PUT", body: { fileName: file.name, fileBase64: await readFileAsBase64(file) } });
      setMessage("Logo saved. It's on printed documents, PDFs and emails from now on.");
      loaded.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!(await confirm("Remove the logo? Documents and emails will show the organisation's name only."))) return;
    setError(null);
    setMessage(null);
    try {
      await api(`/api/organisations/${organisationId}/logo`, { method: "DELETE", body: { organisationId } });
      setMessage("Logo removed.");
      loaded.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <Card
      title="Logo"
      description="Shown top left on printed invoices, credit notes, quotes, purchase orders and statements, on their PDFs, and at the top of emails. PNG or JPEG, at most 512 KB; a few hundred pixels wide is plenty."
    >
      <div style={{ display: "grid", gap: 12 }}>
        {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {message ? <Notice tone="success">{message}</Notice> : null}
        {logo ? (
          <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- served from the organisation's database by an authenticated route */}
            <img
              src={`/api/organisations/${encodeURIComponent(organisationId)}/logo?v=${logo.sha256.slice(0, 16)}`}
              alt="The organisation's logo"
              style={{ maxWidth: 200, maxHeight: 64, border: "1px solid var(--line)", padding: 8, background: "#fff" }}
            />
            <p className={ui.muted} style={{ margin: 0 }}>
              {logo.fileName}, {logo.width} x {logo.height} pixels, {formatFileSize(logo.byteSize)}.
              <br />
              Added by {personName(logo, "uploadedBy")} on {formatDateTime(logo.uploadedAt)}.
            </p>
          </div>
        ) : loaded.data ? (
          <p className={ui.muted} style={{ margin: 0 }}>
            No logo yet: documents and emails show the organisation&apos;s name.
          </p>
        ) : null}
        <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
          <label className={ui.muted}>
            {logo ? "Replace it: " : "Choose a logo: "}
            <input type="file" accept="image/png,image/jpeg" disabled={busy} onChange={(event) => void upload(event.target.files?.[0])} />
          </label>
          {logo ? (
            <Button variant="danger" size="small" onClick={() => void remove()}>
              Remove logo
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
