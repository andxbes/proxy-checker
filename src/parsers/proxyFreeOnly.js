import { ANONYMITY, PROTOCOL } from '../types.js';

/** Public download API (limit/page). Currently often returns a bulk dump. */
const FREE_LIST_LIMIT = 500;
const FREE_LIST_URL = (page) =>
  `https://proxyfreeonly.com/api/free-proxy-list?limit=${FREE_LIST_LIMIT}&page=${page}&sortBy=lastChecked&sortType=desc`;

/** Site UI API — real pagination (`limit` page size + totalItems). */
const DATA_LIST_LIMIT = 500;
const DATA_LIST_URL = (page) =>
  `https://proxyfreeonly.com/api/data/proxy-list?page=${page}&limit=${DATA_LIST_LIMIT}&locale=en&where=%7B%7D`;

const MAX_FREE_LIST_PAGES = 50;
const MAX_DATA_LIST_PAGES = 500;

/**
 * @param {string} level
 * @returns {import('../types.js').Anonymity | null}
 */
function mapAnonymity(level) {
  const value = String(level || '').toLowerCase();
  if (
    value.includes('elite') ||
    value.includes('high anonymous') ||
    value.includes('(hia)')
  ) {
    // "transparent (HIA)" on this site is still labeled HIA but means transparent — drop if transparent wins
    if (value.includes('transparent') || value.includes('noa')) return null;
    return ANONYMITY.ELITE;
  }
  if (value.includes('anonymous') || value.includes('anm')) {
    if (value.includes('transparent') || value.includes('noa')) return null;
    return ANONYMITY.ANONYMOUS;
  }
  return null;
}

/**
 * @param {string} protocol
 * @returns {import('../types.js').Protocol | null}
 */
function mapProtocol(protocol) {
  const value = String(protocol || '').toLowerCase();
  if (value === 'http') return PROTOCOL.HTTP;
  if (value === 'https') return PROTOCOL.HTTPS;
  if (value === 'socks4') return PROTOCOL.SOCKS4;
  if (value === 'socks5') return PROTOCOL.SOCKS5;
  return null;
}

/**
 * @param {unknown} item
 * @returns {string}
 */
function extractCountry(item) {
  if (!item || typeof item !== 'object') return '';
  if (typeof item.country === 'string') return item.country.trim().toUpperCase();
  if (item.country && typeof item.country === 'object') {
    const code = item.country.countryCode || item.country.code;
    if (typeof code === 'string' && /^[A-Za-z]{2}$/.test(code)) {
      return code.toUpperCase();
    }
  }
  if (typeof item.countryCode === 'string') {
    return item.countryCode.trim().toUpperCase();
  }
  return '';
}

/**
 * @param {unknown} payload
 * @returns {object[]}
 */
export function normalizeApiPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.proxies)) return payload.proxies;
    if (Array.isArray(payload.results)) return payload.results;
    return Object.values(payload).filter(
      (item) => item && typeof item === 'object' && 'ip' in item,
    );
  }
  return [];
}

/**
 * @param {unknown} payload
 * @returns {import('../types.js').ProxyRecord[]}
 */
export function parseProxyFreeOnlyPayload(payload) {
  /** @type {import('../types.js').ProxyRecord[]} */
  const records = [];

  for (const item of normalizeApiPayload(payload)) {
    const anonymity = mapAnonymity(item.anonymityLevel);
    if (!anonymity) continue;

    const host = String(item.ip || '').trim();
    const port = Number(item.port);
    const country = extractCountry(item);
    if (!host || !Number.isFinite(port) || !/^[A-Z]{2}$/.test(country)) {
      continue;
    }

    const protocols = Array.isArray(item.protocols) ? item.protocols : [];
    for (const rawProtocol of protocols) {
      const protocol = mapProtocol(rawProtocol);
      if (!protocol) continue;
      records.push({
        host,
        port,
        country,
        anonymity,
        protocol,
        source: 'proxyfreeonly',
      });
    }
  }

  return records;
}

/**
 * @param {string} url
 * @returns {Promise<unknown>}
 */
async function fetchJson(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'proxy-checker/1.0',
      },
    });
  } catch (err) {
    throw new Error(
      `Failed to fetch ${url}: ${err.cause?.message || err.message}`,
    );
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Page through public free-proxy-list API (limit=500).
 * If the API ignores pagination and returns a bulk dump, take it once.
 * @returns {Promise<object[]>}
 */
async function fetchFreeListPages() {
  /** @type {object[]} */
  const items = [];
  /** @type {Set<string>} */
  const pageFingerprints = new Set();

  for (let page = 1; page <= MAX_FREE_LIST_PAGES; page += 1) {
    const payload = await fetchJson(FREE_LIST_URL(page));
    const batch = normalizeApiPayload(payload);
    if (batch.length === 0) break;

    const fingerprint = `${batch[0]?.ip}:${batch[0]?.port}:${batch.length}:${batch.at(-1)?.ip}`;
    if (pageFingerprints.has(fingerprint)) {
      process.stderr.write(
        `  proxyfreeonly free-list: page ${page} repeats page 1 — stop paging\n`,
      );
      break;
    }
    pageFingerprints.add(fingerprint);

    items.push(...batch);
    process.stderr.write(
      `  proxyfreeonly free-list page ${page}: +${batch.length} (have ${items.length})\n`,
    );

    // API returned more than requested page size → full dump, no more pages needed
    if (batch.length > FREE_LIST_LIMIT) break;
    // Last page
    if (batch.length < FREE_LIST_LIMIT) break;
  }

  return items;
}

/**
 * Page through site data API until all totalItems are collected.
 * @returns {Promise<object[]>}
 */
async function fetchDataListPages() {
  /** @type {object[]} */
  const items = [];
  let totalItems = Infinity;

  for (let page = 1; page <= MAX_DATA_LIST_PAGES; page += 1) {
    const payload = await fetchJson(DATA_LIST_URL(page));
    const batch = Array.isArray(payload?.items) ? payload.items : [];
    if (typeof payload?.totalItems === 'number') {
      totalItems = payload.totalItems;
    }
    if (batch.length === 0) break;

    items.push(...batch);
    process.stderr.write(
      `  proxyfreeonly data-list page ${page}: +${batch.length} ` +
        `(have ${items.length}/${Number.isFinite(totalItems) ? totalItems : '?'})\n`,
    );

    if (items.length >= totalItems) break;
    if (batch.length < DATA_LIST_LIMIT) break;
  }

  return items;
}

/** @type {import('./base.js').SourceParser} */
export const proxyFreeOnlyParser = {
  id: 'proxyfreeonly',
  description:
    'proxyfreeonly.com API (paginated free-proxy-list + data-list; HTTP/HTTPS/SOCKS)',

  /**
   * @param {import('./base.js').FetchOptions} [options]
   */
  async fetchAndParse(options = {}) {
    // Prefer real pagination from the site API, then merge public free-list pages.
    const [dataItems, freeItems] = await Promise.all([
      fetchDataListPages(),
      fetchFreeListPages(),
    ]);

    const mergedPayload = [...dataItems, ...freeItems];
    let records = parseProxyFreeOnlyPayload(mergedPayload);

    if (options.country) {
      const cc = options.country.toUpperCase();
      records = records.filter((r) => r.country === cc);
    }

    return records;
  },
};

export default proxyFreeOnlyParser;
