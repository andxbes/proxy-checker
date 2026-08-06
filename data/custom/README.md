# Your proxy lists (never overwritten by `collect`)

Put manual lists here. `npm start -- collect` only writes to `data/proxies/`.

## Recommended layout

```
data/custom/IT/elite-http.txt
data/custom/IT/elite-socks5.txt
data/custom/US/anonymous-http.txt
```

Each file: one `ip:port` per line. Lines starting with `#` are ignored.

## Check only your lists

```bash
npm start -- check --check https://example.com --from custom
npm start -- check --check https://example.com --from custom --country IT
```

## Or pass any file

```bash
npm start -- check --check https://example.com --input ./my-proxies.txt --protocol http --anonymity elite
```

Default check uses **both** `data/proxies/` and `data/custom/`.
