import { ValidationError } from "@/lib/errors";
import { type DatabaseEngine, MAX_QUERY_LENGTH } from "@/lib/analytics/databases/config";

/**
 * The check on a query someone types for an external database source
 * (decision 603). Tohyee only ever reads: a typed query must be one SELECT
 * (or WITH ... SELECT), and words that change data or reach outside the
 * database are refused wherever they appear outside quotes. This is one
 * layer of three: the query also runs inside a read-only transaction where
 * the database has one (PostgreSQL, MySQL) and inside Tohyee's own outer
 * SELECT, and people are asked to connect as a user that can only read.
 *
 * Returns the query as it will be sent: comments removed (so what was
 * checked is what runs, including MySQL's /*! ... *\/ comments, which MySQL
 * would otherwise run) and any final semicolon dropped.
 */

/** Words that only appear in statements that change something. */
const FORBIDDEN_WORDS = new Set([
  "insert",
  "update",
  "delete",
  "merge",
  "upsert",
  "drop",
  "create",
  "alter",
  "truncate",
  "grant",
  "revoke",
  "deny",
  "exec",
  "execute",
  "call",
  "copy",
  "into",
  "lock",
  "unlock",
  "set",
  "declare",
  "prepare",
  "deallocate",
  "commit",
  "rollback",
  "savepoint",
  "vacuum",
  "reindex",
  "listen",
  "unlisten",
  "notify",
  "kill",
  "shutdown",
  "backup",
  "restore",
  "dbcc",
  "bulk",
  "waitfor",
  "openrowset",
  "opendatasource",
  "openquery",
  "outfile",
  "dumpfile",
]);

/** Functions that change something, read the server's files or reach another server. Refused when called. */
const FORBIDDEN_FUNCTIONS = new Set([
  "nextval",
  "setval",
  "set_config",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_read_file",
  "pg_read_binary_file",
  "pg_stat_file",
  "pg_switch_wal",
  "pg_promote",
  "pg_notify",
  "pg_logical_emit_message",
  "load_file",
  "get_lock",
  "release_lock",
  "release_all_locks",
  "sys_exec",
  "sys_eval",
  // Run a query given as text, which this check can't read (#700, decision 1635).
  "query_to_xml",
  "query_to_xml_and_xmlschema",
  "query_to_xmlschema",
  "table_to_xml",
  "table_to_xml_and_xmlschema",
  "table_to_xmlschema",
  "cursor_to_xml",
  "cursor_to_xmlschema",
  "schema_to_xml",
  "schema_to_xml_and_xmlschema",
  "schema_to_xmlschema",
  "database_to_xml",
  "database_to_xml_and_xmlschema",
  "database_to_xmlschema",
  // Hold the connection without doing anything.
  "sleep",
  "benchmark",
]);

const FORBIDDEN_FUNCTION_PREFIXES = ["pg_advisory", "pg_try_advisory", "pg_ls_", "pg_create_", "pg_drop_", "pg_sleep", "pg_file_", "lo_", "dblink"];

function forbiddenFunction(name: string): boolean {
  return FORBIDDEN_FUNCTIONS.has(name) || FORBIDDEN_FUNCTION_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** `name`: for a quoted name ("x", `x`, [x]), what's inside it, so a refused function can't be called by quoting its name. */
type Token = { kind: "word" | "symbol"; text: string; depth: number; name?: string };

function refuse(message: string): never {
  throw new ValidationError(message);
}

/** Splits the query into words and symbols, skipping quoted text and comments. */
function scan(sql: string, engine: DatabaseEngine): { tokens: Token[]; cleaned: string } {
  const tokens: Token[] = [];
  let cleaned = "";
  let depth = 0;
  let i = 0;
  const backslashEscapes = engine === "mysql";
  const readQuoted = (close: string, escapes: boolean): string => {
    const start = i;
    i += 1;
    while (i < sql.length) {
      const char = sql[i];
      if (escapes && char === "\\") {
        i += 2;
        continue;
      }
      if (char === close) {
        if (sql[i + 1] === close) {
          i += 2;
          continue;
        }
        i += 1;
        cleaned += sql.slice(start, i);
        return sql.slice(start + 1, i - 1).split(close + close).join(close);
      }
      i += 1;
    }
    return refuse("The query has a quote that isn't closed.");
  };
  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];
    if (char === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      cleaned += " ";
      continue;
    }
    if (char === "#" && engine === "mysql") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      cleaned += " ";
      continue;
    }
    if (char === "/" && next === "*") {
      // PostgreSQL's block comments nest; the others end at the first */.
      let nested = 1;
      i += 2;
      while (i < sql.length && nested > 0) {
        if (engine === "postgres" && sql[i] === "/" && sql[i + 1] === "*") {
          nested += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          nested -= 1;
          i += 2;
        } else i += 1;
      }
      if (nested > 0) refuse("The query has a comment that isn't closed.");
      cleaned += " ";
      continue;
    }
    if (char === "'") {
      // E'...' strings in PostgreSQL use backslash escapes.
      const escaped = backslashEscapes || (engine === "postgres" && /(^|[^A-Za-z0-9_$])[eE]$/.test(sql.slice(Math.max(0, i - 2), i)));
      readQuoted("'", escaped);
      tokens.push({ kind: "symbol", text: "'", depth });
      continue;
    }
    if (char === '"') {
      // PostgreSQL's U&"..." spells a name with escapes (U&"pg\005Fread_file"), which would hide it from this check.
      if (engine === "postgres" && /(^|[^A-Za-z0-9_$])u&$/i.test(sql.slice(Math.max(0, i - 3), i))) refuse('A name written as U&"..." can\'t be used here. Write the name as it is.');
      const name = readQuoted('"', backslashEscapes);
      tokens.push({ kind: "symbol", text: '"', depth, name: name.toLowerCase() });
      continue;
    }
    if (char === "`" && engine === "mysql") {
      const name = readQuoted("`", false);
      tokens.push({ kind: "symbol", text: "`", depth, name: name.toLowerCase() });
      continue;
    }
    if (char === "[" && engine === "sqlserver") {
      const name = readQuoted("]", false);
      tokens.push({ kind: "symbol", text: "[", depth, name: name.toLowerCase() });
      continue;
    }
    if (char === "$" && engine === "postgres") {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        if (end < 0) refuse("The query has a quote that isn't closed.");
        cleaned += sql.slice(i, end + tag[0].length);
        i = end + tag[0].length;
        tokens.push({ kind: "symbol", text: "$", depth });
        continue;
      }
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_$#@]*/.exec(sql.slice(i))!;
      tokens.push({ kind: "word", text: match[0].toLowerCase(), depth });
      cleaned += match[0];
      i += match[0].length;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth < 0) refuse("The query has a ) without a matching (.");
    }
    if (!/\s/.test(char)) tokens.push({ kind: "symbol", text: char, depth: char === "(" ? depth - 1 : depth });
    cleaned += char;
    i += 1;
  }
  if (depth !== 0) refuse("The query has a ( without a matching ).");
  return { tokens, cleaned };
}

export function checkReadOnlyQuery(input: unknown, engine: DatabaseEngine): string {
  if (typeof input !== "string" || !input.trim()) refuse("Write a SELECT query.");
  if (input.length > MAX_QUERY_LENGTH) refuse(`A query can be up to ${MAX_QUERY_LENGTH.toLocaleString("en-NZ")} characters.`);
  if (input.includes("\0")) refuse("The query has a character that can't be sent.");
  const { tokens, cleaned } = scan(input, engine);

  // One statement: a semicolon may only end it.
  const semicolon = tokens.findIndex((token) => token.text === ";");
  if (semicolon >= 0 && tokens.slice(semicolon).some((token) => token.text !== ";")) {
    refuse("Write one query only. Tohyee runs a single SELECT.");
  }
  const meaningful = tokens.filter((token) => token.text !== ";");
  const first = meaningful.find((token) => token.text !== "(");
  if (!first || first.kind !== "word" || (first.text !== "select" && first.text !== "with")) {
    refuse("Only SELECT queries can be used (a query may start with WITH). Tohyee only reads from the database.");
  }
  for (let index = 0; index < meaningful.length; index += 1) {
    const token = meaningful[index];
    const after = meaningful[index + 1];
    // A refused function called by its quoted name: "pg_read_file"('...').
    if (token.name !== undefined && after?.text === "(" && forbiddenFunction(token.name.trim())) {
      refuse(`Tohyee only reads from the database, so a query can't call ${token.name.trim()}().`);
    }
    if (token.kind !== "word") continue;
    if (FORBIDDEN_WORDS.has(token.text)) {
      refuse(`Tohyee only reads, so a query can't use ${token.text.toUpperCase()}. Put the name in quotes if it's a column or table.`);
    }
    if (token.text === "for" && after?.kind === "word" && (after.text === "share" || after.text === "key" || after.text === "no")) {
      refuse("Tohyee only reads, so a query can't lock rows (FOR SHARE).");
    }
    if (after?.text === "(" && forbiddenFunction(token.text)) {
      refuse(`Tohyee only reads from the database, so a query can't call ${token.text}().`);
    }
  }
  if (engine === "sqlserver") {
    // SQL Server refuses ORDER BY inside the SELECT Tohyee wraps around it.
    const order = meaningful.findIndex((token, index) => token.depth === 0 && token.text === "order" && meaningful[index + 1]?.text === "by");
    if (order >= 0) refuse("Leave out ORDER BY: SQL Server doesn't allow it here, and the order rows load in doesn't change reports.");
  }
  return cleaned.replace(/[\s;]+$/, "").trim();
}
