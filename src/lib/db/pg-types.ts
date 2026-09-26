import pg from "pg";

const DATE_OID = 1082;
const TIMESTAMPTZ_OID = 1184;

const defaultTimestampTzParser = pg.types.getTypeParser(TIMESTAMPTZ_OID, "text") as (
  value: string,
) => Date;

/**
 * Type parsers for every pool Tohyee opens.
 *
 * - DATE stays a plain "YYYY-MM-DD" string. The pg default turns it into a
 *   JavaScript Date at local midnight, which broke date comparisons in
 *   earlier versions (lock dates, replay checks, backdating) and shifts dates
 *   by a day on servers outside UTC.
 * - TIMESTAMPTZ becomes an ISO-8601 string so API payloads are predictable.
 * - NUMERIC and INT8 already arrive as strings, which is what we want.
 */
export const toeyeeTypes: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: string) => {
    if (format === undefined || format === "text") {
      if (oid === DATE_OID) {
        return (value: string) => value;
      }
      if (oid === TIMESTAMPTZ_OID) {
        return (value: string) => {
          const parsed = defaultTimestampTzParser(value);
          return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
        };
      }
    }
    return pg.types.getTypeParser(oid, format as "text");
  }) as pg.CustomTypesConfig["getTypeParser"],
};
