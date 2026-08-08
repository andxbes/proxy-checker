import { ANONYMITY, PROTOCOL } from '../types.js';

const API_BASE = 'https://free.geonix.com/api/front/main';
const CAPTCHA_URL = `${API_BASE}/captcha/info`;
const EXPORT_URL = `${API_BASE}/proxy/export`;
const FILTRATION_URL = `${API_BASE}/pagination/filtration`;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

/** English country names as returned by Geonix → ISO 3166-1 alpha-2 */
const COUNTRY_TO_ISO2 = Object.freeze({
  Argentina: 'AR',
  Armenia: 'AM',
  Australia: 'AU',
  Austria: 'AT',
  Bangladesh: 'BD',
  Belgium: 'BE',
  'Bosnia and Herzegovina': 'BA',
  Brazil: 'BR',
  Bulgaria: 'BG',
  Burundi: 'BI',
  Cambodia: 'KH',
  Canada: 'CA',
  Chile: 'CL',
  China: 'CN',
  Colombia: 'CO',
  'Costa Rica': 'CR',
  Croatia: 'HR',
  'Czech Republic': 'CZ',
  'Dominican Republic': 'DO',
  Ecuador: 'EC',
  Egypt: 'EG',
  Estonia: 'EE',
  Finland: 'FI',
  France: 'FR',
  Georgia: 'GE',
  Germany: 'DE',
  Ghana: 'GH',
  'Hong Kong': 'HK',
  India: 'IN',
  Indonesia: 'ID',
  Iran: 'IR',
  Iraq: 'IQ',
  Ireland: 'IE',
  Italy: 'IT',
  Japan: 'JP',
  Kazakhstan: 'KZ',
  Kenya: 'KE',
  Libya: 'LY',
  Mexico: 'MX',
  Netherlands: 'NL',
  Pakistan: 'PK',
  Palestine: 'PS',
  Paraguay: 'PY',
  Peru: 'PE',
  Philippines: 'PH',
  Poland: 'PL',
  Portugal: 'PT',
  Russia: 'RU',
  Rwanda: 'RW',
  'Saudi Arabia': 'SA',
  Senegal: 'SN',
  Serbia: 'RS',
  Singapore: 'SG',
  'South Africa': 'ZA',
  'South Korea': 'KR',
  Spain: 'ES',
  'Sri Lanka': 'LK',
  Suriname: 'SR',
  Taiwan: 'TW',
  Tanzania: 'TZ',
  Thailand: 'TH',
  Turkey: 'TR',
  Turkmenistan: 'TM',
  UAE: 'AE',
  Ukraine: 'UA',
  'United Kingdom': 'GB',
  'United States': 'US',
  Uzbekistan: 'UZ',
  Venezuela: 'VE',
  Vietnam: 'VN',
  Zambia: 'ZM',
});

const JSON_HEADERS = Object.freeze({
  Accept: 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  Origin: 'https://free.geonix.com',
  Referer: 'https://free.geonix.com/',
});

/**
 * @param {string} value
 * @returns {import('../types.js').Anonymity | null}
 */
function mapAnonymity(value) {
  const raw = String(value || '').toLowerCase();
  if (raw === 'an-anonim.txt' || raw.includes('anonim') || raw.includes('anonymous')) {
    return ANONYMITY.ANONYMOUS;
  }
  if (raw === 'el-elit.txt' || raw.includes('elit') || raw.includes('elite')) {
    return ANONYMITY.ELITE;
  }
  return null;
}

/**
 * @param {string} value
 * @returns {import('../types.js').Protocol | null}
 */
function mapProtocol(value) {
  const raw = String(value || '').toLowerCase();
  if (raw === 'http') return PROTOCOL.HTTP;
  if (raw === 'https') return PROTOCOL.HTTPS;
  if (raw === 'socks4') return PROTOCOL.SOCKS4;
  if (raw === 'socks5') return PROTOCOL.SOCKS5;
  return null;
}

/**
 * @param {string} name
 * @returns {string}
 */
function mapCountry(name) {
  if (typeof name !== 'string') return '';
  const trimmed = name.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return COUNTRY_TO_ISO2[trimmed] || '';
}

/**
 * @param {string} url
 * @param {object} [body]
 * @returns {Promise<unknown>}
 */
async function fetchJson(url, body) {
  /** @type {RequestInit} */
  const init = {
    headers: { ...JSON_HEADERS },
  };
  if (body !== undefined) {
    init.method = 'POST';
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, init);
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
 * @returns {Promise<string>} captchaKey (may be empty when captcha is off)
 */
async function ensureExportAvailable() {
  const info = /** @type {{ isCaptchaActive?: boolean, captchaKey?: string }} */ (
    await fetchJson(CAPTCHA_URL)
  );
  if (info?.isCaptchaActive) {
    throw new Error(
      'Geonix captcha is active; lists are not available without a browser session',
    );
  }
  return typeof info?.captchaKey === 'string' ? info.captchaKey : '';
}

/**
 * Plain ip:port dump for a proxy type (same order as filtration pages).
 * @param {'ANONYMOUS' | 'ELITE'} proxyType
 * @param {string} captchaKey
 * @returns {Promise<Array<{ host: string, port: number }>>}
 */
async function fetchExportAddresses(proxyType, captchaKey) {
  const payload = await fetchJson(EXPORT_URL, {
    captchaKey,
    countries: [],
    proxyProtocols: [],
    proxyTypes: [proxyType],
  });

  if (!Array.isArray(payload)) {
    throw new Error(`Geonix export for ${proxyType} did not return an array`);
  }

  /** @type {Array<{ host: string, port: number }>} */
  const addresses = [];
  for (const entry of payload) {
    const text = String(entry || '').trim();
    const sep = text.lastIndexOf(':');
    if (sep <= 0) continue;
    const host = text.slice(0, sep).trim();
    const port = Number(text.slice(sep + 1));
    if (!host || !Number.isFinite(port)) continue;
    addresses.push({ host, port });
  }
  return addresses;
}

/**
 * Paginated metadata (country / protocol / anonymity). Ports are image URLs only.
 * @param {'ANONYMOUS' | 'ELITE'} proxyType
 * @returns {Promise<object[]>}
 */
async function fetchFiltrationPages(proxyType) {
  /** @type {object[]} */
  const items = [];
  let totalElements = Infinity;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const payload = /** @type {{
     *   content?: object[],
     *   totalElements?: number,
     *   totalPages?: number,
     * }} */ (
      await fetchJson(FILTRATION_URL, {
        page,
        size: PAGE_SIZE,
        countries: [],
        proxyProtocols: [],
        proxyTypes: [proxyType],
      })
    );

    const batch = Array.isArray(payload.content) ? payload.content : [];
    if (typeof payload.totalElements === 'number') {
      totalElements = payload.totalElements;
    }
    if (batch.length === 0) break;

    items.push(...batch);
    process.stderr.write(
      `  geonix ${proxyType.toLowerCase()} page ${page}: +${batch.length} ` +
        `(have ${items.length}/${Number.isFinite(totalElements) ? totalElements : '?'})\n`,
    );

    const totalPages =
      typeof payload.totalPages === 'number' ? payload.totalPages : undefined;
    if (items.length >= totalElements) break;
    if (totalPages !== undefined && page + 1 >= totalPages) break;
    if (batch.length < PAGE_SIZE) break;
  }

  return items;
}

/**
 * Join export ports with filtration metadata by shared list order (and IP).
 * @param {Array<{ host: string, port: number }>} addresses
 * @param {object[]} metaItems
 * @returns {import('../types.js').ProxyRecord[]}
 */
export function joinGeonixLists(addresses, metaItems) {
  /** @type {import('../types.js').ProxyRecord[]} */
  const records = [];
  const n = Math.min(addresses.length, metaItems.length);

  for (let i = 0; i < n; i += 1) {
    const address = addresses[i];
    const item = metaItems[i];
    const metaIp = String(item?.ip || '').trim();
    if (!metaIp || metaIp !== address.host) continue;

    const anonymity = mapAnonymity(item.anonymity);
    if (!anonymity) continue;

    const protocol = mapProtocol(item.proxyType);
    if (!protocol) continue;

    const country = mapCountry(item.country);
    if (!/^[A-Z]{2}$/.test(country)) continue;

    records.push({
      host: address.host,
      port: address.port,
      country,
      anonymity,
      protocol,
      source: 'geonix',
    });
  }

  return records;
}

/**
 * @param {'ANONYMOUS' | 'ELITE'} proxyType
 * @param {string} captchaKey
 * @returns {Promise<import('../types.js').ProxyRecord[]>}
 */
async function fetchProxyType(proxyType, captchaKey) {
  const [addresses, metaItems] = await Promise.all([
    fetchExportAddresses(proxyType, captchaKey),
    fetchFiltrationPages(proxyType),
  ]);

  if (addresses.length !== metaItems.length) {
    process.stderr.write(
      `  geonix ${proxyType.toLowerCase()}: export=${addresses.length} ` +
        `meta=${metaItems.length} (joining by matching IPs in order)\n`,
    );
  }

  return joinGeonixLists(addresses, metaItems);
}

/** @type {import('./base.js').SourceParser} */
export const geonixParser = {
  id: 'geonix',
  description:
    'free.geonix.com API (export + filtration; HTTP/HTTPS/SOCKS, anonymous/elite)',

  /**
   * @param {import('./base.js').FetchOptions} [options]
   */
  async fetchAndParse(options = {}) {
    const captchaKey = await ensureExportAvailable();

    const [anonymous, elite] = await Promise.all([
      fetchProxyType('ANONYMOUS', captchaKey),
      fetchProxyType('ELITE', captchaKey),
    ]);

    let records = [...anonymous, ...elite];

    if (options.country) {
      const cc = options.country.toUpperCase();
      records = records.filter((r) => r.country === cc);
    }

    return records;
  },
};

export default geonixParser;
