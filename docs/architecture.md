# Architecture

## Pipeline

1. **Collect** — each registered source parser fetches and normalizes proxies into `ProxyRecord[]`.
2. **Merge** — collector deduplicates (`protocol|host:port`), prefers `elite` on anonymity conflicts, optional `--country` filter.
3. **Store** — write `data/proxies/{CC}/{anonymity}-{protocol}.txt` (never writes `data/custom/`).
4. **Check** (optional) — load `data/proxies/` + `data/custom/` (or `--from` / `--input`), request target through each proxy (follow redirects up to 5 hops); keep only **final** status **200**.
5. **Store checked** — write `data/checked/{url-slug}/{CC}/{anonymity}-{protocol}.txt`.

## Custom lists

- Path: `data/custom/{CC}/{anonymity}-{protocol}.txt`
- `collect` does not touch this directory
- `--from custom` checks only user lists
- `--input path` adds an arbitrary file/dir for one run

## ProxyRecord

Every source must emit:

| Field | Values |
|-------|--------|
| `host` | IPv4 string |
| `port` | number |
| `country` | ISO2 (`IT`, `US`, …) |
| `anonymity` | `anonymous` \| `elite` |
| `protocol` | `http` \| `https` \| `socks4` \| `socks5` |
| `source` | parser id |

Source-specific raw fields stay inside the parser.

## File naming

`{anonymity}-{protocol}.txt` — e.g. `elite-socks5.txt`, `anonymous-http.txt`.

On spys.me HTTP list, the `S` (SSL) flag maps to protocol `https` (HTTP proxy that supports HTTPS targets). Without `S` → `http`. SOCKS list → `socks5`.

## URL slug

Target URL is sanitized for the filesystem:

- `https://example.com/api` → `https_example_com_api`

## Check timeout

`--timeout` is a **hard wall-clock** limit per proxy (default 10000 ms). Node’s built-in request `timeout` alone does not abort a stuck TCP/SOCKS connect to a dead proxy (the OS can wait 20–30s+). The checker enforces a timer that destroys the request when the deadline is reached. With concurrency, total check time is roughly the slowest in-flight batch, not `N × timeout`.

Agents are created with `keepAlive: false`, sockets are destroyed after each attempt, and the CLI calls `process.exit` when finished so leftover network handles cannot hang the terminal.

Progress lines (`progress: 30/518 completed`) are a **log interval** (every N finished checks). Parallelism is controlled only by `--concurrency`.

Free public lists (spys.me) have a very low live rate; `0/N` against Google is common. Google may also return non-200 (captcha/blocks) even via a live proxy — prefer a neutral target like `https://httpbin.org/status/200` to validate the checker.

## Extensibility

- Parsers live in `src/parsers/` and register in `src/parsers/registry.js`.
- Collector, storage, and checker depend only on `ProxyRecord`, not on HTML/API details of a site.
- CLI `--source` selects one or more parsers; omit to use all.

## Modules

| File | Role |
|------|------|
| `src/cli.js` | Commands and flags |
| `src/collector.js` | Run parsers → merge → write |
| `src/checker.js` | Concurrent proxy checks |
| `src/storage.js` | Paths, dedupe, read/write lists |
| `src/types.js` | Shared constants / helpers |
| `src/parsers/registry.js` | Source registry |
| `src/parsers/spysMe.js` | First source adapter |
| `src/parsers/proxyFreeOnly.js` | proxyfreeonly.com API adapter |
