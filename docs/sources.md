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
export const parsers = [spysMeParser, mySourceParser];
```

3. Document the source format and URLs in this file.

4. Use it:

```bash
npm start -- collect --source my-source
# or all sources:
npm start -- collect
```

No changes to collector, storage, or checker are required if you emit valid `ProxyRecord`s.
