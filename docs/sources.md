# Sources

## Registered sources

### `spys-me`

Official text lists from [spys.me](https://spys.me/) (linked from [spys.one/api](https://spys.one/api/)):

| URL | Kind |
|-----|------|
| https://spys.me/proxy.txt | HTTP / HTTPS |
| https://spys.me/socks.txt | SOCKS5 |

Format (per line):

```
IP:port CountryCode-Anonymity[-S][!] [+/-]
```

Anonymity:

| Code | Meaning | Kept? |
|------|---------|-------|
| `N` | NOA / non-anonymous | No |
| `A` | Anonymous (ANM) | Yes → `anonymous` |
| `H` | High anonymity / Elite (HIA) | Yes → `elite` |

Protocol mapping:

- From `proxy.txt` without `-S` → `http`
- From `proxy.txt` with `-S` → `https`
- From `socks.txt` → `socks5`

Lists update about once per hour. Full HTML scraping of spys.one is **disallowed** by the site and can get your IP banned; this project uses the official TXT feeds only.

### `proxyfreeonly`

APIs from [proxyfreeonly.com](https://proxyfreeonly.com/free-proxy-list):

| Endpoint | Role |
|----------|------|
| `/api/data/proxy-list?page=N&limit=500&locale=en&where={}` | Site UI list — real pagination (500/page, `totalItems`) |
| `/api/free-proxy-list?limit=500&page=N&sortBy=lastChecked&sortType=desc` | Public download API — pages of 500 when respected; if a response is a bulk dump or page repeats, paging stops |

The parser walks **all pages** of both endpoints and merges results (collector dedupes).

Item fields used:

| Field | Mapping |
|-------|---------|
| `ip` / `port` | host:port |
| `country` or `country.countryCode` | ISO2 |
| `anonymityLevel` | `elite` / `elite (HIA)` → elite; `anonymous` → anonymous; `transparent*` dropped |
| `protocols[]` | each of `http` / `https` / `socks4` / `socks5` → separate `ProxyRecord` |

## How to add a new source

1. Create `src/parsers/mySource.js` exporting a parser object:

```js
/** @type {import('./base.js').SourceParser} */
export const mySourceParser = {
  id: 'my-source',
  description: 'Short description',
  async fetchAndParse(options = {}) {
    // fetch + parse site/API/TXT
    // return only anonymous | elite ProxyRecord[]
    return [];
  },
};

export default mySourceParser;
```

2. Register it in [`src/parsers/registry.js`](../src/parsers/registry.js):

```js
import { mySourceParser } from './mySource.js';
export const parsers = [spysMeParser, proxyFreeOnlyParser, mySourceParser];
```

3. Document the source format and URLs in this file.

4. Use it:

```bash
npm start -- collect --source proxyfreeonly
# or all sources:
npm start -- collect
```

No changes to collector, storage, or checker are required if you emit valid `ProxyRecord`s.
