import { ANONYMITY, PROTOCOL } from '../types.js';

const PROXY_TXT_URL = 'https://spys.me/proxy.txt';
const SOCKS_TXT_URL = 'https://spys.me/socks.txt';

/** Line: `IP:port CC-A|H|N[-S][!]? [+/-]` */
const LINE_RE =
  /^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)\s+([A-Z]{2})-([NAH])(?:-(S))?!?/i;

/**
 * @param {string} text
 * @param {'http' | 'socks5'} listKind
 * @returns {import('../types.js').ProxyRecord[]}
 */
export function parseSpysMeText(text, listKind) {
  /** @type {import('../types.js').ProxyRecord[]} */
  const records = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('Proxy list') || line.startsWith('Socks proxy') ||
        line.startsWith('Http proxy') || line.startsWith('Support') ||
        line.startsWith('BTC') || line.startsWith('IP address') ||
        line.startsWith('Free ')) {
      continue;
    }

    const match = LINE_RE.exec(line);
    if (!match) continue;

    const [, host, portStr, country, anonymityCode, sslFlag] = match;
    const anonymity = mapAnonymity(anonymityCode);
    if (!anonymity) continue;

    const protocol =
      listKind === 'socks5'
        ? PROTOCOL.SOCKS5
        : sslFlag
          ? PROTOCOL.HTTPS
          : PROTOCOL.HTTP;

    records.push({
      host,
      port: Number(portStr),
      country: country.toUpperCase(),
      anonymity,
      protocol,
      source: 'spys-me',
    });
  }

  return records;
}

/**
 * @param {string} code
 * @returns {import('../types.js').Anonymity | null}
 */
function mapAnonymity(code) {
  const c = code.toUpperCase();
  if (c === 'A') return ANONYMITY.ANONYMOUS;
  if (c === 'H') return ANONYMITY.ELITE;
  return null;
}

/**
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchText(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': 'proxy-checker/1.0' },
    });
  } catch (err) {
    throw new Error(`Failed to fetch ${url}: ${err.cause?.message || err.message}`);
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return response.text();
}

/** @type {import('./base.js').SourceParser} */
export const spysMeParser = {
  id: 'spys-me',
  description: 'Official spys.me TXT lists (HTTP/HTTPS + SOCKS5), updated hourly',

  /**
   * @param {import('./base.js').FetchOptions} [options]
   */
  async fetchAndParse(options = {}) {
    const [proxyText, socksText] = await Promise.all([
      fetchText(PROXY_TXT_URL),
      fetchText(SOCKS_TXT_URL),
    ]);

    let records = [
      ...parseSpysMeText(proxyText, 'http'),
      ...parseSpysMeText(socksText, 'socks5'),
    ];

    if (options.country) {
      const cc = options.country.toUpperCase();
      records = records.filter((r) => r.country === cc);
    }

    return records;
  },
};

export default spysMeParser;
