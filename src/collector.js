import { resolveParsers } from './parsers/registry.js';
import { dataPaths, dedupeRecords, writeProxyLists } from './storage.js';

/**
 * @param {object} options
 * @param {string} options.projectRoot
 * @param {string} [options.country]
 * @param {string[]} [options.sources]
 * @returns {Promise<{
 *   records: import('./types.js').ProxyRecord[],
 *   stats: { countries: number, files: number, proxies: number, sources: string[] }
 * }>}
 */
export async function collectProxies(options) {
  const parsers = resolveParsers(options.sources);
  const fetchOptions = options.country
    ? { country: options.country.toUpperCase() }
    : {};

  /** @type {import('./types.js').ProxyRecord[]} */
  const all = [];

  for (const parser of parsers) {
    process.stderr.write(`Fetching source: ${parser.id}...\n`);
    const batch = await parser.fetchAndParse(fetchOptions);
    process.stderr.write(`  ${parser.id}: ${batch.length} proxies (ANM/HIA)\n`);
    all.push(...batch);
  }

  let records = dedupeRecords(all);

  if (options.country) {
    const cc = options.country.toUpperCase();
    records = records.filter((r) => r.country === cc);
  }

  const { proxiesDir } = dataPaths(options.projectRoot);
  const stats = await writeProxyLists(proxiesDir, records);

  return {
    records,
    stats: {
      ...stats,
      sources: parsers.map((p) => p.id),
    },
  };
}
