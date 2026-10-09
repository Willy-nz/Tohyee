import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PostgreSQL reads a plain name in ORDER BY as an output column first, so
 * `select id::text ... order by id` sorts the ids as text ("9" after "10").
 * That showed Home's recent journals out of order and could pick the wrong
 * "latest" leave liability posting once there were ten. The ORDER BY must
 * name the table's column (`order by ledger_journals.id`). Dates cast to text
 * sort the same either way, so only number-like columns are checked.
 */
function sources(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const full = path.join(folder, name);
    if (statSync(full).isDirectory()) return name === "migrations" ? [] : sources(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

const NUMBER_LIKE = /^(id|factor|\w+_number)$/;

describe("ORDER BY and text casts", () => {
  it("never orders by a number-like column that the select list cast to text", () => {
    const offenders: string[] = [];
    for (const file of [...sources("src"), ...sources("scripts")]) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/`[^`]*`|"[^"\n]*"/g)) {
        const query = match[0].toLowerCase();
        const at = query.lastIndexOf("order by");
        // An UPDATE ... RETURNING orders in its subquery, where the column is still a number.
        if (at === -1 || query.includes("returning")) continue;
        const orderBy = query.slice(at);
        const casts = [...query.slice(0, at).matchAll(/(?<![\w.])(\w+)::text(?:\s+as\s+(\w+))?/g)].map((cast) => cast[2] ?? cast[1]);
        for (const column of new Set(casts)) {
          if (!NUMBER_LIKE.test(column)) continue;
          if (new RegExp(`(?<![\\w.])${column}\\b(?!\\s*::)`).test(orderBy)) {
            offenders.push(`${file}:${text.slice(0, match.index).split("\n").length} orders by ${column}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
