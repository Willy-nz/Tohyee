import packageJson from "../../../package.json";
import { classifyAnswer, FORECAST_HOURS, type WeatherChoice, type WeatherStatus, forecastRequest, variablesFor } from "@/lib/weather/forecast-rules";

/*
 * Where forecasts come from (decision 1542). The live provider calls
 * MetService's Point Forecast API with the organisation's own key: POST
 * https://forecast-v2.metoceanapi.com/point/time, the key in the x-api-key
 * header and a User-Agent (MetService refuses requests without one). The
 * request and answer follow MetService's developer docs; none of it has
 * been tried against the live service yet.
 *
 * TOHYEE_WEATHER_PROVIDER=fake swaps in a made-up forecast, for the demo,
 * screenshots and tests: no network calls, and some keys act out
 * MetService's refusals (see FAKE_KEYS).
 */

export const METSERVICE_POINT_URL = "https://forecast-v2.metoceanapi.com/point/time";

export type ForecastAnswer = { body: unknown; unitsCharged: number | null };

/** A refusal or failure from the provider, already sorted into what it means. */
export class WeatherProviderError extends Error {
  readonly status: WeatherStatus;
  constructor(status: WeatherStatus, message: string) {
    super(message);
    this.status = status;
  }
}

export type WeatherProvider = {
  fetchForecast(input: { apiKey: string; point: { latitude: string; longitude: string }; choices: readonly WeatherChoice[]; now: Date; hours?: number }): Promise<ForecastAnswer>;
};

const MAX_ANSWER_BYTES = 2 * 1024 * 1024;

function userAgent(): string {
  return `Tohyee/${packageJson.version} (+https://github.com/Willy-nz/tohyee)`;
}

export const metServiceProvider: WeatherProvider = {
  async fetchForecast({ apiKey, point, choices, now, hours = FORECAST_HOURS }) {
    const body = forecastRequest(point, choices, now);
    body.time.repeat = Math.max(0, hours - 1);
    let response: Response;
    try {
      response = await fetch(METSERVICE_POINT_URL, {
        method: "POST",
        headers: { "x-api-key": apiKey, "user-agent": userAgent(), accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
        redirect: "error",
      });
    } catch {
      throw new WeatherProviderError("error", "MetService couldn't be reached.");
    }
    const text = await response.text();
    if (text.length > MAX_ANSWER_BYTES) throw new WeatherProviderError("error", "MetService's answer was bigger than expected.");
    if (!response.ok) {
      // The message MetService sends, if any, sorts the answer; it's never shown as it is (it could carry anything).
      let message = "";
      try {
        const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
        message = String(parsed.message ?? parsed.error ?? "");
      } catch {
        message = text.slice(0, 300);
      }
      throw new WeatherProviderError(classifyAnswer(response.status, message), `MetService answered ${response.status}.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new WeatherProviderError("error", "MetService's answer wasn't JSON.");
    }
    const charge = Number(response.headers.get("x-charge-amount"));
    return { body: parsed, unitsCharged: Number.isFinite(charge) && response.headers.has("x-charge-amount") ? charge : null };
  },
};

/** Keys the fake provider refuses, as MetService would (for tests and the screenshots). */
export const FAKE_KEYS = { badKey: "fake-bad-key", noUnits: "fake-no-units", notAllowed: "fake-not-allowed", down: "fake-down" } as const;

/** A made-up but steady forecast: the same point and hour always give the same numbers. */
export const fakeProvider: WeatherProvider = {
  async fetchForecast({ apiKey, point, choices, now, hours = FORECAST_HOURS }) {
    if (apiKey === FAKE_KEYS.badKey) throw new WeatherProviderError("bad_key", "MetService answered 401.");
    if (apiKey === FAKE_KEYS.noUnits) throw new WeatherProviderError("no_units", "MetService answered 402.");
    if (apiKey === FAKE_KEYS.notAllowed) throw new WeatherProviderError("not_allowed", "MetService answered 403.");
    if (apiKey === FAKE_KEYS.down) throw new WeatherProviderError("error", "MetService couldn't be reached.");
    const request = forecastRequest(point, choices, now);
    const start = Date.parse(request.time.from);
    const times = Array.from({ length: hours }, (_, index) => new Date(start + index * 3_600_000).toISOString().replace(".000Z", "Z"));
    const seed = Math.abs(Math.round(Number(point.latitude) * 1000 + Number(point.longitude) * 100));
    const values = (variable: string) =>
      times.map((time) => {
        const t = Date.parse(time) / 3_600_000;
        const hourOfDay = (new Date(time).getUTCHours() + 13) % 24;
        const wave = Math.sin(((t + seed) / 24) * Math.PI * 2);
        if (variable === "precipitation.rate") return Math.max(0, Math.round((Math.sin((t + seed) / 9) * 1.5 + Math.sin((t + seed) / 31) * 1.5 - 1.6) * 10) / 10);
        // Mild days, with one cold night in the week for a frost risk.
        const coldNight = Math.floor((t + seed) / 24) % 7 === 3 && (hourOfDay < 8 || hourOfDay > 21) ? 7 : 0;
        if (variable === "air.temperature.at-2m") return 273.15 + 11 + 5 * Math.sin(((hourOfDay - 9) / 24) * Math.PI * 2) + 2 * Math.sin((t + seed) / 50) - coldNight;
        if (variable === "wind.speed.at-10m") return Math.round((5 + 3 * Math.abs(wave)) * 10) / 10;
        if (variable === "wind.speed.gust.at-10m") return Math.round((9 + 6 * Math.abs(wave)) * 10) / 10;
        return Math.round((270 + 60 * wave + 360) % 360);
      });
    const units: Record<string, string> = { "precipitation.rate": "mm/h", "air.temperature.at-2m": "K", "wind.speed.at-10m": "m/s", "wind.speed.gust.at-10m": "m/s", "wind.direction.at-10m": "degree" };
    const variables = Object.fromEntries(
      variablesFor(choices).map((variable) => [variable, { units: units[variable], dimensions: ["time", "point"], data: values(variable), noData: times.map(() => 0) }]),
    );
    return {
      body: { dimensions: { point: { type: "point", data: [{ lon: Number(point.longitude), lat: Number(point.latitude) }] }, time: { type: "time", data: times } }, noDataReasons: { GOOD: 0 }, variables },
      unitsCharged: variablesFor(choices).length,
    };
  },
};

let override: WeatherProvider | null = null;

/** Tests swap the provider; null puts it back. */
export function setWeatherProviderForTests(provider: WeatherProvider | null): void {
  override = provider;
}

export function weatherProvider(): WeatherProvider {
  if (override) return override;
  return process.env.TOHYEE_WEATHER_PROVIDER === "fake" ? fakeProvider : metServiceProvider;
}

/** Whether the made-up forecast is in use, so the page can say so. */
export function usingFakeProvider(): boolean {
  return !override && process.env.TOHYEE_WEATHER_PROVIDER === "fake";
}
