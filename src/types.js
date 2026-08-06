/** @typedef {'anonymous' | 'elite'} Anonymity */
/** @typedef {'http' | 'https' | 'socks4' | 'socks5'} Protocol */

/**
 * Normalized proxy record produced by every source parser.
 * @typedef {object} ProxyRecord
 * @property {string} host
 * @property {number} port
 * @property {string} country ISO 3166-1 alpha-2 (e.g. IT)
 * @property {Anonymity} anonymity
 * @property {Protocol} protocol
 * @property {string} source parser id
 */

export const ANONYMITY = Object.freeze({
  ANONYMOUS: 'anonymous',
  ELITE: 'elite',
});

export const PROTOCOL = Object.freeze({
  HTTP: 'http',
  HTTPS: 'https',
  SOCKS4: 'socks4',
  SOCKS5: 'socks5',
});

/**
 * @param {ProxyRecord} record
 * @returns {string}
 */
export function proxyAddress(record) {
  return `${record.host}:${record.port}`;
}

/**
 * @param {Anonymity} anonymity
 * @param {Protocol} protocol
 * @returns {string}
 */
export function listFileName(anonymity, protocol) {
  return `${anonymity}-${protocol}.txt`;
}
