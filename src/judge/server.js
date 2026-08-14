import http from 'node:http';

/**
 * Headers commonly injected by reverse proxies / tunnels — not from the proxy under test.
 * Used when JUDGE_TRUST_PROXY is enabled.
 */
const TRUST_PROXY_HOP_HEADERS = new Set([
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-forwarded-scheme',
  'x-real-ip',
  'forwarded',
  'cf-connecting-ip',
  'cf-ray',
  'cf-visitor',
  'cf-ipcountry',
  'cdn-loop',
  'true-client-ip',
]);

/**
 * @param {string} value
 * @returns {string}
 */
export function normalizeIp(value) {
  let ip = String(value || '').trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  // strip surrounding brackets for IPv6 literals
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  return ip;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} trustProxy
 * @returns {string}
 */
export function clientIpFromRequest(req, trustProxy) {
  if (trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf.trim()) {
      return normalizeIp(cf.split(',')[0]);
    }
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) {
      return normalizeIp(xff.split(',')[0]);
    }
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string' && real.trim()) {
      return normalizeIp(real.split(',')[0]);
    }
  }
  return normalizeIp(req.socket.remoteAddress || '');
}

/**
 * Flatten incoming headers to a plain string map (first value wins for arrays).
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @returns {Record<string, string>}
 */
function flattenHeaders(headers) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

/**
 * Headers to inspect for anonymity (excludes hop headers when trustProxy).
 * @param {Record<string, string>} headers
 * @param {boolean} trustProxy
 * @returns {Record<string, string>}
 */
export function headersForAnonymityCheck(headers, trustProxy) {
  if (!trustProxy) return { ...headers };
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (TRUST_PROXY_HOP_HEADERS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/**
 * @param {object} options
 * @param {string} [options.host]
 * @param {number} options.port
 * @param {string} [options.path] local path to serve (default /judge)
 * @param {boolean} [options.trustProxy]
 * @returns {Promise<{
 *   host: string,
 *   port: number,
 *   path: string,
 *   localUrl: string,
 *   close: () => Promise<void>,
 * }>}
 */
export function startJudgeServer(options) {
  const host = options.host || '0.0.0.0';
  const port = options.port;
  let pathname = options.path || '/judge';
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  const trustProxy = Boolean(options.trustProxy);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    let reqPath = url.pathname;
    if (reqPath.length > 1 && reqPath.endsWith('/')) {
      reqPath = reqPath.slice(0, -1);
    }

    if (req.method !== 'GET' || reqPath !== pathname) {
      res.writeHead(404, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    const headers = flattenHeaders(req.headers);
    const ip = clientIpFromRequest(req, trustProxy);
    const body = JSON.stringify({
      ip,
      headers,
      anonymityHeaders: headersForAnonymityCheck(headers, trustProxy),
    });

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      Connection: 'close',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });

  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      const localUrl = `http://127.0.0.1:${port}${pathname}`;
      process.stderr.write(
        `Judge server listening on ${host}:${port}${pathname}` +
        ` (trustProxy=${trustProxy})\n`,
      );
      resolve({
        host,
        port,
        path: pathname,
        localUrl,
        close: () =>
          new Promise((resClose, rejClose) => {
            server.close((err) => (err ? rejClose(err) : resClose()));
          }),
      });
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}
