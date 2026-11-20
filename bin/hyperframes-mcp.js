#!/usr/bin/env node
// Command-line entry for the installed package. Flags map onto the environment variables the server reads,
// so `hyperframes-mcp --port 9006 --workspace ~/hf` is the same as PORT=9006 HF_WORKSPACE=~/hf.
import { homedir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const usage = `Usage: hyperframes-mcp [options]

Options:
  --host <addr>        Listen address (env HOST, default 0.0.0.0)
  -p, --port <n>       Listen port (env PORT, default 9006)
  -w, --workspace <d>  Project directory (env HF_WORKSPACE, default <install dir>/.hyperframes-mcp/projects)
  --browser <path>     Chrome/Chromium executable (env PUPPETEER_EXECUTABLE_PATH)
  -v, --version        Print version
  -h, --help           Show this help

Other settings (timeouts, upload limits, PUBLIC_BASE_URL, ...) are read from environment variables; see README.`;

let values;
try {
  ({ values } = parseArgs({
    options: {
      host: { type: 'string' },
      port: { type: 'string', short: 'p' },
      workspace: { type: 'string', short: 'w' },
      browser: { type: 'string' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (error) {
  console.error(`${error.message}\n\n${usage}`);
  process.exit(2);
}

if (values.help) { console.log(usage); process.exit(0); }
if (values.version) {
  console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  process.exit(0);
}

const expandHome = value => value.replace(/^~(?=$|\/)/, homedir());
if (values.host) process.env.HOST = values.host;
if (values.port) process.env.PORT = values.port;
if (values.browser) process.env.PUPPETEER_EXECUTABLE_PATH = expandHome(values.browser);
if (values.workspace) process.env.HF_WORKSPACE = path.resolve(expandHome(values.workspace));

await import('../src/server.js');
