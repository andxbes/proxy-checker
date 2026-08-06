import { spysMeParser } from './spysMe.js';
import { proxyFreeOnlyParser } from './proxyFreeOnly.js';

/**
 * Register new source parsers here.
 * @type {import('./base.js').SourceParser[]}
 */
export const parsers = [spysMeParser, proxyFreeOnlyParser];

/**
 * @param {string[]} [sourceIds]
 * @returns {import('./base.js').SourceParser[]}
 */
export function resolveParsers(sourceIds) {
  if (!sourceIds || sourceIds.length === 0) {
    return [...parsers];
  }

  const byId = new Map(parsers.map((p) => [p.id, p]));
  /** @type {import('./base.js').SourceParser[]} */
  const selected = [];

  for (const id of sourceIds) {
    const parser = byId.get(id);
    if (!parser) {
      const known = parsers.map((p) => p.id).join(', ') || '(none)';
      throw new Error(`Unknown source "${id}". Available: ${known}`);
    }
    if (!selected.includes(parser)) {
      selected.push(parser);
    }
  }

  return selected;
}

/**
 * @returns {string[]}
 */
export function listSourceIds() {
  return parsers.map((p) => p.id);
}
