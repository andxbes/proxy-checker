#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectProxies } from './collector.js';
import { checkProxies } from './checker.js';
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
  /** @type {{ command?: string, country?: string, check?: string, timeout: number, concurrency: number, sources: string[], help: boolean }} */
  const opts = {
    timeout: 10_000,
    concurrency: 50,
    sources,
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
    } else if (arg === '--source' && next) {
      sources.push(next);
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
  npm start -- check --check https://example.com [--country IT] [--timeout 10000] [--concurrency 50]
  npm start -- run --check https://example.com [--country IT] [--source spys-me]

Commands:
  collect   Fetch proxies from registered sources and save under data/proxies/
  check     Test saved proxies against a target URL (keep HTTP 200 only)
  run       collect, then check

Options:
  --country CC       ISO country code (e.g. IT). Omit to use all countries.
  --check URL        Target URL for checking (required for check/run)
  --target URL       Alias for --check
  --source ID        Source parser id (repeatable). Default: all registered.
  --timeout MS       Per-proxy request timeout (default: 10000)
  --concurrency N    Parallel checks (default: 50)
  -h, --help         Show this help

Registered sources: ${sources}

Output layout:
  data/proxies/{CC}/{anonymity}-{protocol}.txt
  data/checked/{url-slug}/{anonymity}-{protocol}.txt
`);
}

async function main() {
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

  const { proxiesDir, checkedDir } = dataPaths(projectRoot);

  try {
    if (opts.command === 'collect' || opts.command === 'run') {
      const { stats } = await collectProxies({
        projectRoot,
        country: opts.country,
        sources: opts.sources,
      });
      console.log(
        `Collected ${stats.proxies} proxies into ${stats.files} files ` +
          `across ${stats.countries} countries (${stats.sources.join(', ')})`,
      );
      console.log(`  → ${proxiesDir}`);
    }

    if (opts.command === 'check' || opts.command === 'run') {
      if (!opts.check) {
        throw new Error('check/run require --check <url>');
      }

      const { stats, slug } = await checkProxies({
        projectRoot,
        targetUrl: opts.check,
        country: opts.country,
        timeout: opts.timeout,
        concurrency: opts.concurrency,
      });

      console.log(
        `Working proxies: ${stats.working}/${stats.total} → ${stats.files} files`,
      );
      console.log(`  → ${path.join(checkedDir, slug)}`);
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
