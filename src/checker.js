import http from 'node:http';
import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
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
 * Hard wall-clock timeout: Node's request `timeout` does not abort a stuck
 * TCP/SOCKS connect to a dead proxy (OS can wait 20–30s+).
 * Follows redirects; success = final status 200.
 *
 * @param {string} targetUrl
 * @param {import('./types.js').ProxyRecord} record
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function checkOne(targetUrl, record, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let hops = 0;
    /** @type {import('node:http').ClientRequest | undefined} */
    let req;
    /** @type {import('node:http').Agent | undefined} */
    let agent;

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

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      destroyRequest();
      try {
        agent?.destroy?.();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };

    const hardTimer = setTimeout(() => finish(false), timeoutMs);

    try {
      agent = createProxyAgent(record, timeoutMs);
    } catch {
      finish(false);
      return;
    }

    const doRequest = (currentUrl) => {
      if (settled) return;

      // Drop previous hop before opening the next (avoids stacked listeners).
      destroyRequest();

      let url;
      try {
        url = new URL(currentUrl);
      } catch {
        finish(false);
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
              'User-Agent':
                'Mozilla/5.0 (compatible; proxy-checker/1.0)',
              Accept: '*/*',
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
                finish(false);
              }
              return;
            }

            res.resume();
            finish(code === 200);
          },
        );
      } catch {
        finish(false);
        return;
      }

      // Proxy agents may attach several internal 'socket' handlers per hop.
      req.setMaxListeners(20);
      // Hard timer already covers hangs. once() avoids stacking our own handlers.
      req.once('timeout', () => finish(false));
      req.once('error', () => finish(false));
      req.end();
    };

    doRequest(targetUrl);
  });
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
 * @returns {Promise<{
 *   working: import('./types.js').ProxyRecord[],
 *   slug: string,
 *   stats: { total: number, working: number, files: number, countries: number }
 * }>}
 */
export async function checkProxies(options) {
  const timeout = options.timeout ?? 10_000;
  const concurrency = options.concurrency ?? 50;
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
  let done = 0;
  const startedAt = Date.now();
  // Log cadence only — not the thread count. Use concurrency so it matches --concurrency.
  const progressEvery =
    records.length <= concurrency ? 1 : concurrency;

  process.stderr.write(
    `Checking ${records.length} proxies against ${options.targetUrl} ` +
      `(concurrency=${concurrency} parallel, timeout=${timeout}ms, ` +
      `progress log every ${progressEvery} completed)...\n`,
  );

  await mapPool(records, concurrency, async (record) => {
    const ok = await checkOne(options.targetUrl, record, timeout);
    done += 1;
    if (ok) working.push(record);
    if (done % progressEvery === 0 || done === records.length) {
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
      process.stderr.write(
        `  progress: ${done}/${records.length} completed, working: ${working.length}, elapsed: ${elapsedSec}s\n`,
      );
    }
  });

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
    },
  };
}
