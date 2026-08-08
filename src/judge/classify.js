import { normalizeIp } from './server.js';
import { ANONYMITY } from '../types.js';

/** @typedef {'elite' | 'anonymous' | 'transparent' | 'dead'} JudgeVerdict */

/**
 * Header names that typically reveal a proxy (when not stripped as infra hops).
 */
const PROXY_SIGN_HEADERS = [
  'via',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'x-proxy-id',
  'x-proxy-connection',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'forwarded',
  'client-ip',
  'true-client-ip',
  'x-client-ip',
  'x-cluster-client-ip',
  'forwarded-for',
  'x-coming-from',
];

/**
 * @param {string} text
 * @param {string} realIp
 * @returns {boolean}
 */
function textContainsIp(text, realIp) {
  if (!realIp || !text) return false;
  const needle = normalizeIp(realIp);
  if (!needle) return false;
  // Boundary-ish match so "1.2.3.4" does not hit "11.2.3.45"
  const re = new RegExp(
    `(^|[^0-9A-Fa-f:.])${needle.replace(/\./g, '\\.')}([^0-9A-Fa-f:]|$)`,
  );
  return re.test(String(text));
}

/**
 * @param {Record<string, string>} headers
 * @param {string} realIp
 * @returns {boolean}
 */
function headersLeakRealIp(headers, realIp) {
  for (const value of Object.values(headers)) {
    if (textContainsIp(value, realIp)) return true;
  }
  return false;
}

/**
 * @param {Record<string, string>} headers
 * @returns {boolean}
 */
function hasProxySignHeaders(headers) {
  for (const name of PROXY_SIGN_HEADERS) {
    if (headers[name] !== undefined && String(headers[name]).trim() !== '') {
      return true;
    }
  }
  return false;
}

/**
 * Classify a judge JSON payload.
 * @param {unknown} payload
 * @param {string} realIp
 * @returns {JudgeVerdict}
 */
export function classifyJudgePayload(payload, realIp) {
  if (!payload || typeof payload !== 'object') return 'dead';

  const ip = normalizeIp(/** @type {{ ip?: string }} */ (payload).ip || '');
  const allHeaders =
    /** @type {{ headers?: Record<string, string> }} */ (payload).headers &&
    typeof /** @type {{ headers?: unknown }} */ (payload).headers === 'object'
      ? /** @type {Record<string, string>} */ (
          /** @type {{ headers: Record<string, string> }} */ (payload).headers
        )
      : {};
  const anonymityHeaders =
    /** @type {{ anonymityHeaders?: Record<string, string> }} */ (payload)
      .anonymityHeaders &&
    typeof /** @type {{ anonymityHeaders?: unknown }} */ (payload).anonymityHeaders ===
      'object'
      ? /** @type {Record<string, string>} */ (
          /** @type {{ anonymityHeaders: Record<string, string> }} */ (payload)
            .anonymityHeaders
        )
      : allHeaders;

  const real = normalizeIp(realIp);
  if (!real) return 'dead';

  if (ip && normalizeIp(ip) === real) return 'transparent';
  if (headersLeakRealIp(allHeaders, real)) return 'transparent';
  if (headersLeakRealIp(anonymityHeaders, real)) return 'transparent';

  if (hasProxySignHeaders(anonymityHeaders)) return 'anonymous';

  // Alive, real IP hidden, no proxy signs
  if (!ip || ip === real) return 'dead';
  return 'elite';
}

/**
 * Map verdict to ProxyRecord anonymity (transparent/dead → null).
 * @param {JudgeVerdict} verdict
 * @returns {import('../types.js').Anonymity | null}
 */
export function verdictToAnonymity(verdict) {
  if (verdict === 'elite') return ANONYMITY.ELITE;
  if (verdict === 'anonymous') return ANONYMITY.ANONYMOUS;
  return null;
}
