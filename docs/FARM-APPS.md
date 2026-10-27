# Building farm apps on Tohyee

Tohyee's **Farming API** lets a small app read farm data and record field
work without touching the accounting side. It's meant for apps people build
themselves, often with an AI coding tool. Rules: examples FA1-FA8 in
[ACCOUNTING-EXAMPLES.md](ACCOUNTING-EXAMPLES.md) and decision 561.

## Get a key

1. In Tohyee, open **Farm › Farm apps**.
2. Name the app and tick only what it needs:

   | Scope | Lets the app |
   | --- | --- |
   | `read_farm` | read farms, paddocks, areas and shapes (GeoJSON) |
   | `read_soil` | read soil tests and field samples |
   | `read_pasture` | read pasture cover, the feed wedge and readings |
   | `record_soil_samples` | record soil samples taken in the field |
   | `record_pasture` | record pasture cover readings |

   Recording needs the bookkeeper role or higher.
3. Copy the key (`tohyee_app_…`). It's shown once.

The key acts as you, in one organisation, with only those scopes. It never
reaches the books, payroll, contacts or the AI tools. Revoke it on the same
page. It also stops if you leave the organisation or your password or
two-step sign-in is reset.

## Call the API

- Base address: `https://<your Tohyee address>/api/farm-apps/v1`
- Every request: `Authorization: Bearer tohyee_app_…`
- The contract: `GET /api/farm-apps/v1/openapi.json` (OpenAPI 3.1, no key
  needed). Give it to your AI tool. If Tohyee is behind remote access, check
  the `servers` address in it is the one you use.
- Answers are JSON. Errors are `{ "error": "…", "code": "…" }` with a
  message you can show the person: 401 no or bad key, 403 the key can't do
  that, 404 not found, 400 or 422 something to fix, 429 slow down (120
  requests a minute per key).
- Browsers on any site can call it (CORS), because only the key lets an
  app in. Keep the key out of public code: for an app others use, have each
  person paste their own key, as the sample does.
- With one farm, `farmId` can be left out; with more, `GET /farms` lists
  them.

| | Scope | |
| --- | --- | --- |
| `GET /me` | any | the organisation, person, key name and scopes it may use now |
| `GET /farms` | `read_farm` | farms with paddocks, areas and shapes |
| `GET /soil/paddocks` | `read_soil` | each paddock's latest test date, never tested first |
| `GET /soil/tests` | `read_soil` | tests with results as the lab reported them |
| `GET /soil/samples` | `read_soil` | samples taken in the field |
| `POST /soil/samples` | `record_soil_samples` | `{ paddockId, takenOn, sampleName?, depth?, latitude?, longitude?, note? }` |
| `GET /pasture/cover` | `read_pasture` | cover, feed wedge and growth on `onDate` |
| `GET /pasture/readings` | `read_pasture` | cover readings, newest first, up to 1,000 a page (`from`, `to`, `paddockId`, `limit`, `cursor`); `next` is the cursor for the next page, or null |
| `POST /pasture/readings` | `record_pasture` | `{ paddockId, measuredOn, cover, method, note?, operationId? }`; send the same `operationId` (a UUID your app makes) when retrying and the reading is made once |

## What Tohyee won't decide for your app

Tohyee records and reports; it doesn't judge. There's no "due for a soil
test" rule, no high or low result and no feed target. If your app has a
rule (say, test every two years), say so on screen so the person knows it's
the app's rule, not Tohyee's or their adviser's.

## The sample: soil sampling

[`examples/farm-apps/soil-sampling/index.html`](../examples/farm-apps/soil-sampling/index.html)
is one file with no build step. It lists paddocks by their last soil test
(with its own changeable "due" rule), records a sample with the phone's
location, and shows samples taken. Open it in a browser, or put it on any
web host. Samples it records show in Tohyee under Soil tests › Samples
taken, marked with the app's name.

## Prompt for an AI coding tool

> Build a small web app for my farm using the Tohyee Farming API. The
> OpenAPI contract is at `https://<address>/api/farm-apps/v1/openapi.json`.
> Ask me for my Tohyee address and app key and keep them in the browser
> only. Use only the endpoints in the contract. Show Tohyee's error messages
> as they come. Don't invent agronomic rules; if the app needs one, let me
> set it and label it as the app's own.

## Versions

This is `v1`. A breaking change gets a new version (`/v2`), and `v1` keeps
working until it's retired with notice in the release notes.
