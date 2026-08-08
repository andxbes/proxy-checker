import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Parse KEY=VALUE lines into an object (no export, no interpolation).
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvText(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load `.env` from project root into process.env (does not override existing keys).
 * @param {string} projectRoot
 * @param {string} [fileName]
 * @returns {Promise<Record<string, string>>}
 */
export async function loadEnv(projectRoot, fileName = '.env') {
  const filePath = path.join(projectRoot, fileName);
  let text = '';
  try {
    text = await readFile(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }

  const parsed = parseEnvText(text);
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return parsed;
}

/**
 * Judge-related settings from env (+ optional CLI override for public URL).
 * @param {{ publicUrl?: string }} [overrides]
 * @returns {{
 *   publicUrl: string,
 *   host: string,
 *   port: number,
 *   trustProxy: boolean,
 *   realIp: string,
 *   path: string,
 * }}
 */
export function getJudgeConfig(overrides = {}) {
  const publicUrl = (
    overrides.publicUrl ||
    process.env.JUDGE_PUBLIC_URL ||
    ''
  ).trim();

  const host = (process.env.JUDGE_HOST || '0.0.0.0').trim() || '0.0.0.0';
  const port = Number(process.env.JUDGE_PORT || 8787);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error('JUDGE_PORT must be a valid TCP port (1–65535)');
  }

  const trustRaw = (process.env.JUDGE_TRUST_PROXY || '0').trim().toLowerCase();
  const trustProxy = ['1', 'true', 'yes', 'on'].includes(trustRaw);
  const realIp = (process.env.JUDGE_REAL_IP || '').trim();

  let pathname = '/judge';
  if (publicUrl) {
    try {
      const parsed = new URL(publicUrl);
      pathname = parsed.pathname || '/judge';
      if (pathname.length > 1 && pathname.endsWith('/')) {
        pathname = pathname.slice(0, -1);
      }
    } catch {
      throw new Error(`Invalid JUDGE_PUBLIC_URL / --judge: ${publicUrl}`);
    }
  }

  return { publicUrl, host, port, trustProxy, realIp, path: pathname };
}
