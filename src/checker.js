import http from 'node:http';
import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { classifyJudgePayload } from './judge/classify.js';
import {
  dataPaths,
  loadProxiesForCheck,
  urlToSlug,
  writeCheckedLists,
} from './storage.js';
import { proxyAddress } from './types.js';

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * HTTP proxies with SSL support still speak HTTP to the proxy (CONNECT for HTTPS targets).
 * @param {import('./types.js').ProxyRecord} record
 * @param {number} timeoutMs
 * @returns {import('node:http').Agent}
 */
function createProxyAgent(record, timeoutMs) {
  const addr = proxyAddress(record);
  // keepAlive must be false — otherwise free sockets keep the event loop alive
  // and the CLI never returns to the shell after a scan.
  const agentOptions = {
    timeout: timeoutMs,
    connectTimeout: timeoutMs,
    keepAlive: false,
    maxSockets: 1,
  };

  switch (record.protocol) {
    case 'http':
    case 'https':
      return new HttpsProxyAgent(`http://${addr}`, agentOptions);
    case 'socks4':
      return new SocksProxyAgent(`socks4://${addr}`, agentOptions);
    case 'socks5':
      return new SocksProxyAgent(`socks5://${addr}`, agentOptions);
    default:
      throw new Error(`Unsupported protocol: ${record.protocol}`);
  }
}

/**
 * @param {import('node:http').IncomingMessage} res
 * @returns {Promise<string>}
 */
function readResponseBody(res) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    res.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

/**
 * Hard wall-clock timeout request (optional proxy agent). Follows redirects.
 *
 * @param {string} targetUrl
 * @param {number} timeoutMs
 * @param {{
 *   agent?: import('node:http').Agent,
 *   readBody?: boolean,
 * }} [options]
 * @returns {Promise<{ ok: boolean, status: number, body: string }>}
 */
function requestTarget(targetUrl, timeoutMs, options = {}) {
  const readBody = Boolean(options.readBody);

  return new Promise((resolve) => {
    let settled = false;
    let hops = 0;
    /** @type {import('node:http').ClientRequest | undefined} */
    let req;
    const agent = options.agent;

    const destroyRequest = () => {
      try {
        req?.destroy();
      } catch {
        /* ignore */
      }
      try {
        const socket = req?.socket;
        if (socket && !socket.destroyed) socket.destroy();
      } catch {
        /* ignore */
      }
      req = undefined;
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      destroyRequest();
      try {
        agent?.destroy?.();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const hardTimer = setTimeout(
      () => finish({ ok: false, status: 0, body: '' }),
      timeoutMs,
    );

    const doRequest = (currentUrl) => {
      if (settled) return;
      destroyRequest();

      let url;
      try {
        url = new URL(currentUrl);
      } catch {
        finish({ ok: false, status: 0, body: '' });
        return;
      }

      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      try {
        req = lib.request(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: `${url.pathname}${url.search}`,
            method: 'GET',
            agent,
            timeout: timeoutMs,
            headers: {
              Host: url.host,
              'User-Agent': 'Mozilla/5.0 (compatible; proxy-checker/1.0)',
              Accept: 'application/json, */*',
              Connection: 'close',
            },
          },
          (res) => {
            const code = res.statusCode ?? 0;
            const location = res.headers.location;

            if (
              REDIRECT_STATUSES.has(code) &&
              location &&
              hops < MAX_REDIRECTS
            ) {
              hops += 1;
              res.resume();
              try {
                doRequest(new URL(location, url).href);
              } catch {
                finish({ ok: false, status: code, body: '' });
              }
              return;
            }

            if (!readBody) {
              res.resume();
              finish({ ok: code === 200, status: code, body: '' });
              return;
            }

            readResponseBody(res)
              .then((body) => {
                finish({ ok: code === 200, status: code, body });
              })
              .catch(() => {
                finish({ ok: false, status: code, body: '' });
              });
          },
        );
      } catch {
        finish({ ok: false, status: 0, body: '' });
        return;
      }

      req.setMaxListeners(20);
      req.once('timeout', () => finish({ ok: false, status: 0, body: '' }));
      req.once('error', () => finish({ ok: false, status: 0, body: '' }));
      req.end();
    };

    doRequest(targetUrl);
  });
}

/**
 * Liveness-only check (final HTTP 200).
 * @param {string} targetUrl
 * @param {import('./types.js').ProxyRecord} record
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function checkOne(targetUrl, record, timeoutMs) {
  let agent;
  try {
    agent = createProxyAgent(record, timeoutMs);
  } catch {
    return false;
  }
  const result = await requestTarget(targetUrl, timeoutMs, { agent });
  return result.ok;
}

/**
 * Resolve our real public IP as seen by the judge (via public URL, not localhost).
 * @param {string} publicUrl
 * @param {string} [configuredIp]
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
export async function resolveRealIp(publicUrl, configuredIp, timeoutMs) {
  const configured = (configuredIp || '').trim();
  if (configured) return configured;

  const result = await requestTarget(publicUrl, timeoutMs, { readBody: true });
  if (!result.ok || !result.body) {
    throw new Error(
      `Could not resolve JUDGE_REAL_IP via direct GET ${publicUrl} ` +
        `(HTTP ${result.status || 'error'}). Set JUDGE_REAL_IP in .env or fix the tunnel.`,
    );
  }

  let payload;
  try {
    payload = JSON.parse(result.body);
  } catch {
    throw new Error(
      `Judge at ${publicUrl} did not return JSON. Is the public URL pointing at this judge?`,
    );
  }

  const ip = typeof payload?.ip === 'string' ? payload.ip.trim() : '';
  if (!ip || ip === '127.0.0.1' || ip === '::1') {
    throw new Error(
      `Resolved real IP looks local (${ip || 'empty'}). ` +
        `Set JUDGE_REAL_IP to your public IP, or ensure JUDGE_PUBLIC_URL reaches the judge via the internet.`,
    );
  }
  return ip;
}

/**
 * @param {string} judgeUrl
 * @param {import('./types.js').ProxyRecord} record
 * @param {string} realIp
 * @param {number} timeoutMs
 * @returns {Promise<import('./judge/classify.js').JudgeVerdict>}
 */
async function judgeOne(judgeUrl, record, realIp, timeoutMs) {
  let agent;
  try {
    agent = createProxyAgent(record, timeoutMs);
  } catch {
    return 'dead';
  }

  const result = await requestTarget(judgeUrl, timeoutMs, {
    agent,
    readBody: true,
  });
  if (!result.ok || !result.body) return 'dead';

  let payload;
  try {
    payload = JSON.parse(result.body);
  } catch {
    return 'dead';
  }

  return classifyJudgePayload(payload, realIp);
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<void>} worker
 */
async function mapPool(items, concurrency, worker) {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) break;
        await worker(items[index], index);
      }
    },
  );
  await Promise.all(workers);
}

/**
 * @param {object} options
 * @param {string} options.projectRoot
 * @param {string} options.targetUrl
 * @param {string} [options.country]
 * @param {number} [options.timeout]
 * @param {number} [options.concurrency]
 * @param {'all' | 'proxies' | 'custom'} [options.from]
 * @param {string[]} [options.inputs]
 * @param {import('./types.js').Anonymity} [options.anonymity]
 * @param {import('./types.js').Protocol} [options.protocol]
 * @param {import('./types.js').ProxyRecord[]} [options.records]
 * @param {boolean} [options.judgeMode]
 * @param {string} [options.realIp]
 * @returns {Promise<{
 *   working: import('./types.js').ProxyRecord[],
 *   slug: string,
 *   stats: {
 *     total: number,
 *     working: number,
 *     files: number,
 *     countries: number,
 *     elite: number,
 *     anonymous: number,
 *     transparent: number,
 *     dead: number,
 *     judgeMode: boolean,
 *   }
 * }>}
 */
export async function checkProxies(options) {
  const timeout = options.timeout ?? 10_000;
  const concurrency = options.concurrency ?? 50;
  const judgeMode = Boolean(options.judgeMode);
  const { checkedDir } = dataPaths(options.projectRoot);

  const records =
    options.records ??
    (await loadProxiesForCheck({
      projectRoot: options.projectRoot,
      country: options.country,
      from: options.from,
      inputs: options.inputs,
      anonymity: options.anonymity,
      protocol: options.protocol,
    }));

  if (records.length === 0) {
    throw new Error(
      'No proxies to check. Put lists in data/custom/, run collect, or pass --input <file|dir>.',
    );
  }

  /** @type {import('./types.js').ProxyRecord[]} */
  const working = [];
  let elite = 0;
  let anonymous = 0;
  let transparent = 0;
  let dead = 0;
  let done = 0;
  const startedAt = Date.now();
  const progressEvery = records.length <= concurrency ? 1 : concurrency;

  if (judgeMode) {
    const realIp = (options.realIp || '').trim();
    if (!realIp) {
      throw new Error('Judge mode requires realIp (JUDGE_REAL_IP or auto-detect)');
    }

    process.stderr.write(
      `Judging ${records.length} proxies via ${options.targetUrl} ` +
        `(realIp=${realIp}, concurrency=${concurrency}, timeout=${timeout}ms)...\n`,
    );

    await mapPool(records, concurrency, async (record) => {
      const verdict = await judgeOne(
        options.targetUrl,
        record,
        realIp,
        timeout,
      );
      done += 1;

      if (verdict === 'elite') {
        elite += 1;
        working.push({ ...record, anonymity: 'elite' });
      } else if (verdict === 'anonymous') {
        anonymous += 1;
        working.push({ ...record, anonymity: 'anonymous' });
      } else if (verdict === 'transparent') {
        transparent += 1;
      } else {
        dead += 1;
      }

      if (done % progressEvery === 0 || done === records.length) {
        const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
        process.stderr.write(
          `  progress: ${done}/${records.length} completed, ` +
            `elite=${elite} anonymous=${anonymous} transparent=${transparent} dead=${dead}, ` +
            `elapsed: ${elapsedSec}s\n`,
        );
      }
    });
  } else {
    process.stderr.write(
      `Checking ${records.length} proxies against ${options.targetUrl} ` +
        `(concurrency=${concurrency} parallel, timeout=${timeout}ms, ` +
        `progress log every ${progressEvery} completed)...\n`,
    );

    await mapPool(records, concurrency, async (record) => {
      const ok = await checkOne(options.targetUrl, record, timeout);
      done += 1;
      if (ok) {
        working.push(record);
      } else {
        dead += 1;
      }
      if (done % progressEvery === 0 || done === records.length) {
        const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
        process.stderr.write(
          `  progress: ${done}/${records.length} completed, working: ${working.length}, elapsed: ${elapsedSec}s\n`,
        );
      }
    });
  }

  const slug = urlToSlug(options.targetUrl);
  const writeStats = await writeCheckedLists(checkedDir, slug, working);

  return {
    working,
    slug,
    stats: {
      total: records.length,
      working: working.length,
      files: writeStats.files,
      countries: writeStats.countries,
      elite,
      anonymous,
      transparent,
      dead: judgeMode ? dead : records.length - working.length,
      judgeMode,
    },
  };
}
