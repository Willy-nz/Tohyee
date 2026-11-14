import { describe, expect, it } from "vitest";
import { FORMAT_EXAMPLES, FORMAT_SCHEMA } from "@/lib/ai/analytics-tools";
import { parseChartFormat } from "@/lib/analytics/chart-format";

/**
 * What the AI is told a tile's format takes (#689) has to be what
 * parseChartFormat keeps: a key it drops would be a promise the report
 * doesn't keep.
 */
type Schema = { type?: string; enum?: unknown[]; properties?: Record<string, Schema>; items?: Schema; minimum?: number; pattern?: string; maxItems?: number };

/** A value the schema allows, with every key set. */
function sample(schema: Schema, key = ""): unknown {
  if (schema.enum) return schema.enum[schema.enum.length - 1];
  if (schema.type === "object") return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, child]) => [name, sample(child, name)]));
  if (schema.type === "array") return [sample(schema.items ?? {}, key)];
  if (schema.type === "boolean") return true;
  if (schema.type === "integer") return Math.max(schema.minimum ?? 0, key === "percentile" ? 90 : key === "decimals" ? 1 : (schema.minimum ?? 0));
  if (schema.pattern) return "#1f5fae";
  return key === "value" || key === "to" || key === "min" || key === "max" || key === "target" ? (key === "min" ? "0" : key === "to" || key === "max" ? "200" : "100") : "Words";
}

/** Every path with a plain value, e.g. series.0.number.style. */
function paths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => paths(entry, `${prefix}${index}.`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, child]) => paths(child, `${prefix}${key}.`));
  return [prefix.slice(0, -1)];
}

describe("the AI's format schema (#689)", () => {
  it("lists only keys parseChartFormat keeps", () => {
    const properties = (FORMAT_SCHEMA as Schema).properties!;
    for (const [name, child] of Object.entries(properties)) {
      // One top-level key at a time, so one that's refused names itself.
      const given = { [name]: sample(child, name) };
      // A reference line is one kind at a time: check a constant line and a band.
      if (name === "referenceLines") {
        const line = (given[name] as Array<Record<string, unknown>>)[0];
        given[name] = [{ kind: "constant", value: "100", label: line.label, color: line.color, style: line.style }, { kind: "band", value: "100", to: "200" }, { kind: "percentile", percentile: 90 }];
      }
      if (name === "histogram") given[name] = { bins: 10 };
      const kept = parseChartFormat(given) ?? {};
      const missing = paths(given).filter((path) => !paths(kept).includes(path));
      expect(missing, `${name}: parseChartFormat dropped ${missing.join(", ")}`).toEqual([]);
    }
  });

  it("has examples that are accepted whole", () => {
    for (const [name, example] of Object.entries(FORMAT_EXAMPLES)) {
      const kept = parseChartFormat(example.format) ?? {};
      expect(paths(kept).sort(), name).toEqual(paths(example.format).sort());
    }
  });
});
