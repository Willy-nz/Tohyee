import { writeAuditEvent } from "@/lib/audit";
import { businessTimeZone, parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { requireFarmAccess, visibleFarmIds } from "@/lib/farming/access";
import { requireFarming } from "@/lib/farming/paddocks";
import { CONTENT_WIDTH, PdfWriter } from "@/lib/pdf/writer";
import { type ChainEntry, verifyChain } from "@/lib/safety/chain";
import { PACK_VERIFY_SCRIPT } from "@/lib/safety/pack-verify-script";
import { canSeeRestricted, ENTRY_COLUMNS, type EntryRow, toChainEntry } from "@/lib/safety/records";
import { CHANGE_LABELS, KIND_LABELS, mayBeNotifiable, NOTIFIABLE_KEEP_RULE, type NotifiableAnswers, notifiableKeepText, recordFields, recordTitle, type WorkSafeNotice } from "@/lib/safety/shared";
import { createZip, type ZipEntry } from "@/lib/zip/write";

/*
 * The WorkSafe pack (#446, decision 934): every safety record on the
 * chosen farm (or all the person's farms) entered or dated within a date
 * range, each with its full history, ready to hand over. A zip with:
 * - pack.pdf: the records to read, each version with who entered it and when;
 * - entries.json: those versions exactly as stored, with their hashes;
 * - chain.json: every entry's number and hash (no details), so the pack's
 *   entries can be shown to sit in the farm's whole history;
 * - files.json and files/: photos and documents the records name;
 * - verify.mjs and README.txt: how to check it on any computer.
 * Restricted incident and medical details are withheld (their hash stays)
 * unless the person may see them (decision 936).
 */

export type PackFile = { id: string; recordSeq: string; name: string; contentType: string; sha256: string; photoTaken: string | null; phoneFileTime: string | null; receivedAt: string; path: string | null; content: Buffer | null };

export type PackData = {
  organisationName: string;
  farms: Array<{ id: string; name: string }>;
  from: string;
  to: string;
  generatedAt: string;
  generatedBy: string;
  entries: ChainEntry[];
  chain: Array<{ seq: string; previousHash: string; hash: string }>;
  files: PackFile[];
  paddockNames: Map<string, string>;
  chainOk: boolean;
};

function fileIds(body: string): string[] {
  try {
    const data = JSON.parse(body) as { files?: unknown };
    return Array.isArray(data.files) ? data.files.map((file) => (file && typeof file === "object" ? String((file as { id?: unknown }).id ?? "") : "")).filter((id) => /^[0-9a-f-]{36}$/i.test(id)) : [];
  } catch {
    return [];
  }
}

/** Gathers the pack inside one read of the organisation's database; the files are written afterwards. */
/**
 * `afterSeq` (the weekly copy, #461) picks records by entry number instead
 * of dates: every record with an entry after that number, up to the last
 * entry when the pack was gathered. Entries get their numbers one at a time
 * under a lock held until they're saved, so once entry N is seen every
 * entry before it is saved too: nothing can land behind the high-water mark.
 */
export async function loadPackData(tx: OrgTx, input: { farmId?: unknown; from: unknown; to: unknown; withholdRestricted?: boolean; enteredOnly?: boolean; afterSeq?: string | null }): Promise<PackData> {
  await requireFarming(tx);
  const from = parseIsoDate(input.from, "From");
  const to = parseIsoDate(input.to, "To");
  if (to < from) throw new ValidationError("The end date is before the start date.");
  let farmIds: string[] | null;
  if (input.farmId != null && input.farmId !== "" && input.farmId !== "all") {
    const farmId = String(input.farmId);
    await requireFarmAccess(tx, farmId);
    farmIds = [farmId];
  } else {
    farmIds = await visibleFarmIds(tx);
  }
  // The weekly copy goes off the farm by email: never with injury or medical details (decision 958).
  const restricted = input.withholdRestricted ? false : await canSeeRestricted(tx);
  const zone = businessTimeZone();
  // One upper bound for everything below, so the pack, its chain and the head it reports agree.
  const top = await tx.query<{ seq: string }>("select coalesce(max(seq), 0)::text as seq from safety_entries");
  const upTo = top.rows[0].seq;
  const records =
    input.afterSeq !== undefined
      ? await tx.query<{ record_id: string }>(
          `select distinct record_id::text from safety_entries
            where ($1::bigint[] is null or farm_id is null or farm_id = any($1::bigint[])) and seq > $2::bigint and seq <= $3::bigint`,
          [farmIds, input.afterSeq ?? "0", upTo],
        )
      : await tx.query<{ record_id: string }>(
          `select distinct record_id::text from safety_entries
            where ($1::bigint[] is null or farm_id is null or farm_id = any($1::bigint[])) and seq <= $6::bigint
              and (((entered_at at time zone $4)::date between $2 and $3) or (not $5 and happened_on between $2 and $3))`,
          [farmIds, from, to, zone, input.enteredOnly ?? false, upTo],
        );
  const ids = records.rows.map((row) => row.record_id);
  const rows = await tx.query<EntryRow>(`select ${ENTRY_COLUMNS} from safety_entries e where e.record_id = any($1::uuid[]) and e.seq <= $2::bigint order by e.seq`, [ids, upTo]);
  // The first version says who entered a restricted record; they may see their own.
  const authors = new Map<string, string | null>();
  for (const row of rows.rows) if (row.version === 1) authors.set(row.record_id, row.entered_by_user_id);
  const entries = rows.rows.map((row) => toChainEntry(row, row.restricted && !restricted && (input.withholdRestricted || tx.actor.role === "farm_worker" || authors.get(row.record_id) !== tx.actor.userId)));
  const chainRows = await tx.query<EntryRow>(`select ${ENTRY_COLUMNS} from safety_entries e where e.seq <= $1::bigint order by e.seq`, [upTo]);
  const chainOk = verifyChain(chainRows.rows.map((row) => toChainEntry(row))).problems.length === 0;
  const chain = chainRows.rows.map((row) => ({ seq: row.seq, previousHash: row.previous_hash, hash: row.hash }));

  const wantedFiles = new Map<string, string>();
  for (const entry of entries) if (entry.body) for (const id of fileIds(entry.body)) if (!wantedFiles.has(id)) wantedFiles.set(id, entry.seq);
  const fileRows = wantedFiles.size
    ? await tx.query<{ id: string; file_name: string; content_type: string; sha256: string; content: Buffer; photo_taken: string | null; phone_file_time: string | null; received_at: string; restricted: boolean }>(
        "select id::text, file_name, content_type, sha256, content, photo_taken, phone_file_time, received_at, restricted from safety_files where id = any($1::uuid[]) order by safety_files.received_at, safety_files.id",
        [[...wantedFiles.keys()]],
      )
    : { rows: [] };
  const files: PackFile[] = fileRows.rows.map((row) => {
    const path = `files/${row.id}-${row.file_name.replace(/[^A-Za-z0-9._-]+/g, "_")}`;
    return {
      id: row.id,
      recordSeq: wantedFiles.get(row.id)!,
      name: row.file_name,
      contentType: row.content_type,
      sha256: row.sha256,
      photoTaken: row.photo_taken,
      phoneFileTime: row.phone_file_time ? new Date(row.phone_file_time).toISOString() : null,
      receivedAt: new Date(row.received_at).toISOString(),
      path,
      content: row.content,
    };
  });

  const farms = await tx.query<{ id: string; name: string }>("select id::text, name from farms where ($1::bigint[] is null or id = any($1::bigint[])) order by farms.name, farms.id", [farmIds]);
  const paddocks = await tx.query<{ id: string; name: string }>("select id::text, name from paddocks where ($1::bigint[] is null or farm_id = any($1::bigint[]))", [farmIds]);
  const organisation = await tx.query<{ display_name: string }>("select display_name from organisation_settings");
  const now = await tx.query<{ now: string }>("select now() as now");
  await writeAuditEvent(tx, { eventType: "safety.pack_exported", entityType: "safety_pack", entityId: `${from}..${to}`, details: { farmIds, entries: entries.length, files: files.length } });
  return {
    organisationName: organisation.rows[0]?.display_name ?? "",
    farms: farms.rows,
    from,
    to,
    generatedAt: new Date(now.rows[0].now).toISOString(),
    generatedBy: tx.actor.email,
    entries,
    chain,
    files,
    paddockNames: new Map(paddocks.rows.map((row) => [row.id, row.name])),
    chainOk,
  };
}

function nzTime(iso: string): string {
  return new Intl.DateTimeFormat("en-NZ", { timeZone: businessTimeZone(), dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

const README = (data: PackData) => `Farm safety records: ${data.organisationName}
Farms: ${data.farms.map((farm) => farm.name).join(", ") || "none"}
Records entered or dated ${data.from} to ${data.to}, each with its full history.
Made ${nzTime(data.generatedAt)} by ${data.generatedBy}, from Tohyee (open source: anyone can read how the history works).

What's here
- pack.pdf      the records to read. Each version shows when it was entered (set by the
                database, not the person) and who entered it; a date the person gave
                for when something happened shows beside it.
- entries.json  the same versions exactly as stored, with their hashes.
- chain.json    the number and hash of every safety entry in the organisation, with
                no details, so these entries can be shown to sit in the whole history.
- files.json    photos and documents the records name, with their hashes, the date the
  files/        camera recorded (if any), the phone's file date and when they arrived.
- verify.mjs    checks all of this on any computer with Node.js: node verify.mjs

How the history works
Records are never changed or deleted in Tohyee. A change is a new version; a mistake is
corrected by a new version that says why. Each entry's hash (SHA-256) is worked out from
its details and the hash of the entry before it, so a change made straight in the
database shows up as a broken link or a hash that doesn't match.

What it can't prove on its own
Someone with full control of the server could rewrite every entry after a point and work
out new hashes. Compare the latest entry number and hash in chain.json with an earlier
copy kept off the farm (for example the weekly email): if that entry's hash is different,
the history was rewritten.
${data.entries.some((entry) => entry.body === null) ? "\nSome restricted details (incident and medical) were withheld from this pack: only their hash is here.\n" : ""}
Tohyee keeps these records; it doesn't decide what the law needs you to keep. Check
WorkSafe's guidance, or ask someone who knows health and safety law.

${NOTIFIABLE_KEEP_RULE}
`;

/** Writes the pack's PDF and zip (no database work). */
export async function renderPack(data: PackData): Promise<{ fileName: string; bytes: Buffer; pdf: Uint8Array }> {
  const pdf = await PdfWriter.create({ title: `Farm safety records ${data.from} to ${data.to}`, author: data.organisationName, footer: `${data.organisationName} · Farm safety records ${data.from} to ${data.to}` });
  pdf.text("Farm safety records", { bold: true, size: 18, gap: 4 });
  pdf.text(data.organisationName, { size: 11, gap: 2 });
  pdf.text(`Farms: ${data.farms.map((farm) => farm.name).join(", ") || "none"}`, { gap: 2 });
  pdf.text(`Entered or dated ${data.from} to ${data.to}, each record with its full history.`, { gap: 2 });
  pdf.text(`Made ${nzTime(data.generatedAt)} by ${data.generatedBy}.`, { muted: true, gap: 2 });
  const head = data.chain.at(-1);
  pdf.text(head ? `History: ${data.chain.length} entries; latest is number ${head.seq}, hash ${head.hash}.` : "History: no entries yet.", { muted: true, size: 8, gap: 2 });
  pdf.text(data.chainOk ? "When this pack was made, every entry's hash checked out." : "When this pack was made, the history did NOT check out: see Records and checks in Tohyee.", { bold: !data.chainOk, gap: 12 });

  const byRecord = new Map<string, ChainEntry[]>();
  for (const entry of data.entries) byRecord.set(entry.recordId, [...(byRecord.get(entry.recordId) ?? []), entry]);
  const farmName = new Map(data.farms.map((farm) => [farm.id, farm.name]));
  if (!byRecord.size) pdf.text("No safety records in this range.");
  for (const versions of byRecord.values()) {
    const latest = versions.at(-1)!;
    const latestData = latest.body ? (JSON.parse(latest.body) as Record<string, unknown>) : {};
    pdf.ensure(60);
    pdf.rule({ thick: true });
    pdf.space(6);
    const kindLabel = KIND_LABELS[latest.kind as keyof typeof KIND_LABELS] ?? latest.kind;
    const title = latest.body ? recordTitle(latest.kind as never, latestData) : "restricted (withheld)";
    pdf.text(`${title === kindLabel ? kindLabel : `${kindLabel}: ${title}`}${latest.change === "withdrawn" ? " (withdrawn: entered by mistake)" : ""}`, { bold: true, size: 11, gap: 2 });
    pdf.text(`${latest.farmId ? farmName.get(latest.farmId) ?? `Farm ${latest.farmId}` : "All farms"} · record ${latest.recordId}`, { muted: true, size: 8, gap: 4 });
    for (const version of versions) {
      pdf.ensure(40);
      const happened = version.happenedOn ? ` · happened ${version.happenedOn}` : "";
      pdf.text(`Version ${version.version}: ${CHANGE_LABELS[version.change as keyof typeof CHANGE_LABELS] ?? version.change} · entered ${nzTime(version.enteredAt)} by ${version.enteredByEmail}${version.via ? ` (${version.via})` : ""}${happened}`, { bold: true, size: 9, gap: 2 });
      if (version.body === null) {
        pdf.text("Restricted details withheld from this pack.", { muted: true, size: 9, gap: 2 });
      } else {
        for (const [label, value] of recordFields(JSON.parse(version.body) as Record<string, unknown>, data.paddockNames)) {
          const top = pdf.y;
          pdf.text(label, { width: 140, muted: true, size: 9 });
          const labelBottom = pdf.y;
          pdf.y = top;
          pdf.text(value, { x: 150, width: CONTENT_WIDTH - 150, size: 9 });
          pdf.y = Math.max(labelBottom, pdf.y);
        }
        const named = data.files.filter((file) => file.recordSeq === version.seq);
        for (const file of named) pdf.text(`File: ${file.name} (received ${nzTime(file.receivedAt)}${file.photoTaken ? `; camera date ${file.photoTaken}` : ""}) sha256 ${file.sha256}`, { size: 8, muted: true });
      }
      pdf.text(`Entry ${version.seq} · hash ${version.hash}`, { size: 7, muted: true, gap: 6 });
    }
    // The keeping period for a record that may be a notifiable event (decision 963).
    if (latest.kind === "report" && mayBeNotifiable(latestData.notifiable as NotifiableAnswers | undefined)) {
      pdf.text(notifiableKeepText((latestData.workSafeNotified as WorkSafeNotice | null | undefined) ?? null), { bold: true, size: 9, gap: 6 });
    }
  }
  const pdfBytes = await pdf.finish();
  const files: ZipEntry[] = [
    { name: "README.txt", data: README(data) },
    { name: "pack.pdf", data: pdfBytes },
    { name: "entries.json", data: JSON.stringify(data.entries, null, 2) },
    { name: "chain.json", data: JSON.stringify(data.chain, null, 2) },
    { name: "files.json", data: JSON.stringify(data.files.map((file) => ({ ...file, content: undefined })), null, 2) },
    { name: "verify.mjs", data: PACK_VERIFY_SCRIPT },
    ...data.files.filter((file) => file.path && file.content).map((file) => ({ name: file.path!, data: file.content! })),
  ];
  const farmPart = data.farms.length === 1 ? data.farms[0].name.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase() : "all-farms";
  return { fileName: `safety-records-${farmPart}-${data.from}-to-${data.to}.zip`, bytes: createZip(files), pdf: pdfBytes };
}
