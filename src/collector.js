import { resolveParsers } from './parsers/registry.js';
import { dataPaths, dedupeRecords, writeProxyLists } from './storage.js';

/**
 * @param {object} options
 * @param {string} options.projectRoot
 * @param {string} [options.country]
 * @param {string[]} [options.sources]
 * @returns {Promise<{
 *   records: import('./types.js').ProxyRecord[],
 *   stats: {
 *     countries: number,
 *     files: number,
 *     proxies: number,
 *     duplicates: number,
 *     sources: string[],
 *   }
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
    try {
      const batch = await parser.fetchAndParse(fetchOptions);
      process.stderr.write(`  ${parser.id}: ${batch.length} proxies (ANM/HIA)\n`);
      all.push(...batch);
    } catch (err) {
      const message = err?.cause?.message || err?.message || String(err);
      process.stderr.write(
        `  ${parser.id}: FAILED (${message}) — skipping, continue with other sources\n`,
      );
    }
  }

  if (all.length === 0) {
    throw new Error(
      'No proxies collected: every source failed or returned nothing. ' +
        'Check network access and --source selection.',
    );
  }

  const beforeDedupe = all.length;
  let records = dedupeRecords(all);
  const duplicates = beforeDedupe - records.length;
  if (duplicates > 0) {
    process.stderr.write(
      `Deduped ${duplicates} duplicate(s) (${beforeDedupe} → ${records.length}) ` +
        `by protocol|host:port — skips extra check requests\n`,
    );
  }

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
      duplicates,
      sources: parsers.map((p) => p.id),
    },
  };
}
