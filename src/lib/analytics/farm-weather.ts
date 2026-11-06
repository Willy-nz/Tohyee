import type { TableCopy } from "@/lib/analytics/engine";
import type { OrgTx } from "@/lib/db/org-transaction";
import { METSERVICE_ATTRIBUTION, type ForecastHour } from "@/lib/weather/forecast-rules";

/*
 * Kept MetService forecasts in the analytics file (decision 1549):
 * `tohyee_farm_weather_forecasts`, an hour a row of each forecast record,
 * only while an admin has turned on both feature switches (keeping
 * records, and combining them with the farm's own data). Otherwise there's
 * no such table: the latest forecast alone is never copied. Each row
 * carries MetService's credit.
 */
export const WEATHER_TABLE = "tohyee_farm_weather_forecasts";

export async function readWeatherTables(tx: OrgTx): Promise<TableCopy[]> {
  const settings = await tx.query<{ keep_records: boolean; combine: boolean }>("select keep_records, combine from weather_settings where id = true");
  if (!settings.rows[0]?.keep_records || !settings.rows[0]?.combine) return [];
  const records = await tx.query<{ id: string; farm: string; latitude: string; longitude: string; fetched_at: string; hours: ForecastHour[] }>(
    `select h.id::text, f.name as farm, h.latitude::text, h.longitude::text, to_char(h.fetched_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') as fetched_at, h.hours
       from weather_forecast_history h join farms f on f.id = h.farm_id order by h.fetched_at, h.id`,
  );
  return [
    {
      name: WEATHER_TABLE,
      columns: [
        { name: "record_id", type: "BIGINT" },
        { name: "farm", type: "VARCHAR" },
        { name: "latitude", type: "DECIMAL(9,6)" },
        { name: "longitude", type: "DECIMAL(9,6)" },
        { name: "fetched_at_utc", type: "TIMESTAMP" },
        { name: "forecast_for_utc", type: "TIMESTAMP" },
        { name: "rain_mm", type: "DECIMAL(7,1)" },
        { name: "temperature_c", type: "DECIMAL(5,1)" },
        { name: "wind_kmh", type: "DECIMAL(5,0)" },
        { name: "wind_direction", type: "DECIMAL(4,0)" },
        { name: "gust_kmh", type: "DECIMAL(5,0)" },
        { name: "source", type: "VARCHAR" },
      ],
      rows: records.rows.flatMap((record) =>
        record.hours.map((hour) => [record.id, record.farm, record.latitude, record.longitude, record.fetched_at, utc(hour.at), hour.rainMm, hour.temperatureC, hour.windKmh, hour.windDirection, hour.gustKmh, METSERVICE_ATTRIBUTION]),
      ),
    },
  ];
}

/** "2026-11-05T10:00:00Z" as DuckDB's plain timestamp, in UTC. */
function utc(at: string): string {
  return new Date(at).toISOString().slice(0, 19).replace("T", " ");
}
