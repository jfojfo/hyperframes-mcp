import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs, createReadStream, createWriteStream, existsSync, realpathSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as tar from 'tar';
import * as z from 'zod/v4';

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT || 9006);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.resolve(process.env.HF_WORKSPACE || fileURLToPath(new URL('../workspace/projects', import.meta.url)));
const MAX_OUTPUT = 4 * 1024 * 1024;
const COMMAND_TIMEOUT = Number(process.env.HF_COMMAND_TIMEOUT_MS || 15 * 60 * 1000);
const HYPERFRAMES_BIN = process.env.HYPERFRAMES_BIN || fileURLToPath(new URL('../node_modules/.bin/hyperframes', import.meta.url));
const DEFAULT_BROWSER = '/usr/local/bin/hyperframes-chromium';
const PACKAGE = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const projectSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/);
// Some MCP clients send numbers as strings when a parameter's schema is an anyOf of number and string,
// so the string branches also accept plain digits ("30", "4").
const fpsSchema = z.union([z.number().int().min(1).max(240), z.string().regex(/^\d+(\/[1-9]\d*)?$/, 'Use an integer or a fraction like 30000/1001').refine(value => { const [n, d = 1] = value.split('/').map(Number); return n / d >= 1 && n / d <= 240; }, 'Frame rate must be between 1 and 240')]);
const workersSchema = z.union([z.number().int().min(1).max(32), z.string().regex(/^(auto|[1-9]\d*)$/, 'Use an integer from 1 to 32, or "auto"').refine(value => value === 'auto' || Number(value) <= 32, 'workers must be at most 32')]);
const timesSchema = z.array(z.number().nonnegative()).min(1).max(100);
const CLI_COMMANDS = ['doctor', 'init', 'info', 'lint', 'validate', 'check', 'preview', 'render', 'compositions', 'catalog', 'add', 'transcribe', 'tts', 'upgrade', 'docs', 'snapshot', 'timeline', 'audio', 'normalize-audio', 'beats', 'inspect', 'keyframes', 'layout', 'measure', 'diff', 'compare', 'grade-compare', 'media-treatment', 'media-use', 'remove-background', 'capture', 'history'];

const MAX_UPLOAD_BYTES = Number(process.env.HF_MAX_UPLOAD_BYTES || 1024 ** 3);
const MAX_EXTRACT_BYTES = Number(process.env.HF_MAX_EXTRACT_BYTES || 2 * 1024 ** 3);
const MAX_ARCHIVE_ENTRIES = Number(process.env.HF_MAX_ARCHIVE_ENTRIES || 10000);
const MAX_LISTED_OUTPUTS = 200;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
// Project names must start with a letter or digit, so this directory can never be addressed as a project.
const STAGING = path.join(ROOT, '.staging');

await fs.mkdir(ROOT, { recursive: true });
await fs.rm(STAGING, { recursive: true, force: true });
await fs.mkdir(STAGING, { recursive: true });

function httpError(status, message) { return Object.assign(new Error(message), { status }); }
function isInside(base, target) { return target === base || target.startsWith(base + path.sep); }
// Resolve symlinks for the longest existing prefix; the missing tail is appended unchanged.
function realpathNearest(target) {
  const rest = [];
  for (let current = target; ;) {
    try { return path.join(realpathSync(current), ...rest); } catch (error) {
      const parent = path.dirname(current);
      if (!['ENOENT', 'ENOTDIR'].includes(error.code) || parent === current) throw error;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}
function projectPath(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(name)) throw httpError(400, 'Invalid project name. Use letters, numbers, dot, dash, or underscore only.');
  const resolved = path.resolve(ROOT, name);
  if (!isInside(ROOT, resolved) || !isInside(realpathNearest(ROOT), realpathNearest(resolved))) throw httpError(403, 'Project path escapes workspace.');
  return resolved;
}
function relativeSafe(projectDir, filePath) {
  const resolved = path.resolve(projectDir, filePath);
  if (!isInside(projectDir, resolved) || !isInside(realpathNearest(projectDir), realpathNearest(resolved))) {
    throw httpError(403, 'File path escapes the project directory.');
  }
  return resolved;
}
async function existingProject(name) {
  const cwd = projectPath(name);
  const stat = await fs.stat(cwd).catch(() => null);
  if (!stat?.isDirectory()) throw httpError(404, `Project "${name}" not found. Create it with hyperframes_init first.`);
  return cwd;
}
async function listFiles(dir, base = dir) {
  const files = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(full, base));
    else files.push(path.relative(base, full));
  }
  return files;
}
async function hashFile(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}
// File count and bytes under a path, without following symlinks.
async function diskUsage(target) {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory()) return { files: 1, bytes: stat.size };
  let files = 0, bytes = 0;
  for (const entry of await fs.readdir(target)) {
    const sub = await diskUsage(path.join(target, entry));
    files += sub.files; bytes += sub.bytes;
  }
  return { files, bytes };
}
// HyperFrames on Linux renders into work-<8 hex>-* next to the output (see its work_dir pattern); it normally
// removes the directory itself, so any left over belong to crashed or killed renders.
const RENDER_WORK_DIR = /^work-[0-9a-f]{8}-/;
async function intermediateTargets(cwd) {
  const targets = [];
  const artifacts = path.join(cwd, '.hyperframes', 'artifacts');
  if ((await fs.lstat(artifacts).catch(() => null))?.isDirectory()) targets.push(artifacts);
  const walk = async dir => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || ['node_modules', '.git', '.hyperframes'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (RENDER_WORK_DIR.test(entry.name)) targets.push(full); else await walk(full);
    }
  };
  await walk(cwd);
  return targets;
}
function toPosix(relative) { return relative.split(path.sep).join('/'); }
function artifactUrl(origin, project, relative) {
  return `${origin}/artifacts/${[project, ...toPosix(relative).split('/')].map(encodeURIComponent).join('/')}`;
}
async function describeFile(origin, project, cwd, file) {
  const stat = await fs.stat(file);
  const relative = toPosix(path.relative(cwd, file));
  return { path: relative, size: stat.size, sha256: await hashFile(file), url: artifactUrl(origin, project, relative) };
}
function forwardedOrigin(getHeader, fallbackProto, fallbackHost) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const first = value => value?.split(',')[0].trim() || undefined;
  const host = first(getHeader('x-forwarded-host')) || getHeader('host') || fallbackHost;
  return host ? `${first(getHeader('x-forwarded-proto')) || fallbackProto}://${host}` : '';
}
function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.json') return 'application/json';
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.m3u8') return 'application/vnd.apple.mpegurl';
  if (ext === '.ts') return 'video/mp2t';
  if (ext === '.m4s') return 'video/iso.segment';
  return 'application/octet-stream';
}
function hyperframesEnv() {
  const browserPath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.HYPERFRAMES_BROWSER_PATH || (existsSync(DEFAULT_BROWSER) ? DEFAULT_BROWSER : undefined);
  return {
    ...process.env,
    CI: '1',
    ...(browserPath ? { PUPPETEER_EXECUTABLE_PATH: browserPath, HYPERFRAMES_BROWSER_PATH: browserPath } : {}),
  };
}
async function runHyperframes(args, cwd = ROOT) {
  const { stdout, stderr } = await execFileAsync(HYPERFRAMES_BIN, args, {
    cwd,
    env: hyperframesEnv(),
    timeout: COMMAND_TIMEOUT,
    maxBuffer: MAX_OUTPUT,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

// Background render jobs. MCP clients time out long tool calls (often ~60s), so hyperframes_render
// submits a job and returns its id; hyperframes_render_status polls it. Jobs live in memory only.
const RENDER_TIMEOUT = Number(process.env.HF_RENDER_TIMEOUT_MS || 2 * 60 * 60 * 1000);
const MAX_CONCURRENT_RENDERS = Math.max(1, Math.floor(Number(process.env.HF_MAX_CONCURRENT_RENDERS || 1)));
const MAX_RETAINED_JOBS = 200;
const LOG_TAIL_LINES = 500;
const MAX_LOG_LINE = 2000;
const MAX_WAIT_SECONDS = 30;
const KILL_GRACE_MS = 10_000;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const jobs = new Map();
const renderQueue = [];
let runningRenders = 0;

const stripAnsi = text => text.replace(/\x1B\[[0-9;?]*[ -\/]*[@-~]/g, '');
// HyperFrames 0.9.43 renders --start/--end through its distributed chunk path (renderSpan -> renderChunk), which
// sizes workers automatically (about frames/30 per chunk, ignoring --workers), pins WebGL to software
// (SwiftShader, ignoring --browser-gpu) and restarts Chrome for every chunk the range touches.
const RANGE_RENDER_WARNING = 'start/end (--start/--end) renders use HyperFrames\' segmented path: it ignores workers (worker count is automatic, about frames/30 per chunk), always renders WebGL in software (SwiftShader) so browserGpu has no effect, and restarts Chrome for each chunk the range touches. Its speed is not representative of a full render; to measure GPU speed or use the requested workers, render the whole composition without start/end.';
function renderWarnings(args) {
  return args[0] === 'render' && args.some(arg => /^--(start|end)(=|$)/.test(arg)) ? [RANGE_RENDER_WARNING] : [];
}
function createRenderJob({ project, cwd, args, describe }) {
  const job = {
    id: `render-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`, project, cwd, args, describe,
    warnings: renderWarnings(args),
    status: 'queued', createdAt: Date.now(), startedAt: null, finishedAt: null,
    progress: null, progressLine: null, log: [], stdout: [], stdoutBytes: 0, stdoutTruncated: false,
    result: null, error: null, exitCode: null, signal: null, child: null, cancelRequested: false, timedOut: false, waiters: new Set(),
  };
  jobs.set(job.id, job);
  renderQueue.push(job);
  pruneJobs();
  pumpRenderQueue();
  return job;
}
function pruneJobs() {
  const finished = [...jobs.values()].filter(job => TERMINAL.has(job.status));
  for (const job of finished.slice(0, Math.max(0, jobs.size - MAX_RETAINED_JOBS))) jobs.delete(job.id);
}
function pumpRenderQueue() {
  while (runningRenders < MAX_CONCURRENT_RENDERS && renderQueue.length) startRenderJob(renderQueue.shift());
}
function appendLog(job, line) {
  job.log.push(line.length > MAX_LOG_LINE ? line.slice(0, MAX_LOG_LINE) + ' [truncated]' : line);
  if (job.log.length > LOG_TAIL_LINES) job.log.splice(0, job.log.length - LOG_TAIL_LINES);
}
// Machine progress ("@hf-progress {json}") and progress-bar lines update the status instead of the log.
function handleOutputLine(job, raw, isStdout) {
  const line = stripAnsi(raw).trimEnd();
  if (!line.trim()) return;
  if (line.startsWith('@hf-progress ')) {
    try { job.progress = JSON.parse(line.slice('@hf-progress '.length)); } catch { appendLog(job, line); }
    return;
  }
  if (/[\u2588\u2591]/.test(line) && /\d+%/.test(line)) { job.progressLine = line.replace(/[\u2588\u2591]+/g, '').trim(); return; }
  appendLog(job, line);
  if (!isStdout) return;
  job.stdoutBytes += line.length + 1;
  if (job.stdoutBytes > MAX_OUTPUT) job.stdoutTruncated = true;
  else job.stdout.push(line);
}
function lineReader(onLine) {
  let pending = '';
  return {
    push(chunk) {
      const parts = (pending + chunk).split(/\r\n|\n|\r/);
      pending = parts.pop();
      for (const part of parts) onLine(part);
      if (pending.length > 64 * 1024) { onLine(pending); pending = ''; }
    },
    flush() { if (pending) onLine(pending); pending = ''; },
  };
}
function killProcessGroup(child, signal) {
  // detached: true put the CLI in its own process group, so Chromium and FFmpeg children die with it.
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
}
function startRenderJob(job) {
  runningRenders++;
  job.status = 'running';
  job.startedAt = Date.now();
  let child;
  try {
    child = spawn(HYPERFRAMES_BIN, job.args, { cwd: job.cwd, env: hyperframesEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return finishRenderJob(job, { spawnError: error });
  }
  job.child = child;
  const out = lineReader(line => handleOutputLine(job, line, true));
  const err = lineReader(line => handleOutputLine(job, line, false));
  child.stdout.setEncoding('utf8').on('data', chunk => out.push(chunk));
  child.stderr.setEncoding('utf8').on('data', chunk => err.push(chunk));
  const timer = setTimeout(() => { job.timedOut = true; stopRenderJob(job); }, RENDER_TIMEOUT);
  timer.unref();
  // 'error' also fires when a kill fails; only a process that never started is finished here ('close' covers the rest).
  child.on('error', error => { if (child.pid === undefined) { clearTimeout(timer); finishRenderJob(job, { spawnError: error }); } });
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    out.flush(); err.flush();
    finishRenderJob(job, { code, signal });
  });
}
async function finishRenderJob(job, { code = null, signal = null, spawnError } = {}) {
  if (job.finishing) return;
  job.finishing = true;
  job.child = null;
  job.exitCode = code;
  job.signal = signal;
  if (job.cancelRequested) job.status = 'cancelled';
  else if (job.timedOut) {
    job.status = 'failed';
    job.error = `Render exceeded HF_RENDER_TIMEOUT_MS (${RENDER_TIMEOUT} ms) and was stopped.`;
  } else if (spawnError) {
    job.status = 'failed';
    job.error = `Could not start HyperFrames: ${spawnError.message}`;
  } else if (code === 0) {
    try { job.result = await job.describe(job.startedAt); } catch (error) { job.result = { describeError: errorText(error) }; }
    job.status = 'succeeded';
  } else {
    job.status = 'failed';
    job.error = `HyperFrames exited with ${signal ? `signal ${signal}` : `code ${code}`}. See logTail for details.`;
  }
  job.finishedAt = Date.now();
  runningRenders--;
  for (const wake of job.waiters) wake();
  job.waiters.clear();
  pruneJobs();
  pumpRenderQueue();
}
function stopRenderJob(job) {
  if (job.status === 'queued') {
    renderQueue.splice(renderQueue.indexOf(job), 1);
    job.cancelRequested = true;
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    for (const wake of job.waiters) wake();
    job.waiters.clear();
    return;
  }
  if (!job.child) return;
  const child = job.child;
  killProcessGroup(child, 'SIGTERM');
  setTimeout(() => { if (child.exitCode === null && child.signalCode === null) killProcessGroup(child, 'SIGKILL'); }, KILL_GRACE_MS).unref();
}
function waitForJob(job, seconds) {
  if (!seconds || TERMINAL.has(job.status)) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); job.waiters.delete(done); resolve(); };
    const timer = setTimeout(done, Math.min(seconds, MAX_WAIT_SECONDS) * 1000);
    job.waiters.add(done);
  });
}
function getJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Render job "${jobId}" not found. Jobs are kept in memory only: they are lost when the server restarts, and only the latest ${MAX_RETAINED_JOBS} finished jobs are retained.`);
  return job;
}
function iso(ms) { return ms ? new Date(ms).toISOString() : null; }
function jobView(job, { logLines = 20 } = {}) {
  const now = job.finishedAt || Date.now();
  const pct = typeof job.progress?.pct === 'number' ? job.progress.pct : null;
  const runningSeconds = job.startedAt ? (now - job.startedAt) / 1000 : 0;
  const view = {
    jobId: job.id, project: job.project, status: job.status,
    createdAt: iso(job.createdAt), startedAt: iso(job.startedAt), finishedAt: iso(job.finishedAt),
    elapsedSeconds: Math.round(runningSeconds * 10) / 10,
  };
  if (job.warnings.length) view.warnings = job.warnings;
  if (job.status === 'queued') view.queuePosition = renderQueue.indexOf(job) + 1;
  if (job.status === 'running') {
    view.progress = job.progress ?? (job.progressLine ? { text: job.progressLine } : null);
    if (pct > 0 && pct < 100) view.etaSeconds = Math.round(runningSeconds * (100 - pct) / pct);
  }
  if (TERMINAL.has(job.status)) {
    view.exitCode = job.exitCode;
    if (job.signal) view.signal = job.signal;
    if (job.error) view.error = job.error;
    if (job.status === 'succeeded') {
      view.output = job.stdout.join('\n') + (job.stdoutTruncated ? '\n[output truncated]' : '');
      Object.assign(view, job.result);
    }
  }
  view.args = job.args;
  const lines = job.status === 'failed' ? Math.max(logLines, 40) : logLines;
  if (lines > 0) view.logTail = job.log.slice(-lines);
  if (!TERMINAL.has(job.status)) view.next = `Call hyperframes_render_status with jobId "${job.id}" (waitSeconds up to ${MAX_WAIT_SECONDS}) until status is succeeded, failed or cancelled.`;
  return view;
}
function shutdownRenders() {
  for (const job of jobs.values()) if (job.child) killProcessGroup(job.child, 'SIGKILL');
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { shutdownRenders(); process.exit(0); });
process.once('exit', shutdownRenders);
function textResult(text) { return { content: [{ type: 'text', text: String(text) }] }; }
function jsonResult(value) { return textResult(JSON.stringify(value, null, 2)); }
function errorText(error) { const message = error?.stderr || error?.stdout || error?.message || String(error); return message.length > MAX_OUTPUT ? message.slice(0, MAX_OUTPUT) + '\n[output truncated]' : message; }
function errorResult(error) { return { ...textResult(errorText(error)), isError: true }; }
function appendOptions(args, values, mapping) {
  for (const [key, flag] of Object.entries(mapping)) {
    const value = values[key];
    if (value === undefined) continue;
    if (typeof value === 'boolean') args.push(value ? `--${flag}` : `--no-${flag}`);
    else args.push(`--${flag}`, String(value));
  }
  return args;
}
function registerCliTool(server, name, description, schema, buildArgs, describeResult) {
  server.registerTool(name, { description, inputSchema: schema }, async input => {
    try {
      const cwd = input.project ? projectPath(input.project) : ROOT;
      const startedAt = Date.now();
      const args = buildArgs(input, cwd);
      const prefix = renderWarnings(args).map(warning => `WARNING: ${warning}\n\n`).join('');
      let result;
      try { result = await runHyperframes(args, cwd); } catch (error) {
        return prefix ? { ...textResult(prefix + errorText(error)), isError: true } : errorResult(error);
      }
      const text = prefix + (result.stdout || result.stderr || 'Command completed.');
      if (!describeResult) return textResult(text);
      let extra;
      try { extra = await describeResult(input, cwd, startedAt); } catch (error) { extra = { describeError: errorText(error) }; }
      // Separate content item, so CLI --json output stays parseable on its own.
      return { content: [{ type: 'text', text }, { type: 'text', text: JSON.stringify(extra, null, 2) }] };
    } catch (error) { return errorResult(error); }
  });
}
// Files written by this render: the explicit output (file or directory), else new files under renders/.
async function describeRenderOutputs(origin, project, cwd, output, startedAt) {
  const target = relativeSafe(cwd, output || 'renders');
  const stat = await fs.stat(target).catch(() => null);
  if (!stat) return { artifacts: [] };
  const candidates = stat.isFile() ? [target] : (await listFiles(target)).map(file => path.join(target, file));
  const recent = [];
  for (const file of candidates.sort()) {
    const fileStat = await fs.stat(file).catch(() => null);
    // 2s tolerance for coarse filesystem timestamps.
    if (fileStat?.isFile() && (output || fileStat.mtimeMs >= startedAt - 2000)) recent.push(file);
  }
  const artifacts = [];
  for (const file of recent.slice(0, MAX_LISTED_OUTPUTS)) artifacts.push(await describeFile(origin, project, cwd, file));
  return { artifacts, ...(recent.length > MAX_LISTED_OUTPUTS ? { truncated: recent.length - MAX_LISTED_OUTPUTS } : {}) };
}

function registerTools(server, origin = PUBLIC_BASE_URL) {
  server.registerTool('hyperframes_doctor', { title: 'HyperFrames Doctor', description: 'Check the HyperFrames, Node, FFmpeg and Chromium environment.', inputSchema: z.object({}) }, async () => { try { return textResult((await runHyperframes(['doctor'])).stdout); } catch (e) { return errorResult(e); } });
  registerCliTool(server, 'hyperframes_version', 'Report the actual CLI version running on the MCP host.', z.object({}), () => ['--version']);
  registerCliTool(server, 'hyperframes_check', 'Check lint, runtime, layout, motion and contrast in one browser session. Preferred over validate/inspect.', z.object({
    project: projectSchema, json: z.boolean().optional(), samples: z.number().int().min(1).max(100).optional(),
    at: timesSchema.optional(), range: z.tuple([z.number().nonnegative(), z.number().positive()]).optional(),
    components: z.string().optional(), atTransitions: z.boolean().optional(), strict: z.boolean().optional(),
    contrast: z.boolean().optional(), craft: z.boolean().optional(), cache: z.boolean().optional(), snapshots: z.boolean().optional(),
    timeout: z.number().int().positive().optional(), budget: z.string().optional(),
  }), input => {
    const args = appendOptions(['check'], input, { json: 'json', samples: 'samples', components: 'components', atTransitions: 'at-transitions',
      strict: 'strict', contrast: 'contrast', craft: 'craft', cache: 'cache', snapshots: 'snapshots', timeout: 'timeout', budget: 'budget' });
    if (input.at) args.push('--at', input.at.join(','));
    if (input.range) args.push('--range', input.range.join(','));
    return args;
  });
  registerCliTool(server, 'hyperframes_snapshot', 'Save PNG key frames and optional scene/cut review sheets on the MCP host. No AI vision service is called.', z.object({
    project: projectSchema, output: z.string().min(1).optional(), frames: z.number().int().min(1).max(100).optional(),
    at: timesSchema.optional(), range: z.tuple([z.number().nonnegative(), z.number().positive()]).optional(),
    composition: z.string().optional(), review: z.boolean().optional(), end: z.boolean().optional(), keep: z.boolean().optional(),
    zoom: z.string().optional(), zoomScale: z.number().positive().optional(), angle: z.string().optional(),
    against: z.string().min(1).optional(), json: z.boolean().optional(), timeout: z.number().int().min(1).max(170000).optional(),
  }), (input, cwd) => {
    if (input.output) {
      const output = relativeSafe(cwd, input.output);
      // snapshot clears an explicit output directory unless --keep is used.
      const relative = path.relative(cwd, output);
      if (!relative || ['index.html', 'assets', 'compositions', 'node_modules', '.git', '.hyperframes'].includes(relative.split(path.sep)[0])) {
        throw new Error('Use a dedicated snapshot output directory, e.g. snapshots/review.');
      }
    }
    if (input.against) relativeSafe(cwd, input.against);
    const args = appendOptions(['snapshot'], input, { output: 'output', frames: 'frames', composition: 'composition', review: 'review',
      end: 'end', keep: 'keep', zoom: 'zoom', zoomScale: 'zoom-scale', angle: 'angle', against: 'against', json: 'json', timeout: 'timeout' });
    if (input.at) args.push('--at', input.at.join(','));
    if (input.range) args.push('--range', input.range.join(','));
    return args;
  });
  registerCliTool(server, 'hyperframes_timeline', 'Read project tracks, clips and timing. Use the advanced CLI for timeline edits.', z.object({
    project: projectSchema, json: z.boolean().optional(),
  }), input => appendOptions(['timeline'], input, { json: 'json' }));
  registerCliTool(server, 'hyperframes_audio', 'Analyze audio timing, loudness and silence locally on the MCP host (fast signal analysis, no hosted providers).', z.object({
    project: projectSchema, input: z.string().min(1).optional(), target: z.string().optional(), at: z.number().nonnegative().optional(),
    range: z.tuple([z.number().nonnegative(), z.number().positive()]).optional(), capabilities: z.string().optional(), json: z.boolean().optional(),
  }), (input, cwd) => {
    if (input.input) relativeSafe(cwd, input.input);
    const args = appendOptions(['audio', ...(input.input ? [input.input] : []), '--quality', 'fast'], input,
      { target: 'element', at: 'at', capabilities: 'only', json: 'json' });
    if (input.range) args.push('--range', input.range.join(','));
    return args;
  });
  server.registerTool('hyperframes_init', {
    title: 'Create HyperFrames Project', description: 'Create a project on the MCP host. fps is written to data-fps after scaffolding; no skills are installed.',
    inputSchema: z.object({ name: projectSchema, example: z.string().optional(), resolution: z.string().optional(), fps: z.number().int().min(1).max(240).optional() }),
  }, async ({ name, example, resolution, fps }) => {
    try {
      projectPath(name);
      const args = ['init', name, '--non-interactive', '--skip-skills'];
      if (example) args.push('--example', example);
      if (resolution) args.push('--resolution', resolution);
      const result = await runHyperframes(args);
      if (fps !== undefined) {
        const entry = path.join(projectPath(name), 'index.html');
        const html = await fs.readFile(entry, 'utf8');
        const root = /<[^!][^>]*\bdata-composition-id\s*=\s*["'][^"']+["'][^>]*>/i;
        if (!root.test(html)) throw new Error('Project created, but no composition root was found to set fps.');
        await fs.writeFile(entry, html.replace(root, tag => /\bdata-fps\s*=/.test(tag)
          ? tag.replace(/\bdata-fps\s*=\s*["'][^"']*["']/, `data-fps="${fps}"`)
          : tag.replace(/>$/, ` data-fps="${fps}">`)), 'utf8');
      }
      return textResult(result.stdout || result.stderr || `Created ${name}`);
    } catch (error) { return errorResult(error); }
  });
  server.registerTool('hyperframes_info', { title: 'Project Info', description: 'Inspect a HyperFrames project.', inputSchema: z.object({ project: z.string().min(1) }) }, async ({ project }) => { try { const r = await runHyperframes(['info', '--json'], projectPath(project)); try { return jsonResult(JSON.parse(r.stdout)); } catch { return textResult(r.stdout || r.stderr); } } catch (e) { return errorResult(e); } });
  server.registerTool('hyperframes_lint', { title: 'Lint Project', description: 'Run HyperFrames linting.', inputSchema: z.object({ project: z.string().min(1), json: z.boolean().optional() }) }, async ({ project, json }) => { try { const args = ['lint']; if (json) args.push('--json'); const r = await runHyperframes(args, projectPath(project)); return textResult(r.stdout || r.stderr || 'Lint passed.'); } catch (e) { return errorResult(e); } });
  server.registerTool('hyperframes_validate', { title: 'Validate Project', description: 'Run HyperFrames validation.', inputSchema: z.object({ project: z.string().min(1) }) }, async ({ project }) => { try { return textResult((await runHyperframes(['validate'], projectPath(project))).stdout); } catch (e) { return errorResult(e); } });
  server.registerTool('hyperframes_compositions', { title: 'List Compositions', description: 'List composition IDs and durations.', inputSchema: z.object({ project: z.string().min(1) }) }, async ({ project }) => { try { return textResult((await runHyperframes(['compositions'], projectPath(project))).stdout); } catch (e) { return errorResult(e); } });
  const renderSchema = z.object({
    project: projectSchema,
    quality: z.enum(['draft', 'standard', 'high', 'looks', 'delivery']).optional(),
    output: z.string().min(1).optional(), composition: z.string().min(1).optional(),
    fps: fpsSchema.optional(), format: z.enum(['mp4', 'mov', 'webm', 'gif', 'png-sequence', 'hls']).optional(),
    workers: workersSchema.optional(),
    crf: z.number().int().min(0).max(51).optional(), videoBitrate: z.string().optional(),
    gpu: z.boolean().optional(), docker: z.boolean().optional(), browserGpu: z.boolean().optional(),
    resolution: z.string().optional(), start: z.number().nonnegative().optional(), end: z.number().positive().optional(),
    variables: z.record(z.string(), z.unknown()).optional(), strictVariables: z.boolean().optional(),
    batch: z.string().min(1).optional(), batchConcurrency: z.number().int().min(1).max(10).optional(),
    batchFailFast: z.boolean().optional(), json: z.boolean().optional(),
    lowMemoryMode: z.boolean().optional(), debug: z.boolean().optional(),
    strict: z.boolean().optional(), strictAll: z.boolean().optional(), bestEffort: z.boolean().optional(),
    hdr: z.boolean().optional(), sdr: z.boolean().optional(),
    motionBlur: z.enum(['off']).optional(), videoFrameFormat: z.enum(['auto', 'jpg', 'png']).optional(),
    gifLoop: z.number().int().min(0).max(65535).optional(), hlsSegmentSeconds: z.number().int().min(1).max(60).optional(),
    proresProfile: z.enum(['proxy', 'lt', '422', 'hq', '4444']).optional(),
    keyframeInterval: z.number().positive().optional(), maxBitrate: z.string().optional(), bufferSize: z.string().optional(),
    framesCacheDir: z.string().min(1).optional(),
    waitSeconds: z.union([z.number().int().min(0).max(MAX_WAIT_SECONDS), z.string().regex(/^\d+$/).refine(v => Number(v) <= MAX_WAIT_SECONDS, `waitSeconds must be at most ${MAX_WAIT_SECONDS}`)]).optional(),
  }).refine(v => v.crf === undefined || v.videoBitrate === undefined, 'crf and videoBitrate are mutually exclusive')
    .refine(v => v.start === undefined || v.end === undefined || v.start < v.end, 'start must be before end')
    .refine(v => !(v.hdr && v.sdr), 'hdr and sdr are mutually exclusive');
  const buildRenderArgs = (input, cwd) => {
    for (const key of ['output', 'composition', 'batch']) if (input[key]) relativeSafe(cwd, input[key]);
    if (input.framesCacheDir && !['off', 'none', 'false', '0'].includes(input.framesCacheDir)) relativeSafe(cwd, input.framesCacheDir);
    const args = appendOptions(['render'], input, {
      quality: 'quality', output: 'output', composition: 'composition', fps: 'fps', format: 'format', workers: 'workers',
      crf: 'crf', videoBitrate: 'video-bitrate', gpu: 'gpu', docker: 'docker', browserGpu: 'browser-gpu',
      resolution: 'resolution', start: 'start', end: 'end', strictVariables: 'strict-variables', batch: 'batch',
      batchConcurrency: 'batch-concurrency', batchFailFast: 'batch-fail-fast', json: 'json',
      lowMemoryMode: 'low-memory-mode', debug: 'debug', strict: 'strict', strictAll: 'strict-all', bestEffort: 'best-effort',
      hdr: 'hdr', sdr: 'sdr', motionBlur: 'page-motion-blur', videoFrameFormat: 'video-frame-format',
      gifLoop: 'gif-loop', hlsSegmentSeconds: 'hls-segment-seconds', framesCacheDir: 'frames-cache-dir',
      proresProfile: 'prores-profile', keyframeInterval: 'keyframe-interval', maxBitrate: 'max-bitrate', bufferSize: 'buffer-size',
    });
    if (input.variables) args.push('--variables', JSON.stringify(input.variables));
    return args;
  };
  server.registerTool('hyperframes_render', {
    title: 'Submit Render Job',
    description: `Start a render on the MCP host (local Chromium and FFmpeg; not the official cloud) and return a jobId immediately. Poll hyperframes_render_status until status is succeeded, failed or cancelled; the succeeded status lists each output with url, size and sha256. Output paths are relative to the project. Renders run one at a time by default (HF_MAX_CONCURRENT_RENDERS); later jobs queue. waitSeconds (0-${MAX_WAIT_SECONDS}, default 0) waits that long before returning, so short renders can finish in one call; keep it below the client tool-call timeout. Note: start/end switch HyperFrames to a segmented path that ignores workers and browserGpu (automatic workers, software WebGL); the job view then carries a warning.`,
    inputSchema: renderSchema,
  }, async input => {
    try {
      const cwd = await existingProject(input.project);
      const args = buildRenderArgs(input, cwd);
      const job = createRenderJob({ project: input.project, cwd, args, describe: startedAt => describeRenderOutputs(origin, input.project, cwd, input.output, startedAt) });
      await waitForJob(job, Number(input.waitSeconds || 0));
      return { ...jsonResult(jobView(job)), ...(job.status === 'failed' ? { isError: true } : {}) };
    } catch (error) { return errorResult(error); }
  });
  const jobIdSchema = z.string().min(1).max(100);
  const logLinesSchema = z.union([z.number().int().min(0).max(LOG_TAIL_LINES), z.string().regex(/^\d+$/).refine(v => Number(v) <= LOG_TAIL_LINES, `logLines must be at most ${LOG_TAIL_LINES}`)]);
  server.registerTool('hyperframes_render_status', {
    title: 'Render Job Status',
    description: `Status of a render job from hyperframes_render: queued, running (with progress and etaSeconds when known), succeeded (with output and artifacts: url, size, sha256), failed (with error and logTail) or cancelled. waitSeconds (0-${MAX_WAIT_SECONDS}, default 0) blocks until the job finishes or the time runs out; keep it below the client tool-call timeout. logLines (default 20, max ${LOG_TAIL_LINES}) sets how many recent log lines to include.`,
    inputSchema: z.object({ jobId: jobIdSchema, waitSeconds: renderSchema.shape.waitSeconds, logLines: logLinesSchema.optional() }),
  }, async ({ jobId, waitSeconds, logLines }) => {
    try {
      const job = getJob(jobId);
      await waitForJob(job, Number(waitSeconds || 0));
      return jsonResult(jobView(job, { logLines: logLines === undefined ? 20 : Number(logLines) }));
    } catch (error) { return errorResult(error); }
  });
  server.registerTool('hyperframes_render_cancel', {
    title: 'Cancel Render Job',
    description: 'Cancel a queued or running render job. Running renders are stopped with SIGTERM, then SIGKILL after 10 seconds. Partial output may remain in the project.',
    inputSchema: z.object({ jobId: jobIdSchema }),
  }, async ({ jobId }) => {
    try {
      const job = getJob(jobId);
      if (TERMINAL.has(job.status)) return jsonResult({ ...jobView(job, { logLines: 0 }), note: `Job already ${job.status}.` });
      job.cancelRequested = true;
      stopRenderJob(job);
      await waitForJob(job, 15);
      return jsonResult(jobView(job, { logLines: 0 }));
    } catch (error) { return errorResult(error); }
  });
  server.registerTool('hyperframes_render_list', {
    title: 'List Render Jobs',
    description: 'List render jobs kept in memory (newest first), optionally for one project. Jobs are lost when the server restarts.',
    inputSchema: z.object({ project: projectSchema.optional() }),
  }, async ({ project }) => {
    const list = [...jobs.values()].filter(job => !project || job.project === project).reverse().map(job => {
      const { jobId, status, createdAt, startedAt, finishedAt, elapsedSeconds, queuePosition, progress, etaSeconds, error } = jobView(job, { logLines: 0 });
      return { jobId, project: job.project, status, createdAt, startedAt, finishedAt, elapsedSeconds, queuePosition, progress, etaSeconds, error };
    });
    return jsonResult({ maxConcurrentRenders: MAX_CONCURRENT_RENDERS, running: runningRenders, queued: renderQueue.length, jobs: list });
  });
  server.registerTool('project_cleanup', {
    title: 'Clean Up Project',
    description: 'Free disk space on the MCP host once a project is finished. Download every output you need first: deleted files cannot be recovered. scope "project" (default) deletes the whole project directory, including sources, uploads and renders, and forgets its finished render jobs. scope "intermediate" keeps sources and renders and deletes only regenerable files: snapshots and check reports under .hyperframes/artifacts, and render work directories (work-<id>-*) left behind by crashed renders. Refuses while the project has queued or running render jobs unless cancelRenders is true. dryRun lists what would be deleted without deleting it.',
    inputSchema: z.object({
      project: projectSchema, scope: z.enum(['project', 'intermediate']).optional(),
      dryRun: z.boolean().optional(), cancelRenders: z.boolean().optional(),
    }),
  }, async ({ project, scope = 'project', dryRun = false, cancelRenders = false }) => {
    try {
      const cwd = await existingProject(project);
      const active = [...jobs.values()].filter(job => job.project === project && !TERMINAL.has(job.status));
      if (active.length && !cancelRenders) {
        throw new Error(`Project "${project}" has active render jobs: ${active.map(job => `${job.id} (${job.status})`).join(', ')}. Wait for them, cancel them with hyperframes_render_cancel, or pass cancelRenders: true.`);
      }
      const targets = scope === 'project' ? [cwd] : await intermediateTargets(cwd);
      const removed = [];
      for (const target of targets) removed.push({ path: toPosix(path.relative(cwd, target)) || '.', ...await diskUsage(target) });
      const total = removed.reduce((sum, item) => ({ files: sum.files + item.files, bytes: sum.bytes + item.bytes }), { files: 0, bytes: 0 });
      const summary = { project, scope, dryRun, removed, totalFiles: total.files, totalBytes: total.bytes };
      if (dryRun) return jsonResult({ ...summary, ...(active.length ? { activeRenderJobs: active.map(job => job.id) } : {}) });

      if (active.length) {
        for (const job of active) { job.cancelRequested = true; stopRenderJob(job); }
        await Promise.all(active.map(job => waitForJob(job, KILL_GRACE_MS / 1000 + 5)));
        const stuck = active.filter(job => !TERMINAL.has(job.status));
        if (stuck.length) throw new Error(`Render jobs did not stop in time: ${stuck.map(job => job.id).join(', ')}. Nothing was deleted; try again shortly.`);
        summary.cancelledRenderJobs = active.map(job => job.id);
      }
      if (scope === 'project') {
        // Rename first so the project disappears atomically (new tool calls and uploads get 404), then delete.
        const trash = path.join(STAGING, `deleted-${project}-${randomBytes(6).toString('hex')}`);
        await fs.rename(cwd, trash);
        await fs.rm(trash, { recursive: true, force: true });
        let forgotten = 0;
        for (const job of [...jobs.values()]) if (job.project === project && TERMINAL.has(job.status)) { jobs.delete(job.id); forgotten++; }
        summary.forgottenRenderJobs = forgotten;
      } else {
        for (const target of targets) await fs.rm(target, { recursive: true, force: true });
      }
      return jsonResult(summary);
    } catch (error) { return errorResult(error); }
  });
  registerCliTool(server, 'hyperframes_transcribe', 'Transcribe on the MCP host or import SRT/VTT/JSON. Local engines only; may download speech models.', z.object({
    project: projectSchema, input: z.string().min(1), model: z.string().optional(),
    engine: z.enum(['auto', 'whisper', 'parakeet']).optional(), language: z.string().optional(), json: z.boolean().optional(),
  }), (input, cwd) => {
    relativeSafe(cwd, input.input);
    return appendOptions(['transcribe', input.input], input, { model: 'model', engine: 'engine', language: 'language', json: 'json' });
  });
  registerCliTool(server, 'hyperframes_tts', 'Generate voiceover with the local Kokoro model on the MCP host; first use may download the model.', z.object({
    project: projectSchema, text: z.string().min(1).max(20000), voice: z.string().optional(), output: z.string().min(1),
    speed: z.number().positive().optional(), language: z.string().optional(), json: z.boolean().optional(),
  }), (input, cwd) => {
    relativeSafe(cwd, input.output);
    return appendOptions(['tts', input.text], input, { output: 'output', voice: 'voice', speed: 'speed', language: 'lang', json: 'json' });
  });
  registerCliTool(server, 'hyperframes_catalog', 'Search the HyperFrames registry (requires internet access from the MCP host).', z.object({
    project: projectSchema, type: z.enum(['block', 'component']).optional(), query: z.string().optional(), tag: z.string().optional(), json: z.boolean().optional(),
  }), input => appendOptions(['catalog'], input, { type: 'type', query: 'query', tag: 'tag', json: 'json' }));
  server.registerTool('hyperframes_add', { title: 'Install Catalog Item', description: 'Install a HyperFrames catalog item.', inputSchema: z.object({ project: z.string().min(1), name: z.string().min(1).max(200) }) }, async ({ project, name }) => { try { return textResult((await runHyperframes(['add', name], projectPath(project))).stdout); } catch (e) { return errorResult(e); } });
  server.registerTool('hyperframes_docs', { title: 'HyperFrames Docs', description: 'Return HyperFrames CLI documentation.', inputSchema: z.object({ topic: z.string().min(1).max(100) }) }, async ({ topic }) => { try { return textResult((await runHyperframes(['docs', topic])).stdout); } catch (e) { return errorResult(e); } });
  server.registerTool('project_list_files', { title: 'List Project Files', description: 'List project files, including rendered outputs and snapshots.', inputSchema: z.object({ project: z.string().min(1), subdir: z.string().optional() }) }, async ({ project, subdir }) => {
    try {
      const cwd = projectPath(project), start = subdir ? relativeSafe(cwd, subdir) : cwd;
      return jsonResult((await listFiles(start)).map(file => path.relative(cwd, path.join(start, file))).sort());
    } catch (e) { return errorResult(e); }
  });
  server.registerTool('project_read_file', { title: 'Read Project File', description: 'Read a UTF-8 text file. Binary files are refused; download them over HTTP from the returned URL.', inputSchema: z.object({ project: z.string().min(1), file: z.string().min(1) }) }, async ({ project, file }) => {
    try {
      const cwd = projectPath(project), target = relativeSafe(cwd, file), data = await fs.readFile(target);
      if (data.includes(0)) throw new Error(`Binary file (${data.length} bytes). Download it from ${artifactUrl(origin, project, path.relative(cwd, target))}`);
      return textResult(data.toString('utf8'));
    } catch (e) { return errorResult(e); }
  });
  server.registerTool('project_write_file', { title: 'Write Project File', description: 'Create or replace a UTF-8 text file. For binary assets (images, audio, video, fonts) the client uploads over HTTP instead: PUT /files/<project>/<path> with the raw bytes, or POST /archives/<project>[/<dir>] with a tar/tar.gz.', inputSchema: z.object({ project: z.string().min(1), file: z.string().min(1), content: z.string().max(2_000_000) }) }, async ({ project, file, content }) => { try { const cwd = projectPath(project), target = relativeSafe(cwd, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content, 'utf8'); return textResult(`Wrote ${path.relative(cwd, target)} (${content.length} characters).`); } catch (e) { return errorResult(e); } });
  registerCliTool(server, 'hyperframes_cli', 'Advanced allowlisted CLI on the MCP host, with unrestricted CLI arguments (trusted LAN clients only). Official cloud, publishing and account commands are excluded.', z.object({
    command: z.enum(CLI_COMMANDS), project: projectSchema.optional(), args: z.array(z.string()).max(60).optional(),
  }), ({ command, args = [] }) => [command, ...args]);
}

function buildServer(ctx = {}) {
  const request = ctx.requestInfo;
  let origin = PUBLIC_BASE_URL;
  if (!origin && request) {
    const url = new URL(request.url);
    origin = forwardedOrigin(name => request.headers.get(name) ?? undefined, url.protocol.slice(0, -1), url.host);
  }
  const server = new McpServer({ name: 'hyperframes-mcp-server', version: PACKAGE.version }, { capabilities: { tools: {} }, instructions: 'Use HyperFrames tools to create, edit, validate and render HTML-native video projects. Binary bytes never go through MCP: clients upload assets with HTTP PUT /files/<project>/<path> (raw body) or POST /archives/<project>[/<dir>] (tar/tar.gz), and download outputs from GET /artifacts/<project>/<file> (Range supported). Create the project with hyperframes_init before uploading to it; uploads to a missing project fail with 404. Archives may contain only regular files and directories: an archive with any symlink or hard link is rejected as a whole, so dereference links when packing (tar -h / --dereference). Rendering is asynchronous: hyperframes_render returns a jobId at once; poll hyperframes_render_status (waitSeconds up to 30) until succeeded, which lists each output URL with size and sha256. hyperframes_render_cancel stops a job. When a project is finished and its outputs are downloaded, call project_cleanup to delete it (or scope "intermediate" to drop only snapshots and render leftovers).' });
  registerTools(server, origin); return server;
}
const handler = createMcpHandler(buildServer);
const nodeHandler = toNodeHandler(handler);

function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string';
  const payload = json ? JSON.stringify(body, null, 2) + '\n' : body;
  res.writeHead(status, { 'content-type': json ? 'application/json' : 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(payload), ...headers });
  res.end(payload);
}
function requestOrigin(req) {
  return forwardedOrigin(name => req.headers[name], req.socket.encrypted ? 'https' : 'http', 'localhost');
}
// Percent-decode each URL segment; a decoded segment may not smuggle in separators or dot segments.
function pathSegments(pathname, prefix) {
  return pathname.slice(prefix.length).split('/').filter(Boolean).map(segment => {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { throw httpError(400, 'Malformed percent-encoding in path.'); }
    if (decoded === '.' || decoded === '..' || /[\\/\0]/.test(decoded)) throw httpError(400, 'Invalid path segment.');
    return decoded;
  });
}
function contentDisposition(name) {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
// Single byte range only. null = ignore the header (serve 200), false = unsatisfiable (416).
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (suffix === 0) return false;
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]);
    if (match[2] && Number(match[2]) < start) return null;
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  return start >= size ? false : [start, end];
}

// Stream the request body to a new file, hashing as it goes. On overflow the rest of the body is drained
// (not written), so the client still receives the 413 instead of a reset connection.
function receiveToFile(req, file, limit) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(file, { flags: 'wx' });
    const hash = createHash('sha256');
    let size = 0, failed = false;
    const fail = error => {
      if (failed) return;
      failed = true;
      req.removeListener('data', onData);
      req.resume();
      out.destroy();
      reject(error);
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > limit) return fail(httpError(413, `Upload exceeds the ${limit}-byte limit (HF_MAX_UPLOAD_BYTES).`));
      hash.update(chunk);
      if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
    };
    req.on('data', onData);
    req.once('end', () => { if (!failed) out.end(); });
    req.once('aborted', () => fail(httpError(400, 'Upload aborted by client.')));
    req.once('error', fail);
    out.once('error', fail);
    out.once('finish', () => { if (!failed) resolve({ size, sha256: hash.digest('hex') }); });
  });
}
async function receiveUpload(req, file) {
  if (Number(req.headers['content-length']) > MAX_UPLOAD_BYTES) {
    throw httpError(413, `Upload exceeds the ${MAX_UPLOAD_BYTES}-byte limit (HF_MAX_UPLOAD_BYTES).`);
  }
  const received = await receiveToFile(req, file, MAX_UPLOAD_BYTES);
  const expected = req.headers['x-content-sha256'];
  if (expected && expected.trim().toLowerCase() !== received.sha256) {
    throw httpError(422, `sha256 mismatch: header ${expected.trim()}, received ${received.sha256}.`);
  }
  return received;
}
async function moveInto(source, target) {
  try { await fs.rename(source, target); } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fs.copyFile(source, target);
    await fs.rm(source, { force: true });
  }
}
async function assertWritableTarget(target, relative, noOverwrite) {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing?.isDirectory()) throw httpError(409, `${relative} is an existing directory.`);
  if (existing && noOverwrite) throw httpError(412, `${relative} already exists (If-None-Match: *).`);
  return Boolean(existing);
}

// PUT /files/<project>/<path>: raw body, written to a temp file next to the target and renamed into place.
async function handleFileUpload(req, res, url) {
  const [project, ...rest] = pathSegments(url.pathname, '/files/');
  if (!project || !rest.length) throw httpError(400, 'Usage: PUT /files/<project>/<path> with the raw file bytes as the body.');
  const cwd = await existingProject(project);
  const relative = rest.join('/');
  const target = relativeSafe(cwd, relative);
  const replaced = await assertWritableTarget(target, relative, req.headers['if-none-match'] === '*');
  await fs.mkdir(path.dirname(target), { recursive: true });
  relativeSafe(cwd, relative);
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString('hex')}.upload`);
  try {
    const { size, sha256 } = await receiveUpload(req, temp);
    await fs.rename(temp, target);
    send(res, replaced ? 200 : 201, { project, path: relative, size, sha256, replaced, url: artifactUrl(requestOrigin(req), project, relative) });
  } finally {
    await fs.rm(temp, { force: true });
  }
}

const ARCHIVE_FILE_TYPES = new Set(['File', 'OldFile', 'ContiguousFile']);
function archiveError(error) {
  return error.status ? error : httpError(400, `Not a valid tar/tar.gz archive: ${error.message}`);
}
// Read the archive headers with node-tar (same behaviour on Linux and macOS, no system tar needed) and
// reject the whole archive unless every entry is a regular file or directory with a safe relative path.
async function vetArchive(archive) {
  let entries = 0, total = 0, files = 0, problem;
  try {
    await tar.t({
      file: archive, strict: true,
      onReadEntry(entry) {
        if (problem) return;
        entries++;
        const name = entry.path;
        if (/^([\\/]|[A-Za-z]:)/.test(name) || name.split(/[\\/]/).includes('..')) problem = httpError(400, `Unsafe archive path: ${name}`);
        else if (ARCHIVE_FILE_TYPES.has(entry.type)) { files++; total += entry.size; }
        else if (entry.type !== 'Directory') problem = httpError(400, `Archive entry ${name} is a ${entry.type}; only regular files and directories are accepted.`);
        if (!problem && entries > MAX_ARCHIVE_ENTRIES) problem = httpError(413, `Archive has more than ${MAX_ARCHIVE_ENTRIES} entries (HF_MAX_ARCHIVE_ENTRIES).`);
        if (!problem && total > MAX_EXTRACT_BYTES) problem = httpError(413, `Archive expands to more than ${MAX_EXTRACT_BYTES} bytes (HF_MAX_EXTRACT_BYTES).`);
      },
    });
  } catch (error) { throw archiveError(error); }
  if (problem) throw problem;
  if (!files) throw httpError(400, 'Archive contains no files.');
}
// Walk extracted files with lstat: only plain directories and single-link regular files are accepted.
async function collectExtracted(dir, base = dir, out = { files: [], dirs: [] }) {
  for (const entry of await fs.readdir(dir)) {
    const full = path.join(dir, entry), stat = await fs.lstat(full);
    if (stat.isDirectory()) { out.dirs.push(path.relative(base, full)); await collectExtracted(full, base, out); }
    else if (stat.isFile() && stat.nlink === 1) out.files.push(path.relative(base, full));
    else throw httpError(400, `Archive entry ${path.relative(base, full)} is not a regular file or directory.`);
  }
  return out;
}

// POST /archives/<project>[/<dir>]: tar or gzip-compressed tar body, extracted into the project (or a subdirectory).
async function handleArchiveUpload(req, res, url) {
  const [project, ...rest] = pathSegments(url.pathname, '/archives/');
  if (!project) throw httpError(400, 'Usage: POST /archives/<project>[/<dir>] with a tar or tar.gz body.');
  const cwd = await existingProject(project);
  const destination = rest.join('/');
  relativeSafe(cwd, destination || '.');
  const noOverwrite = req.headers['if-none-match'] === '*';
  const work = await fs.mkdtemp(path.join(STAGING, 'archive-'));
  try {
    const archive = path.join(work, 'upload.tar'), extracted = path.join(work, 'files');
    await fs.mkdir(extracted);
    const received = await receiveUpload(req, archive);

    // Vet every header before anything is written to disk.
    await vetArchive(archive);
    try {
      // The filter repeats the type check as defence in depth; node-tar itself also refuses absolute and .. paths.
      await tar.x({
        file: archive, cwd: extracted, strict: true, preserveOwner: false, noChmod: true,
        filter: (_path, entry) => entry.type === 'Directory' || ARCHIVE_FILE_TYPES.has(entry.type),
      });
    } catch (error) { throw archiveError(error); }
    // Post-extraction lstat walk: anything that is not a plain file or directory still rejects the archive.
    const { files, dirs } = await collectExtracted(extracted);

    const plan = files.sort().map(file => {
      const relative = toPosix(path.join(destination, file));
      return { source: path.join(extracted, file), relative, target: relativeSafe(cwd, relative) };
    });
    for (const item of plan) await assertWritableTarget(item.target, item.relative, noOverwrite);
    for (const dir of dirs) await fs.mkdir(relativeSafe(cwd, path.join(destination, dir)), { recursive: true });

    const origin = requestOrigin(req), written = [];
    for (const item of plan) {
      await fs.mkdir(path.dirname(item.target), { recursive: true });
      relativeSafe(cwd, item.relative);
      await moveInto(item.source, item.target);
      written.push(await describeFile(origin, project, cwd, item.target));
    }
    send(res, 201, { project, directory: destination || '.', archive: received, files: written });
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

// GET/HEAD /artifacts/<project>/<file>, with single-range support for seeking and resumable downloads.
async function handleArtifact(req, res, url) {
  const [project, ...rest] = pathSegments(url.pathname, '/artifacts/');
  if (!project || !rest.length) throw httpError(400, 'Usage: /artifacts/<project>/<file>');
  let target, stat;
  try {
    target = relativeSafe(projectPath(project), rest.join('/'));
    stat = await fs.stat(target);
  } catch { throw httpError(404, 'File not found'); }
  if (!stat.isFile()) throw httpError(404, 'Not a file');

  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = {
    'content-type': contentTypeFor(target), 'accept-ranges': 'bytes', etag,
    'last-modified': stat.mtime.toUTCString(), 'content-disposition': contentDisposition(path.basename(target)), 'cache-control': 'no-store',
  };
  let status = 200, start = 0, end = stat.size - 1;
  const ifRange = req.headers['if-range'];
  if (req.headers.range && (!ifRange || ifRange === etag || ifRange === headers['last-modified'])) {
    const range = parseRange(req.headers.range, stat.size);
    if (range === false) return send(res, 416, 'Range not satisfiable', { 'content-range': `bytes */${stat.size}`, 'accept-ranges': 'bytes' });
    if (range) { [start, end] = range; status = 206; headers['content-range'] = `bytes ${start}-${end}/${stat.size}`; }
  }
  headers['content-length'] = stat.size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || stat.size === 0) return res.end();
  await pipeline(createReadStream(target, { start, end }), res).catch(() => {});
}

const ROUTES = [
  { prefix: '/artifacts/', methods: ['GET', 'HEAD'], handle: handleArtifact },
  { prefix: '/files/', methods: ['PUT'], handle: handleFileUpload },
  { prefix: '/archives/', methods: ['POST'], handle: handleArchiveUpload },
];

const httpServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/health' && req.method === 'GET') {
      return send(res, 200, { ok: true, service: PACKAGE.name, version: PACKAGE.version, hyperframesVersion: PACKAGE.dependencies.hyperframes, maxUploadBytes: MAX_UPLOAD_BYTES });
    }
    if (url.pathname === '/' && req.method === 'GET') {
      return send(res, 200, 'HyperFrames MCP server is running.\nMCP endpoint: /mcp\nDownload: GET /artifacts/<project>/<file>\nUpload file: PUT /files/<project>/<path>\nUpload archive: POST /archives/<project>[/<dir>]\n');
    }
    const route = ROUTES.find(item => url.pathname.startsWith(item.prefix));
    if (route) {
      if (!route.methods.includes(req.method)) {
        req.resume();
        return send(res, 405, `Method not allowed. Use ${route.methods.join(' or ')}.`, { allow: route.methods.join(', ') });
      }
      try { return await route.handle(req, res, url); } catch (error) {
        req.resume();
        if (res.headersSent) return res.destroy();
        const status = error.status || 500;
        if (status === 500) console.error(error);
        return send(res, status, { error: status === 500 ? 'Internal error' : error.message });
      }
    }
    nodeHandler(req, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, 'Internal error');
  }
});

// Keep idle connections longer than typical proxy/client pools (Render's proxy keeps ~60s), so a reused
// connection is not closed by the server at the moment a client sends on it.
httpServer.keepAliveTimeout = 65_000;
httpServer.headersTimeout = 66_000;
// Node's default 300s request timeout would cut off large uploads on slow links.
httpServer.requestTimeout = Number(process.env.HF_REQUEST_TIMEOUT_MS || 60 * 60 * 1000);

httpServer.listen(PORT, HOST, () => {
  console.log(`HyperFrames MCP server listening on http://${HOST}:${PORT}/mcp`);
  console.log(`Artifacts: GET http://${HOST}:${PORT}/artifacts/<project>/<file>`);
  console.log(`Uploads: PUT /files/<project>/<path>, POST /archives/<project>[/<dir>] (max ${MAX_UPLOAD_BYTES} bytes)`);
  console.log(`HyperFrames binary: ${HYPERFRAMES_BIN}`);
});
