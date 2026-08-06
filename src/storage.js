import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listFileName, proxyAddress } from './types.js';

/**
 * @param {string} projectRoot
 * @returns {{ proxiesDir: string, customDir: string, checkedDir: string }}
 */
export function dataPaths(projectRoot) {
  return {
    proxiesDir: path.join(projectRoot, 'data', 'proxies'),
    customDir: path.join(projectRoot, 'data', 'custom'),
    checkedDir: path.join(projectRoot, 'data', 'checked'),
  };
}

/**
 * Filesystem-safe slug from a target URL.
 * @param {string} url
 * @returns {string}
 */
export function urlToSlug(url) {
  return url
    .trim()
    .replace(/^https?:\/\//i, (m) => m.replace('://', '_').toLowerCase())
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 180) || 'target';
}

/**
 * Merge records: key = protocol|host:port.
 * On anonymity conflict prefer elite.
 * @param {import('./types.js').ProxyRecord[]} records
 * @returns {import('./types.js').ProxyRecord[]}
 */
export function dedupeRecords(records) {
  /** @type {Map<string, import('./types.js').ProxyRecord>} */
  const map = new Map();

  for (const record of records) {
    const key = `${record.protocol}|${proxyAddress(record)}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, record);
      continue;
    }
    if (existing.anonymity !== 'elite' && record.anonymity === 'elite') {
      map.set(key, record);
    }
  }

  return [...map.values()];
}

/**
 * Group records by country → anonymity-protocol file contents.
 * @param {import('./types.js').ProxyRecord[]} records
 * @returns {Map<string, Map<string, Set<string>>>}
 */
export function groupByCountryAndFile(records) {
  /** @type {Map<string, Map<string, Set<string>>>} */
  const byCountry = new Map();

  for (const record of records) {
    const cc = record.country.toUpperCase();
    const file = listFileName(record.anonymity, record.protocol);
    const address = proxyAddress(record);

    if (!byCountry.has(cc)) byCountry.set(cc, new Map());
    const files = byCountry.get(cc);
    if (!files.has(file)) files.set(file, new Set());
    files.get(file).add(address);
  }

  return byCountry;
}

/**
 * Write collected proxies under data/proxies/{CC}/{anonymity}-{protocol}.txt
 * @param {string} proxiesDir
 * @param {import('./types.js').ProxyRecord[]} records
 * @returns {Promise<{ countries: number, files: number, proxies: number }>}
 */
export async function writeProxyLists(proxiesDir, records) {
  const grouped = groupByCountryAndFile(records);
  let files = 0;
  let proxies = 0;

  for (const [country, fileMap] of grouped) {
    const dir = path.join(proxiesDir, country);
    await mkdir(dir, { recursive: true });

    for (const [fileName, addresses] of fileMap) {
      const sorted = [...addresses].sort();
      await writeFile(path.join(dir, fileName), `${sorted.join('\n')}\n`, 'utf8');
      files += 1;
      proxies += sorted.length;
    }
  }

  return { countries: grouped.size, files, proxies };
}

/**
 * Write working proxies under data/checked/{slug}/...
 * @param {string} checkedDir
 * @param {string} slug
 * @param {import('./types.js').ProxyRecord[]} records
 * @returns {Promise<{ files: number, proxies: number }>}
 */
export async function writeCheckedLists(checkedDir, slug, records) {
  const base = path.join(checkedDir, slug);
  await mkdir(base, { recursive: true });

  const grouped = groupByCountryAndFile(records);
  /** @type {Map<string, Set<string>>} */
  const mergedFiles = new Map();

  for (const fileMap of grouped.values()) {
    for (const [fileName, addresses] of fileMap) {
      if (!mergedFiles.has(fileName)) mergedFiles.set(fileName, new Set());
      const set = mergedFiles.get(fileName);
      for (const addr of addresses) set.add(addr);
    }
  }

  let files = 0;
  let proxies = 0;

  for (const [fileName, addresses] of mergedFiles) {
    const sorted = [...addresses].sort();
    await writeFile(path.join(base, fileName), `${sorted.join('\n')}\n`, 'utf8');
    files += 1;
    proxies += sorted.length;
  }

  return { files, proxies };
}

/**
 * @param {string} fileName
 * @returns {{ anonymity: import('./types.js').Anonymity, protocol: import('./types.js').Protocol } | null}
 */
function parseListFileName(fileName) {
  const match = /^([a-z]+)-([a-z0-9]+)\.txt$/i.exec(fileName);
  if (!match) return null;
  const anonymity = match[1].toLowerCase();
  const protocol = match[2].toLowerCase();
  if (anonymity !== 'anonymous' && anonymity !== 'elite') return null;
  if (!['http', 'https', 'socks4', 'socks5'].includes(protocol)) return null;
  return {
    anonymity: /** @type {import('./types.js').Anonymity} */ (anonymity),
    protocol: /** @type {import('./types.js').Protocol} */ (protocol),
  };
}

/**
 * Parse ip:port lines from text.
 * @param {string} content
 * @param {{
 *   country: string,
 *   anonymity: import('./types.js').Anonymity,
 *   protocol: import('./types.js').Protocol,
 *   source?: string,
 * }} meta
 * @returns {import('./types.js').ProxyRecord[]}
 */
export function parseProxyLines(content, meta) {
  /** @type {import('./types.js').ProxyRecord[]} */
  const records = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [host, portStr] = trimmed.split(':');
    const port = Number(portStr);
    if (!host || !Number.isFinite(port)) continue;
    records.push({
      host,
      port,
      country: meta.country.toUpperCase(),
      anonymity: meta.anonymity,
      protocol: meta.protocol,
      source: meta.source ?? 'disk',
    });
  }
  return records;
}

/**
 * Load one list file (named anonymity-protocol.txt or plain ip:port with defaults).
 * @param {string} filePath
 * @param {{
 *   country?: string,
 *   anonymity?: import('./types.js').Anonymity,
 *   protocol?: import('./types.js').Protocol,
 *   source?: string,
 * }} [options]
 * @returns {Promise<import('./types.js').ProxyRecord[]>}
 */
export async function loadProxyFile(filePath, options = {}) {
  const base = path.basename(filePath);
  const parsed = parseListFileName(base);
  const anonymity = options.anonymity ?? parsed?.anonymity ?? 'elite';
  const protocol = options.protocol ?? parsed?.protocol ?? 'http';
  const country = (options.country ?? 'CUSTOM').toUpperCase();
  const content = await readFile(filePath, 'utf8');
  return parseProxyLines(content, {
    country,
    anonymity,
    protocol,
    source: options.source ?? 'custom',
  });
}

/**
 * Load proxies from a directory tree:
 * - {CC}/{anonymity}-{protocol}.txt
 * - or flat {anonymity}-{protocol}.txt / plain *.txt at root (country CUSTOM)
 *
 * @param {string} rootDir
 * @param {{
 *   country?: string,
 *   anonymity?: import('./types.js').Anonymity,
 *   protocol?: import('./types.js').Protocol,
 *   source?: string,
 * }} [options]
 * @returns {Promise<import('./types.js').ProxyRecord[]>}
 */
export async function loadProxyLists(rootDir, options = {}) {
  /** @type {import('./types.js').ProxyRecord[]} */
  const records = [];
  const source = options.source ?? 'disk';

  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }

  const wanted = options.country?.toUpperCase();

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    if (entry.isDirectory()) {
      const country = entry.name.toUpperCase();
      if (wanted && country !== wanted) continue;

      const dir = path.join(rootDir, entry.name);
      const files = await readdir(dir);
      for (const fileName of files) {
        const parsed = parseListFileName(fileName);
        if (!parsed) continue;
        const content = await readFile(path.join(dir, fileName), 'utf8');
        records.push(
          ...parseProxyLines(content, {
            country,
            anonymity: parsed.anonymity,
            protocol: parsed.protocol,
            source,
          }),
        );
      }
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.txt')) continue;

    // Flat files at root: include unless --country is set to something other than CUSTOM
    if (wanted && wanted !== 'CUSTOM') continue;

    const filePath = path.join(rootDir, entry.name);
    const parsed = parseListFileName(entry.name);
    records.push(
      ...(await loadProxyFile(filePath, {
        country: 'CUSTOM',
        anonymity: options.anonymity ?? parsed?.anonymity,
        protocol: options.protocol ?? parsed?.protocol,
        source,
      })),
    );
  }

  return records;
}

/**
 * Load a file or directory path for checking.
 * @param {string} inputPath
 * @param {{
 *   country?: string,
 *   anonymity?: import('./types.js').Anonymity,
 *   protocol?: import('./types.js').Protocol,
 * }} [options]
 * @returns {Promise<import('./types.js').ProxyRecord[]>}
 */
export async function loadProxyInput(inputPath, options = {}) {
  const resolved = path.resolve(inputPath);
  const info = await stat(resolved);
  if (info.isDirectory()) {
    return loadProxyLists(resolved, { ...options, source: 'input' });
  }
  if (info.isFile()) {
    return loadProxyFile(resolved, { ...options, source: 'input' });
  }
  throw new Error(`Not a file or directory: ${resolved}`);
}

/**
 * Build the proxy set used by check.
 * @param {object} options
 * @param {string} options.projectRoot
 * @param {string} [options.country]
 * @param {'all' | 'proxies' | 'custom'} [options.from]
 * @param {string[]} [options.inputs]
 * @param {import('./types.js').Anonymity} [options.anonymity]
 * @param {import('./types.js').Protocol} [options.protocol]
 * @returns {Promise<import('./types.js').ProxyRecord[]>}
 */
export async function loadProxiesForCheck(options) {
  const { proxiesDir, customDir } = dataPaths(options.projectRoot);
  const from = options.from ?? 'all';
  /** @type {import('./types.js').ProxyRecord[]} */
  const all = [];

  if (from === 'all' || from === 'proxies') {
    all.push(
      ...(await loadProxyLists(proxiesDir, {
        country: options.country,
        source: 'proxies',
      })),
    );
  }

  if (from === 'all' || from === 'custom') {
    all.push(
      ...(await loadProxyLists(customDir, {
        country: options.country,
        source: 'custom',
      })),
    );
  }

  for (const input of options.inputs ?? []) {
    all.push(
      ...(await loadProxyInput(input, {
        country: options.country,
        anonymity: options.anonymity,
        protocol: options.protocol,
      })),
    );
  }

  return dedupeRecords(all);
}
