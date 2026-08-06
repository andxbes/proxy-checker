import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listFileName, proxyAddress } from './types.js';

/**
 * @param {string} projectRoot
 * @returns {{ proxiesDir: string, checkedDir: string }}
 */
export function dataPaths(projectRoot) {
  return {
    proxiesDir: path.join(projectRoot, 'data', 'proxies'),
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
 * Load previously collected proxies from disk.
 * @param {string} proxiesDir
 * @param {{ country?: string }} [options]
 * @returns {Promise<import('./types.js').ProxyRecord[]>}
 */
export async function loadProxyLists(proxiesDir, options = {}) {
  /** @type {import('./types.js').ProxyRecord[]} */
  const records = [];

  let countries;
  try {
    countries = await readdir(proxiesDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }

  const wanted = options.country?.toUpperCase();

  for (const entry of countries) {
    if (!entry.isDirectory()) continue;
    const country = entry.name.toUpperCase();
    if (wanted && country !== wanted) continue;

    const dir = path.join(proxiesDir, entry.name);
    const files = await readdir(dir);

    for (const fileName of files) {
      const match = /^([a-z]+)-([a-z0-9]+)\.txt$/i.exec(fileName);
      if (!match) continue;

      const anonymity = match[1].toLowerCase();
      const protocol = match[2].toLowerCase();
      if (anonymity !== 'anonymous' && anonymity !== 'elite') continue;

      const content = await readFile(path.join(dir, fileName), 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [host, portStr] = trimmed.split(':');
        const port = Number(portStr);
        if (!host || !Number.isFinite(port)) continue;

        records.push({
          host,
          port,
          country,
          anonymity: /** @type {import('./types.js').Anonymity} */ (anonymity),
          protocol: /** @type {import('./types.js').Protocol} */ (protocol),
          source: 'disk',
        });
      }
    }
  }

  return records;
}
