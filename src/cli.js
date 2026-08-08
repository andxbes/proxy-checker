#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectProxies } from './collector.js';
import { checkProxies, resolveRealIp } from './checker.js';
import { getJudgeConfig, loadEnv } from './env.js';
import { startJudgeServer } from './judge/server.js';
import { listSourceIds } from './parsers/registry.js';
import { dataPaths } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0];
  /** @type {string[]} */
  const sources = [];
  /** @type {string[]} */
  const inputs = [];
  /** @type {{
   *   command?: string,
   *   country?: string,
   *   check?: string,
   *   judge?: string,
   *   timeout: number,
   *   concurrency: number,
   *   sources: string[],
   *   inputs: string[],
   *   from: 'all' | 'proxies' | 'custom',
   *   anonymity?: import('./types.js').Anonymity,
   *   protocol?: import('./types.js').Protocol,
   *   help: boolean,
   * }} */
  const opts = {
    timeout: 10_000,
    concurrency: 50,
    sources,
    inputs,
    from: 'all',
    help: false,
  };

  if (!command || command === '-h' || command === '--help') {
    opts.help = true;
    return opts;
  }

  if (!['collect', 'check', 'run'].includes(command)) {
    throw new Error(`Unknown command "${command}". Use collect | check | run.`);
  }
  opts.command = command;

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (arg === '--country' && next) {
      opts.country = next.toUpperCase();
      i += 1;
    } else if ((arg === '--check' || arg === '--target') && next) {
      opts.check = next;
      i += 1;
    } else if (arg === '--judge' && next) {
      opts.judge = next;
      i += 1;
    } else if (arg === '--source' && next) {
      sources.push(next);
      i += 1;
    } else if ((arg === '--input' || arg === '-i') && next) {
      inputs.push(next);
      i += 1;
    } else if (arg === '--from' && next) {
      if (!['all', 'proxies', 'custom'].includes(next)) {
        throw new Error('--from must be all | proxies | custom');
      }
      opts.from = /** @type {'all' | 'proxies' | 'custom'} */ (next);
      i += 1;
    } else if (arg === '--protocol' && next) {
      const protocol = next.toLowerCase();
      if (!['http', 'https', 'socks4', 'socks5'].includes(protocol)) {
        throw new Error('--protocol must be http | https | socks4 | socks5');
      }
      opts.protocol = /** @type {import('./types.js').Protocol} */ (protocol);
      i += 1;
    } else if (arg === '--anonymity' && next) {
      const anonymity = next.toLowerCase();
      if (!['anonymous', 'elite'].includes(anonymity)) {
        throw new Error('--anonymity must be anonymous | elite');
      }
      opts.anonymity = /** @type {import('./types.js').Anonymity} */ (anonymity);
      i += 1;
    } else if (arg === '--timeout' && next) {
      opts.timeout = Number(next);
      i += 1;
    } else if (arg === '--concurrency' && next) {
      opts.concurrency = Number(next);
      i += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) {
    throw new Error('--timeout must be a positive number (ms)');
  }
  if (!Number.isFinite(opts.concurrency) || opts.concurrency <= 0) {
    throw new Error('--concurrency must be a positive number');
  }

  return opts;
}

function printHelp() {
  const sources = listSourceIds().join(', ') || '(none)';
  console.log(`proxy-checker — collect and check anonymous/elite proxies

Usage:
  npm start -- collect [--country IT] [--source spys-me]
  npm start -- check --check https://example.com [--country IT] [--from custom]
  npm start -- check --check https://example.com --input ./my-list.txt --protocol http
  npm start -- check [--judge URL] [--country IT]   # anonymity via local judge + .env
  npm start -- run --check https://example.com [--country IT]
  npm start -- run [--country IT]                   # collect + judge if JUDGE_PUBLIC_URL set

Commands:
  collect   Fetch proxies → data/proxies/ (does NOT touch data/custom/)
  check     Test proxies (liveness and/or anonymity)
  run       collect, then check

Liveness vs anonymity:
  --check URL     Liveness only: keep proxies that get final HTTP 200
  --judge URL     Anonymity mode (overrides JUDGE_PUBLIC_URL from .env)
  If JUDGE_PUBLIC_URL is set in .env (or --judge is passed), check/run starts a
  local judge server for the scan, classifies elite/anonymous/transparent, and
  keeps only anonymous+elite. Transparent proxies are discarded.

Your own lists (never overwritten by collect):
  data/custom/{CC}/{anonymity}-{protocol}.txt
  Example: data/custom/IT/elite-http.txt

Options:
  --country CC       ISO country code (e.g. IT). Omit = all countries.
  --check URL        Target URL for liveness check
  --target URL       Alias for --check
  --judge URL        Public judge URL (anonymity mode; overrides .env)
  --from SOURCE      Check lists from: all (default) | proxies | custom
  --input PATH       Extra file or directory to check (repeatable)
  --protocol TYPE    For plain --input files: http|https|socks4|socks5 (default http)
  --anonymity TYPE   For plain --input files: anonymous|elite (default elite)
  --source ID        Source parser id for collect (repeatable)
  --timeout MS       Hard per-proxy deadline (default: 10000)
  --concurrency N    Parallel checks (default: 50)
  -h, --help         Show this help

.env (see .env.example):
  JUDGE_PUBLIC_URL   Public URL pointing at this machine's JUDGE_PORT
  JUDGE_HOST/PORT    Local bind (default 0.0.0.0:8787)
  JUDGE_TRUST_PROXY  1 when using ngrok/Cloudflare/nginx in front
  JUDGE_REAL_IP      Optional; auto-detected via direct GET to public URL

Registered sources: ${sources}

Layout:
  data/proxies/{CC}/...   collected (rewritten by collect)
  data/custom/{CC}/...    your lists (safe)
  data/checked/{slug}/{CC}/... working proxies after check
`);
}

/**
 * @param {ReturnType<typeof parseArgs>} opts
 */
async function runCheck(opts) {
  const { checkedDir } = dataPaths(projectRoot);
  const judgeConfig = getJudgeConfig({ publicUrl: opts.judge });
  const judgeMode = Boolean(judgeConfig.publicUrl);

  if (!judgeMode && !opts.check) {
    throw new Error(
      'check/run require --check <url>, or set JUDGE_PUBLIC_URL in .env / pass --judge <url>',
    );
  }

  if (judgeMode && opts.check && !opts.judge) {
    process.stderr.write(
      'Judge mode active (JUDGE_PUBLIC_URL / --judge); ' +
        `--check ${opts.check} ignored for the scan target.\n`,
    );
  }

  if (!judgeMode) {
    const { stats, slug } = await checkProxies({
      projectRoot,
      targetUrl: /** @type {string} */ (opts.check),
      country: opts.country,
      timeout: opts.timeout,
      concurrency: opts.concurrency,
      from: opts.from,
      inputs: opts.inputs,
      anonymity: opts.anonymity,
      protocol: opts.protocol,
      judgeMode: false,
    });

    console.log(
      `Working proxies: ${stats.working}/${stats.total} → ${stats.files} files ` +
        `across ${stats.countries} countries`,
    );
    console.log(`  → ${path.join(checkedDir, slug)}`);
    return;
  }

  if (!judgeConfig.publicUrl) {
    throw new Error(
      'Judge mode needs a public URL. Set JUDGE_PUBLIC_URL in .env ' +
        '(tunnel/VPS/port-forward to JUDGE_PORT) or pass --judge <url>.',
    );
  }

  /** @type {Awaited<ReturnType<typeof startJudgeServer>> | undefined} */
  let server;
  try {
    server = await startJudgeServer({
      host: judgeConfig.host,
      port: judgeConfig.port,
      path: judgeConfig.path,
      trustProxy: judgeConfig.trustProxy,
    });

    const realIp = await resolveRealIp(
      judgeConfig.publicUrl,
      judgeConfig.realIp,
      Math.min(opts.timeout, 15_000),
    );
    process.stderr.write(`Using real IP for anonymity checks: ${realIp}\n`);

    const { stats, slug } = await checkProxies({
      projectRoot,
      targetUrl: judgeConfig.publicUrl,
      country: opts.country,
      timeout: opts.timeout,
      concurrency: opts.concurrency,
      from: opts.from,
      inputs: opts.inputs,
      anonymity: opts.anonymity,
      protocol: opts.protocol,
      judgeMode: true,
      realIp,
    });

    console.log(
      `Working proxies: ${stats.working}/${stats.total} ` +
        `(elite=${stats.elite}, anonymous=${stats.anonymous}, ` +
        `transparent=${stats.transparent}, dead=${stats.dead}) → ` +
        `${stats.files} files across ${stats.countries} countries`,
    );
    console.log(`  → ${path.join(checkedDir, slug)}`);
  } finally {
    if (server) {
      try {
        await server.close();
        process.stderr.write('Judge server stopped.\n');
      } catch {
        /* ignore */
      }
    }
  }
}

async function main() {
  await loadEnv(projectRoot);

  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  if (opts.help) {
    printHelp();
    return;
  }

  const { proxiesDir, customDir } = dataPaths(projectRoot);

  try {
    if (opts.command === 'collect' || opts.command === 'run') {
      const { stats } = await collectProxies({
        projectRoot,
        country: opts.country,
        sources: opts.sources,
      });
      console.log(
        `Collected ${stats.proxies} proxies into ${stats.files} files ` +
          `across ${stats.countries} countries (${stats.sources.join(', ')})` +
          (stats.duplicates ? `; removed ${stats.duplicates} duplicate(s)` : ''),
      );
      console.log(`  → ${proxiesDir}`);
      console.log(`  (your lists stay in ${customDir})`);
    }

    if (opts.command === 'check' || opts.command === 'run') {
      await runCheck(opts);
    }
  } catch (err) {
    console.error(err.message || err);
    process.exitCode = 1;
  }
}

main()
  .then(() => {
    // Proxy agents/sockets can leave handles open; exit explicitly so the shell returns.
    process.exit(process.exitCode ?? 0);
  })
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
