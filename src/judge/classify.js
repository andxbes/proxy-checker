import { normalizeIp } from './server.js';
import { ANONYMITY } from '../types.js';

/** @typedef {'elite' | 'anonymous' | 'transparent' | 'dead'} JudgeVerdict */

/**
 * @typedef {'real-ip' | 'proxy-header' | 'suspicious-name' | 'suspicious-value'} FindingKind
 * @typedef {{
 *   kind: FindingKind,
 *   header: string,
 *   value?: string,
 *   detail: string,
 * }} JudgeFinding
 * @typedef {{ verdict: JudgeVerdict, findings: JudgeFinding[] }} JudgeResult
 */

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
  'x-forwarded-port',
  'x-forwarded-scheme',
  'x-real-ip',
  'forwarded',
  'client-ip',
  'true-client-ip',
  'x-client-ip',
  'x-cluster-client-ip',
  'forwarded-for',
  'x-coming-from',
  'x-originating-ip',
  'x-remote-ip',
  'x-remote-addr',
  'x-original-forwarded-for',
];

/** Header name looks like a forwarding / client-ip leak channel. */
const SUSPICIOUS_HEADER_NAME_RE =
  /(?:^|[-_])(prox(?:y|ies)|forwarded(?:[-_]?for)?|forwardedfor|real[-_]?ip|client[-_]?ip|true[-_]?client|coming[-_]?from|originating[-_]?ip|remote[-_]?(?:ip|addr)|x[-_]?via)(?:[-_]|$)|^via$/i;

/**
 * Client request headers we set ourselves — never treat their values as proxy marks
 * (e.g. User-Agent: … proxy-checker/1.0).
 */
const VALUE_SCAN_SKIP_HEADERS = new Set([
  'user-agent',
  'accept',
  'accept-encoding',
  'accept-language',
  'connection',
  'host',
  'content-length',
  'content-type',
  'cache-control',
  'pragma',
  'te',
  'upgrade-insecure-requests',
]);

/**
 * Header value mentions a proxy / forwarder.
 * "proxy" must be a standalone token — not "proxy-checker".
 */
const SUSPICIOUS_HEADER_VALUE_RE =
  /(?:^|[^A-Za-z0-9_-])(?:via\s+[\w./:-]+|forwarded(?:\s+for)?|squid\/?[\d.]*|privoxy|mikrotik|varnish|trafficserver|bluecoat|netscaler|(?:https?|socks5?)[\s_-]+proxy|proxy)(?![A-Za-z0-9_-])/i;

const MAX_LOG_VALUE = 120;

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
 * @param {string | undefined} value
 * @returns {string}
 */
function clipValue(value) {
  const s = String(value ?? '').trim();
  if (s.length <= MAX_LOG_VALUE) return s;
  return `${s.slice(0, MAX_LOG_VALUE)}…`;
}

/**
 * @param {JudgeFinding[]} findings
 * @param {JudgeFinding} finding
 */
function pushFinding(findings, finding) {
  const exists = findings.some(
    (f) =>
      f.kind === finding.kind &&
      f.header === finding.header &&
      f.value === finding.value,
  );
  if (!exists) findings.push(finding);
}

/**
 * @param {Record<string, string>} headers
 * @param {string} realIp
 * @param {JudgeFinding[]} findings
 */
function collectRealIpLeaks(headers, realIp, findings) {
  for (const [name, value] of Object.entries(headers)) {
    if (!textContainsIp(value, realIp)) continue;
    pushFinding(findings, {
      kind: 'real-ip',
      header: name,
      value: clipValue(value),
      detail: 'header value contains real IP',
    });
  }
}

/**
 * @param {Record<string, string>} headers
 * @param {JudgeFinding[]} findings
 */
function collectProxySigns(headers, findings) {
  const known = new Set(PROXY_SIGN_HEADERS);

  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    const value = String(rawValue ?? '');
    if (!value.trim()) continue;

    if (known.has(name)) {
      pushFinding(findings, {
        kind: 'proxy-header',
        header: name,
        value: clipValue(value),
        detail: 'known proxy / forwarding header',
      });
      continue;
    }

    if (SUSPICIOUS_HEADER_NAME_RE.test(name)) {
      pushFinding(findings, {
        kind: 'suspicious-name',
        header: name,
        value: clipValue(value),
        detail: 'suspicious forwarding-related header name',
      });
      continue;
    }

    if (
      !VALUE_SCAN_SKIP_HEADERS.has(name) &&
      SUSPICIOUS_HEADER_VALUE_RE.test(value)
    ) {
      pushFinding(findings, {
        kind: 'suspicious-value',
        header: name,
        value: clipValue(value),
        detail: 'header value looks like a proxy / forwarder mark',
      });
    }
  }
}

/**
 * Classify a judge JSON payload.
 * @param {unknown} payload
 * @param {string} realIp
 * @returns {JudgeResult}
 */
export function classifyJudgePayload(payload, realIp) {
  /** @type {JudgeFinding[]} */
  const findings = [];

  if (!payload || typeof payload !== 'object') {
    return { verdict: 'dead', findings };
  }

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
  if (!real) return { verdict: 'dead', findings };

  if (ip && normalizeIp(ip) === real) {
    pushFinding(findings, {
      kind: 'real-ip',
      header: '(connecting-ip)',
      value: ip,
      detail: 'judge connecting IP equals real IP',
    });
  }

  // Prefer full headers for IP leak (transparent may inject into hop headers).
  collectRealIpLeaks(allHeaders, real, findings);
  collectRealIpLeaks(anonymityHeaders, real, findings);

  const leaked = findings.some((f) => f.kind === 'real-ip');
  if (leaked) {
    return { verdict: 'transparent', findings };
  }

  collectProxySigns(anonymityHeaders, findings);
  if (findings.length > 0) {
    return { verdict: 'anonymous', findings };
  }

  // Alive, real IP hidden, no proxy signs
  if (!ip || ip === real) return { verdict: 'dead', findings };
  return { verdict: 'elite', findings };
}

/**
 * Format findings for a red console line (ANSI).
 * @param {string} proxyLabel
 * @param {JudgeResult} result
 * @returns {string | null}
 */
export function formatJudgeFindingsLine(proxyLabel, result) {
  if (!result.findings.length) return null;
  const parts = result.findings.map((f) => {
    const val = f.value ? `=${f.value}` : '';
    return `${f.header}${val} (${f.detail})`;
  });
  return (
    `\x1b[31m[${result.verdict}] ${proxyLabel}: ${parts.join('; ')}\x1b[0m`
  );
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
