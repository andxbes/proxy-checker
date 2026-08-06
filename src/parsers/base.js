/**
 * Source parser contract.
 *
 * Every proxy source implements:
 * - id: unique string used by --source and ProxyRecord.source
 * - description: short human-readable summary
 * - fetchAndParse({ country? }): Promise<ProxyRecord[]>
 *
 * Parsers must:
 * - drop non-anonymous proxies (transparent / NOA)
 * - map source-specific fields into ProxyRecord
 * - return only anonymous | elite anonymity values
 *
 * @typedef {import('../types.js').ProxyRecord} ProxyRecord
 *
 * @typedef {object} FetchOptions
 * @property {string} [country] ISO2 filter hint (optional; collector also filters)
 *
 * @typedef {object} SourceParser
 * @property {string} id
 * @property {string} description
 * @property {(options?: FetchOptions) => Promise<ProxyRecord[]>} fetchAndParse
 */

export {};
