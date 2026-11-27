#!/usr/bin/env node
/**
 * Packages the server into a self-contained install directory, separate from the source:
 *
 *   npm run package -- --out=~/work/tools/hyperframes-mcp
 *
 *   <out>/hyperframes-mcp              launcher (run this; launchd points here)
 *   <out>/app/                         bin/, src/, package.json, production node_modules
 *   <out>/hyperframes-mcp.env.example  reference settings
 *   <out>/hyperframes-mcp.env          yours: created by you, never touched by this script
 *   <out>/.hyperframes-mcp/projects/   projects, created by the server, never touched
 *
 * Re-running upgrades in place: only app/, the launcher and the example are replaced, and the new
 * app/ is installed next to the old one before being swapped in. Restart the server afterwards.
 * Run it on the machine that will host the server: node_modules contains platform binaries.
 *
 * Flags: --out=<dir> (default release/hyperframes-mcp)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER_MARKER = '# hyperframes-mcp launcher';

const flags = new Map(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
  const [k, ...v] = a.slice(2).split('=');
  return [k, v.length ? v.join('=') : true];
}));
const expandHome = p => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);
const out = path.resolve(expandHome(typeof flags.get('out') === 'string' ? flags.get('out') : path.join(REPO, 'release', 'hyperframes-mcp')));

const LAUNCHER = `#!/bin/sh
${LAUNCHER_MARKER}: settings (hyperframes-mcp.env) and projects (.hyperframes-mcp/) live next to this file.
set -e
self=$0
while [ -L "$self" ]; do
	link=$(readlink "$self")
	case $link in
	/*) self=$link ;;
	*) self=$(dirname "$self")/$link ;;
	esac
done
home=$(cd "$(dirname "$self")" && pwd -P)
if [ -f "$home/hyperframes-mcp.env" ]; then
	set -a
	. "$home/hyperframes-mcp.env"
	set +a
fi
node=\${HYPERFRAMES_MCP_NODE:-$(command -v node || true)}
if [ -z "$node" ]; then
	echo "hyperframes-mcp: node not found; put Node >= 22 on PATH or set HYPERFRAMES_MCP_NODE" >&2
	exit 127
fi
export HYPERFRAMES_MCP_HOME="$home"
exec "$node" "$home/app/bin/hyperframes-mcp.js" "$@"
`;

const ENV_EXAMPLE = `# Copy to hyperframes-mcp.env in this directory; the launcher loads it on every start.
# Command-line flags (hyperframes-mcp --help) override these. All variables: see app/README.md.
HOST=0.0.0.0
PORT=9006

# Projects default to <this dir>/.hyperframes-mcp/projects.
# HF_WORKSPACE=/path/to/projects

# Chrome/Chromium used for rendering; unset = auto-detect.
#   macOS: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
#   Linux: /usr/bin/google-chrome or /usr/bin/chromium
# PUPPETEER_EXECUTABLE_PATH=

HYPERFRAMES_NO_UPDATE_CHECK=1
# HF_MAX_CONCURRENT_RENDERS=1
# HF_RENDER_TIMEOUT_MS=7200000
# PUBLIC_BASE_URL=https://hf.example.com
`;

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

const launcherPath = path.join(out, 'hyperframes-mcp');
if (fs.existsSync(launcherPath) && !fs.readFileSync(launcherPath, 'utf8').includes(LAUNCHER_MARKER)) {
  console.error(`${launcherPath} exists and is not a hyperframes-mcp launcher; choose another --out`);
  process.exit(2);
}
if (out === REPO || REPO.startsWith(out + path.sep)) {
  console.error('--out must be a separate directory, not the source checkout or one of its parents');
  process.exit(2);
}

fs.mkdirSync(out, { recursive: true });
const staging = path.join(out, '.app-new');
const previous = path.join(out, '.app-old');
fs.rmSync(staging, { recursive: true, force: true });
fs.rmSync(previous, { recursive: true, force: true });
fs.mkdirSync(staging);
for (const entry of ['bin', 'src', 'package.json', 'package-lock.json', 'README.md', 'README.en.md']) {
  fs.cpSync(path.join(REPO, entry), path.join(staging, entry), { recursive: true });
}
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: staging });

const app = path.join(out, 'app');
if (fs.existsSync(app)) fs.renameSync(app, previous);
fs.renameSync(staging, app);
fs.rmSync(previous, { recursive: true, force: true });

fs.writeFileSync(launcherPath, LAUNCHER, { mode: 0o755 });
fs.chmodSync(launcherPath, 0o755);
fs.writeFileSync(path.join(out, 'hyperframes-mcp.env.example'), ENV_EXAMPLE);

const { version } = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
console.log(`\nhyperframes-mcp ${version} installed in ${out}`);
if (!fs.existsSync(path.join(out, 'hyperframes-mcp.env'))) {
  console.log('Optional: cp hyperframes-mcp.env.example hyperframes-mcp.env and edit it (port, browser, ...).');
}
console.log(`Start: ${launcherPath}   (restart the server if it is already running)`);
