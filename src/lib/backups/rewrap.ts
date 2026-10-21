import { quoteSqlIdentifier } from "@/lib/db/sql";
import { decryptSecret, decryptSecretWithKey, encryptSecret } from "@/lib/secrets";

/**
 * Stored secrets in a restored database (#389, decision 737;
 * docs/BACKUP-RECOVERY.md). Every secret Tohyee keeps is in a text column
 * whose name ends in `_ciphertext`, encrypted with the TOHYEE_SECRET_KEY of
 * the server that wrote it. After a restore on another computer (which has
 * its own key) each value is re-encrypted with this server's key, using the
 * old key that came with the backup, so bank feeds, mailboxes, two-step
 * sign-in and private mail keep working without anyone typing them again.
 * A value neither key opens is counted, left as it was, and reported so it
 * can be connected again.
 */

type Client = { query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number | null }> };

export type SecretColumnReport = {
  table: string;
  column: string;
  /** Already readable with this server's key. */
  current: number;
  /** Re-encrypted from the old key to this server's. */
  reEncrypted: number;
  /** Opened by neither key: needs connecting or typing again. */
  unreadable: number;
};

export type SecretsReport = { columns: SecretColumnReport[]; current: number; reEncrypted: number; unreadable: number };

/** The `*_ciphertext` text columns of a database's own tables. */
export async function secretColumns(client: Client): Promise<{ table: string; column: string }[]> {
  const result = await client.query<{ table_name: string; column_name: string }>(
    `select c.table_name, c.column_name
       from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema = 'public' and c.column_name like '%\\_ciphertext' and c.data_type = 'text'
      order by c.table_name, c.column_name`,
  );
  return result.rows.map((row) => ({ table: row.table_name, column: row.column_name }));
}

function opensWith(value: string, open: (value: string) => string): boolean {
  try {
    open(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-encrypts every stored secret opened by `sourceLiveKey` (and not by this
 * server's key) with this server's key. Run it inside a transaction on the
 * restored database before anyone can use it. With `dryRun` nothing is
 * changed: it only counts (for a test restore).
 */
export async function reEncryptStoredSecrets(client: Client, sourceLiveKey: string, options: { dryRun?: boolean } = {}): Promise<SecretsReport> {
  const columns: SecretColumnReport[] = [];
  for (const { table, column } of await secretColumns(client)) {
    const t = quoteSqlIdentifier(table);
    const c = quoteSqlIdentifier(column);
    const rows = await client.query<{ row_ctid: string; value: string }>(`select ctid::text as row_ctid, ${c} as value from ${t} where ${c} is not null`);
    const report: SecretColumnReport = { table, column, current: 0, reEncrypted: 0, unreadable: 0 };
    for (const row of rows.rows) {
      if (opensWith(row.value, decryptSecret)) {
        report.current += 1;
        continue;
      }
      let plain: string;
      try {
        plain = decryptSecretWithKey(row.value, sourceLiveKey);
      } catch {
        report.unreadable += 1;
        continue;
      }
      if (!options.dryRun) await client.query(`update ${t} set ${c} = $1 where ctid = $2::tid`, [encryptSecret(plain), row.row_ctid]);
      report.reEncrypted += 1;
    }
    if (report.current + report.reEncrypted + report.unreadable > 0) columns.push(report);
  }
  return {
    columns,
    current: columns.reduce((sum, c) => sum + c.current, 0),
    reEncrypted: columns.reduce((sum, c) => sum + c.reEncrypted, 0),
    unreadable: columns.reduce((sum, c) => sum + c.unreadable, 0),
  };
}

/** Plain words for which kind of connection a secret column belongs to, for the "connect again" list. */
export function describeSecretColumn(table: string): string {
  if (table.startsWith("private_mail")) return "private mail copies";
  if (table.startsWith("farm_mail") || table.includes("calendar")) return "farm calendar mailboxes";
  if (table.startsWith("bank") || table.includes("feed") || table.startsWith("akahu") || table.includes("simplefin") || table.includes("stripe") || table.includes("paypal") || table.includes("wise")) return "bank and payment feeds";
  if (table.startsWith("payroll") || table.startsWith("employee")) return "payroll details (IRD and bank account numbers)";
  if (table.includes("mail") || table.includes("email") || table.includes("smtp")) return "email accounts";
  if (table.startsWith("analytics")) return "analytics connections";
  if (table.startsWith("crm") || table.includes("lead")) return "CRM mail connections";
  if (table === "users") return "two-step sign-in";
  return table.replace(/_/g, " ");
}
