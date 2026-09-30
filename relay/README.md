# Tohyee address (the relay)

This folder is a small, separate program that runs on **your** Cloudflare
account as a Cloudflare Worker. It gives each Tohyee server that asks for one a
web address like `k7m2q9x.tohyee.example`, so people can open their Tohyee on
their phone without anyone signing up for anything.

It's separate from the Tohyee app itself. It has its own `package.json`, its own
tests, and nothing in the main app's build or tests touches it.

## How it works

1. A Tohyee server (when its owner ticks "phone access") sends this Worker the
   port it's running on and a random ID it made up for itself.
2. The Worker uses your Cloudflare API token to:
   - create a Cloudflare Tunnel (managed from Cloudflare's side),
   - tell the tunnel that `<random name>.<your domain>` goes to
     `http://localhost:<that port>` on the Tohyee server (never anywhere else),
   - add a DNS record for `<random name>.<your domain>` pointing at the tunnel.
3. It sends back the address, the tunnel's token, and a **release key**.
4. The Tohyee server runs Cloudflare's `cloudflared` program with the token.
   From then on, a phone talks to Cloudflare, and Cloudflare talks to the Tohyee
   server through the tunnel. **Accounting data never goes through this Worker.**

The names are random, 7 characters, with no vowels (so they can't spell words)
and no `0`, `o`, `1`, `l` or `i` (so they're easy to read out). Nobody gets to
choose one.

### What the Worker stores

In a small Cloudflare D1 database: each address, its tunnel and DNS record IDs,
the port, the Tohyee version, and **hashes** (one-way fingerprints) of the
server's ID and release key. It doesn't store the tunnel token, the release key,
the server's ID, or anyone's IP address. Rate-limit counters are keyed by a hash
of the IP address and deleted after two days.

The logs only show things like "Created address k7m2q9x.tohyee.example" and
Cloudflare error codes.

## The API (for the Tohyee app)

| Request | Answer |
| --- | --- |
| `POST /v1/addresses` with `{"port": 3000, "installId": "...", "version": "0.2.2"}` | `201 {"hostname", "tunnelToken", "releaseKey"}` |
| `DELETE /v1/addresses/<hostname>` with `Authorization: Bearer <releaseKey>` | `204` |
| `GET /v1/health` | `200 {"ok": true, "registrationsOpen": true, "abuseContact": "..."}` |

Errors are `{"error": "a plain-English message"}` with status 400 (bad request),
401 (wrong or missing release key), 403 (this address has been switched off),
404, 429 (too many requests today) or 503 (switched off, full, or Cloudflare had
a problem; try later).

- `installId` must be 16–128 letters, digits, `-` or `_`. The server should make
  it randomly once and keep it. **Treat it like a password**: whoever has it can
  get that server's address and tunnel token.
- `port` must be a whole number from 1 to 65535.
- **Asking again with the same `installId`** returns the same address and the
  tunnel token, with status 201, and a **new** release key. The old release key
  stops working. That way a server that lost its release key can still give its
  address back. If the port has changed, the tunnel is updated to the new port.
- After an address is released, the same `installId` can ask again and gets a
  new random address.

## One-time setup

You need a computer with [Node.js](https://nodejs.org/) 20 or later. All the
commands below are run in this `relay` folder.

### 1. Cloudflare account

1. Sign up at <https://dash.cloudflare.com/sign-up> (the free plan is fine).
2. Turn on two-step sign-in: **My Profile → Authentication → Two-Factor
   Authentication**. Please do this: whoever gets into this account can control
   every Tohyee address.

### 2. The domain

1. Buy a domain (for example through **Domain Registration** in the Cloudflare
   dashboard, which makes the next step automatic), or add one you already own
   with **Add a domain** and follow the steps to change its nameservers.
2. Wait until the dashboard says the domain is **Active**.
3. In `wrangler.jsonc`, change every `tohyee.example` to your domain (the
   `DOMAIN` setting, the `routes` pattern and the `ABUSE_CONTACT` email).
4. Set up an email address for `ABUSE_CONTACT` that you actually read (Cloudflare
   **Email Routing** can forward one to your normal inbox for free).

### 3. Sign Wrangler in

Wrangler is Cloudflare's command-line tool. It's installed with the other
tools:

```sh
npm install
npx wrangler login
```

A browser window opens; sign in and allow access.

### 4. The API token the Worker uses

This token lets the Worker create and delete tunnels and DNS records. Give it
**only** these permissions:

1. Dashboard → **My Profile → API Tokens → Create Token → Create Custom Token**.
2. Name: `Tohyee address`.
3. Permissions:
   - **Account** → **Cloudflare Tunnel** → **Edit**
   - **Zone** → **DNS** → **Edit**
4. Account Resources: **Include** → your account.
5. Zone Resources: **Include** → **Specific zone** → your domain.
6. Leave the IP filtering and TTL empty, then **Continue to summary → Create
   Token**. Copy the token (it's shown only once).

> TO VERIFY: Cloudflare's guide lists these as "Cloudflare Tunnel Edit"
> (account) and "DNS Edit" (zone). The API reference also accepts newer names
> ("Cloudflare One Connectors Write" or "Cloudflare One Connector: cloudflared
> Write"). If you can't see "Cloudflare Tunnel" in the list, choose the
> "Cloudflare One Connector: cloudflared" one with **Edit**.

Save it into the Worker as a secret (it's never written into any file):

```sh
npx wrangler secret put CF_API_TOKEN
```

### 5. Account ID and zone ID

In the dashboard, open your domain. On its **Overview** page, the right-hand
column shows **Zone ID** and **Account ID**. Copy them into `ACCOUNT_ID` and
`ZONE_ID` in `wrangler.jsonc`. (These aren't secret.)

### 6. The database

```sh
npx wrangler d1 create tohyee-relay
```

It prints a `database_id`. Paste it into `wrangler.jsonc` in place of the
zeros. Then create the tables:

```sh
npm run db:setup
```

### 7. The admin password

Make up a long random password (at least 20 characters; a password manager can
make one) and store it:

```sh
npx wrangler secret put ADMIN_TOKEN
```

You'll need it to switch addresses off. Keep it in your password manager.

### 8. Deploy

```sh
npm test
npm run deploy
```

Wrangler sets up `api.<your domain>` for the Worker. Check it:

```sh
curl https://api.<your domain>/v1/health
```

You should see `{"ok":true,"registrationsOpen":true,...}`. The Tohyee app needs
to know this address (`https://api.<your domain>`).

To change a setting later, edit `wrangler.jsonc` and run `npm run deploy`
again. To replace a secret, run the same `wrangler secret put` command.

## Costs and limits

- **Workers free plan**: 100,000 requests a day and 10 ms of CPU time per
  request. This Worker uses far less than both: a Tohyee server only calls it
  when phone access is turned on or off.
- **D1 free plan**: 5 million rows read and 100,000 rows written a day, 5 GB in
  total. Each request writes a few rows.
- **Cloudflare Tunnel**: no charge. Cloudflare allows **1,000 tunnels per
  account**, so the Worker stops handing out new addresses at `MAX_ACTIVE`
  (900 to start with) and keeps the rest for you.
- **The domain**: the yearly registration fee.
- If you go over a free limit, Cloudflare stops that part working until the
  next day (midnight UTC); nothing is charged unless you upgrade.

Built-in limits (change them in `wrangler.jsonc`):

| Setting | Starts at | What it does |
| --- | --- | --- |
| `NEW_PER_IP_PER_DAY` | 3 | New addresses one network (IP address) can get in a day |
| `REQUESTS_PER_IP_PER_DAY` | 30 | Requests of any kind one network can make in a day |
| `NEW_PER_DAY` | 100 | New addresses for everyone together in a day |
| `MAX_ACTIVE` | 900 | Addresses in use at once (never more than 1,000) |

Too many requests get a friendly "try again tomorrow" (status 429).

## Switching things off

Set these up once in a terminal (use your own domain and password):

```sh
export RELAY_URL=https://api.tohyee.example
export ADMIN_TOKEN='your admin password'
```

Then:

| To | Run |
| --- | --- |
| See every address | `./scripts/admin.sh list` |
| Switch **one** address off (for example after an abuse report) | `./scripts/admin.sh block k7m2q9x.tohyee.example` |
| Let that server have a (new) address again | `./scripts/admin.sh unblock k7m2q9x.tohyee.example` |
| Stop **all new** addresses (existing ones keep working) | `./scripts/admin.sh stop-new` |
| Start new addresses again | `./scripts/admin.sh start-new` |

Blocking removes the DNS record straight away, so the address stops working at
once, and then deletes the tunnel. The same server can't get an address again
until you unblock it.

**In an emergency** (for example if the API token leaks): in the dashboard,
**My Profile → API Tokens**, roll or delete the `Tohyee address` token. Nothing
new can be created and nothing can be removed until you put a new token in with
`npx wrangler secret put CF_API_TOKEN`. Existing addresses keep working. To stop
**every** address at once, delete the DNS records for your domain in the
dashboard, or remove the Worker's route.

If you'd rather not use the script, the same switches are in the database:

```sh
npx wrangler d1 execute tohyee-relay --remote --command "UPDATE settings SET value = '0' WHERE key = 'registrations_open'"
```

(`'1'` switches new addresses back on.)

## Tidying up

Once a day (14:17 UTC, early morning in New Zealand) the Worker:

- deletes rate-limit counters older than two days,
- finishes deleting tunnels that were still connected when they were released
  (Cloudflare won't delete a connected tunnel; the DNS record is always removed
  first, so the address stops working straight away),
- clears out any address whose set-up was interrupted.

Addresses whose Tohyee server has simply been switched off for good aren't
removed automatically yet. Look through `./scripts/admin.sh list` now and then
if you get close to `MAX_ACTIVE`.

## What you're responsible for

- **Your Cloudflare account**: keep two-step sign-in on and the API token and
  admin password private.
- **The domain**: renew it each year. If it lapses, every Tohyee address stops
  working.
- **Abuse reports**: all the addresses are under your domain, so reports about
  them will come to you (and to Cloudflare). Read the `ABUSE_CONTACT` inbox and
  use `block` when needed.
- **Cloudflare's terms**: you're the Cloudflare customer for everything the
  Worker creates. Cloudflare's Self-Serve Subscription Agreement (section
  2.2.1(a)) says you must not "rent, lease, loan, export, or sell access to the
  Services to any third party, or sign up for the Services on behalf of a third
  party", and the Zero Trust service terms say "You shall not resell Cloudflare
  Zero Trust to any third parties ... unless expressly permitted by Cloudflare in
  writing". This service is free and creates tunnels in your own account, but it
  does let other people's servers use tunnels. **Check with Cloudflare before
  relying on this for lots of people** (their sales or trust team can confirm in
  writing).
- **Privacy**: the Worker keeps the little listed under "What the Worker
  stores". Cloudflare, as the network in the middle, handles the traffic for
  every address under its own privacy policy; Tohyee's own privacy note should
  say so.

## Developing

```sh
npm install
npm test          # runs in Cloudflare's local Workers runtime; Cloudflare's API is faked
npm run typecheck
```

`npm install` was done with npm 11 (`npx npm@11 install`), because npm 10 hit an
internal error resolving the test tools' optional peer packages.

### Cloudflare API calls used

All with `Authorization: Bearer <CF_API_TOKEN>` against
`https://api.cloudflare.com/client/v4`:

- `POST /accounts/{account_id}/cfd_tunnel` `{"name", "config_src": "cloudflare"}`
- `PUT /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations` (ingress)
- `GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/token`
- `DELETE /accounts/{account_id}/cfd_tunnel/{tunnel_id}/connections` (TO VERIFY:
  not in the public API reference, which only shows `.../connections/{connection_id}`;
  it's what Cloudflare's own `cloudflared` client uses)
- `DELETE /accounts/{account_id}/cfd_tunnel/{tunnel_id}`
- `POST /zones/{zone_id}/dns_records` (proxied CNAME to `<tunnel_id>.cfargotunnel.com`)
- `DELETE /zones/{zone_id}/dns_records/{dns_record_id}`

Sources: Cloudflare's [Create a tunnel (API)](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/)
guide and API reference.
