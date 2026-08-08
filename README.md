# proxy-checker

CLI on Node.js (≥18) that collects **anonymous** and **elite / high anonymity** proxies from pluggable sources, stores them by ISO country, and optionally checks which proxies return **HTTP 200** for a target URL.

## Install

```bash
npm install
```

## Quick start

```bash
# Collect from all registered sources (all countries)
npm start -- collect

# Collect only Italy
npm start -- collect --country IT

# Collect from a specific source
npm start -- collect --source spys-me

# Check previously collected proxies against a URL (liveness only)
npm start -- check --check https://example.com --country IT

# Anonymity check via local judge (needs public URL in .env — see below)
npm start -- check --country IT

# Collect + check in one run
npm start -- run --check https://httpbin.org/status/200 --country IT --concurrency 30 --timeout 8000
```

## Anonymity check (local judge)

`--check` only verifies that a proxy returns HTTP **200**. To also verify **anonymity**, the CLI can start a short-lived **judge** server for the duration of `check` / `run`.

1. Copy [`.env.example`](.env.example) → `.env`
2. Uncomment and set `JUDGE_PUBLIC_URL` to a **public** URL that reaches your machine’s `JUDGE_PORT` (VPS reverse-proxy, Cloudflare Tunnel, ngrok, or port-forward)
3. If a tunnel/nginx sits in front, set `JUDGE_TRUST_PROXY=1`
4. Optionally set `JUDGE_REAL_IP` (otherwise it is detected via a direct GET to the public URL)

```bash
cp .env.example .env
# uncomment and edit JUDGE_PUBLIC_URL=https://your-tunnel.example/judge

npm start -- check --country IT
# or override URL for one run:
npm start -- check --judge https://your-tunnel.example/judge --country IT
```

Classification:

| Verdict | Meaning | Kept? |
|---------|---------|-------|
| **elite** | Real IP hidden, no proxy-revealing headers | Yes |
| **anonymous** | Real IP hidden, but proxy headers present | Yes |
| **transparent** | Real IP visible in IP/headers | No |
| **dead** | Timeout / non-200 / bad body | No |

The local server binds only while the scan runs, then shuts down. Without a reachable public URL, anonymity mode cannot work (proxies on the internet cannot dial `localhost`).

## Your own proxy lists

`collect` rewrites only `data/proxies/`. Put your lists in **`data/custom/`** — they are never overwritten.

```
data/custom/IT/elite-http.txt
data/custom/IT/elite-socks5.txt
```

```bash
# check only your lists
npm start -- check --check https://example.com --from custom

# or any external file
npm start -- check --check https://example.com --input ./my-list.txt --protocol socks5
```

Default `check` / `run` loads **both** `data/proxies/` and `data/custom/`.

See [data/custom/README.md](data/custom/README.md).

## Commands

| Command | Description |
|---------|-------------|
| `collect` | Fetch proxies and write lists under `data/proxies/` |
| `check` | Liveness (`--check`) and/or anonymity (`JUDGE_PUBLIC_URL` / `--judge`) |
| `run` | `collect` then `check` |

### Options

| Option | Description |
|--------|-------------|
| `--country CC` | ISO 3166-1 alpha-2 (e.g. `IT`). Omit = all countries |
| `--check URL` / `--target URL` | Liveness target (final HTTP 200). Not required when judge mode is on |
| `--judge URL` | Public judge URL; enables anonymity mode (overrides `JUDGE_PUBLIC_URL`) |
| `--source ID` | Parser id (repeatable). Default = all registered sources |
| `--timeout MS` | Hard per-proxy deadline in ms (default `10000`). Dead proxies are cut off; total time ≈ batches × timeout, not N × timeout |
| `--from SOURCE` | `all` (default) \| `proxies` \| `custom` — which built-in dirs to load for check |
| `--input PATH` | Extra file or directory of proxies (repeatable). Plain files default to `elite` + `http` unless named `anonymity-protocol.txt` |
| `--protocol TYPE` | Override protocol for plain `--input` files |
| `--anonymity TYPE` | Override anonymity for plain `--input` files |
| `-h`, `--help` | Help |

## Output layout

Collected (rewritten by `collect`):

```
data/proxies/{CC}/{anonymity}-{protocol}.txt
```

Your lists (safe from `collect`):

```
data/custom/{CC}/{anonymity}-{protocol}.txt
```

Examples:

```
data/proxies/IT/anonymous-http.txt
data/proxies/IT/elite-http.txt
data/proxies/IT/elite-https.txt
data/proxies/IT/elite-socks5.txt
```

Each file: one `ip:port` per line.

Checked (liveness: HTTP 200; judge mode: anonymous + elite only, with measured anonymity):

```
data/checked/{url-slug}/{CC}/{anonymity}-{protocol}.txt
```

Example slug: `https://example.com/api` → `https_example_com_api`.
Example path: `data/checked/https_example_com/IT/elite-http.txt`.

## Sources (v1)

- **spys-me** — official TXT lists:
  - https://spys.me/proxy.txt (HTTP / HTTPS)
  - https://spys.me/socks.txt (SOCKS5)
- **proxyfreeonly** — JSON API:
  - https://proxyfreeonly.com/api/free-proxy-list?...
- **geonix** — free.geonix.com JSON API (`export` + `filtration`; works without browser while captcha is off)

Only anonymity codes **anonymous** / **elite** (and spys A/H) are kept. Transparent / NOA is dropped.

Collector dedupes by `protocol|host:port` across sources before writing lists (and check dedupes again on load), so duplicate entries do not trigger extra check requests.

```bash
npm start -- collect --source geonix
npm start -- collect --source proxyfreeonly
npm start -- collect --source spys-me --source proxyfreeonly --source geonix
```

See [docs/sources.md](docs/sources.md) for formats and how to add another source.

## Architecture

See [docs/architecture.md](docs/architecture.md).

## Requirements

- Node.js ≥ 18
- Network access to proxy list URLs and (for `check`) to the target via proxies
- For anonymity mode: a **public** URL (tunnel/VPS/port-forward) that reaches the local judge port

## Collect all proxy
`npm start collect`
## Check only one country
`npm start --  check  --check https://google.com/  --country SK  --concurrency 20 --timeout 8000`
## Check all country
`npm start --  check  --check https://google.com/   --concurrency 20 --timeout 8000`
## Anonymity check (requires .env JUDGE_PUBLIC_URL)
`npm start -- check --country SK --concurrency 20 --timeout 8000`
