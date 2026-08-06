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

# Check previously collected proxies against a URL
npm start -- check --check https://example.com --country IT

# Collect + check in one run
npm start -- run --check https://httpbin.org/status/200 --country IT --concurrency 30 --timeout 8000
```

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
| `check` | Load lists and keep proxies that get HTTP **200** for `--check` URL |
| `run` | `collect` then `check` |

### Options

| Option | Description |
|--------|-------------|
| `--country CC` | ISO 3166-1 alpha-2 (e.g. `IT`). Omit = all countries |
| `--check URL` / `--target URL` | Target URL for checking (required for `check` / `run`) |
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

Checked (only HTTP 200):

```
data/checked/{url-slug}/{CC}/{anonymity}-{protocol}.txt
```

Example slug: `https://example.com/api` → `https_example_com_api`.
Example path: `data/checked/https_example_com/IT/elite-http.txt`.

## Sources (v1)

- **spys-me** — official TXT lists:
  - https://spys.me/proxy.txt (HTTP / HTTPS)
  - https://spys.me/socks.txt (SOCKS5)

Only anonymity codes **A** (anonymous) and **H** (elite / HIA) are kept. Transparent / NOA (`N`) is dropped.

See [docs/sources.md](docs/sources.md) for formats and how to add another source.

## Architecture

See [docs/architecture.md](docs/architecture.md).

## Requirements

- Node.js ≥ 18
- Network access to proxy list URLs and (for `check`) to the target via proxies
