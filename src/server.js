import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs, createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
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
const fpsSchema = z.union([z.number().int().min(1).max(240), z.string().regex(/^\d+\/[1-9]\d*$/).refine(value => { const [n, d] = value.split('/').map(Number); return n / d >= 1 && n / d <= 240; }, 'Frame rate must be between 1 and 240')]);
const timesSchema = z.array(z.number().nonnegative()).min(1).max(100);
const CLI_COMMANDS = ['doctor', 'init', 'info', 'lint', 'validate', 'check', 'preview', 'render', 'compositions', 'catalog', 'add', 'transcribe', 'tts', 'upgrade', 'docs', 'snapshot', 'timeline', 'audio', 'normalize-audio', 'beats', 'inspect', 'keyframes', 'layout', 'measure', 'diff', 'compare', 'grade-compare', 'media-treatment', 'media-use', 'remove-background', 'capture', 'history'];

await fs.mkdir(ROOT, { recursive: true });

function projectPath(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(name)) throw new Error('Invalid project name. Use letters, numbers, dot, dash, or underscore only.');
  const resolved = path.resolve(ROOT, name);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) throw new Error('Project path escapes workspace.');
  return resolved;
}
function relativeSafe(projectDir, filePath) {
  const resolved = path.resolve(projectDir, filePath);
  if (resolved !== projectDir && !resolved.startsWith(projectDir + path.sep)) throw new Error('File path escapes the project directory.');
  return resolved;
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
async function runHyperframes(args, cwd = ROOT) {
  const browserPath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.HYPERFRAMES_BROWSER_PATH || (existsSync(DEFAULT_BROWSER) ? DEFAULT_BROWSER : undefined);
  const { stdout, stderr } = await execFileAsync(HYPERFRAMES_BIN, args, {
    cwd,
    env: {
      ...process.env,
      CI: '1',
      ...(browserPath ? { PUPPETEER_EXECUTABLE_PATH: browserPath, HYPERFRAMES_BROWSER_PATH: browserPath } : {}),
    },
    timeout: COMMAND_TIMEOUT,
    maxBuffer: MAX_OUTPUT,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}
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
function registerCliTool(server, name, description, schema, buildArgs) {
  server.registerTool(name, { description, inputSchema: schema }, async input => {
    try {
      const cwd = input.project ? projectPath(input.project) : ROOT;
      const result = await runHyperframes(buildArgs(input, cwd), cwd);
      return textResult(result.stdout || result.stderr || 'Command completed.');
    } catch (error) { return errorResult(error); }
  });
}

function registerTools(server) {
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
  registerCliTool(server, 'hyperframes_render', 'Render on the MCP host using local Chromium and FFmpeg. Output paths are relative to the project. Does not use the official cloud.', z.object({
    project: projectSchema,
    quality: z.enum(['draft', 'standard', 'high', 'looks', 'delivery']).optional(),
    output: z.string().min(1).optional(), composition: z.string().min(1).optional(),
    fps: fpsSchema.optional(), format: z.enum(['mp4', 'mov', 'webm', 'gif', 'png-sequence', 'hls']).optional(),
    workers: z.union([z.number().int().positive().max(32), z.literal('auto')]).optional(),
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
  }).refine(v => v.crf === undefined || v.videoBitrate === undefined, 'crf and videoBitrate are mutually exclusive')
    .refine(v => v.start === undefined || v.end === undefined || v.start < v.end, 'start must be before end')
    .refine(v => !(v.hdr && v.sdr), 'hdr and sdr are mutually exclusive'), (input, cwd) => {
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
  server.registerTool('project_list_files', { title: 'List Project Files', description: 'List project files, including rendered outputs and snapshots.', inputSchema: z.object({ project: z.string().min(1), subdir: z.string().optional() }) }, async ({ project, subdir }) => { try { const cwd = projectPath(project), start = subdir ? relativeSafe(cwd, subdir) : cwd, entries = []; async function walk(dir) { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { if (['node_modules', '.git'].includes(entry.name)) continue; const full = path.join(dir, entry.name); if (entry.isDirectory()) await walk(full); else entries.push(path.relative(cwd, full)); } } await walk(start); return jsonResult(entries.sort()); } catch (e) { return errorResult(e); } });
  server.registerTool('project_read_file', { title: 'Read Project File', description: 'Read a UTF-8 text file.', inputSchema: z.object({ project: z.string().min(1), file: z.string().min(1) }) }, async ({ project, file }) => { try { const cwd = projectPath(project); return textResult(await fs.readFile(relativeSafe(cwd, file), 'utf8')); } catch (e) { return errorResult(e); } });
  server.registerTool('project_write_file', { title: 'Write Project File', description: 'Create or replace a UTF-8 text file.', inputSchema: z.object({ project: z.string().min(1), file: z.string().min(1), content: z.string().max(2_000_000) }) }, async ({ project, file, content }) => { try { const cwd = projectPath(project), target = relativeSafe(cwd, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content, 'utf8'); return textResult(`Wrote ${path.relative(cwd, target)} (${content.length} characters).`); } catch (e) { return errorResult(e); } });
  registerCliTool(server, 'hyperframes_cli', 'Advanced allowlisted CLI on the MCP host, with unrestricted CLI arguments (trusted LAN clients only). Official cloud, publishing and account commands are excluded.', z.object({
    command: z.enum(CLI_COMMANDS), project: projectSchema.optional(), args: z.array(z.string()).max(60).optional(),
  }), ({ command, args = [] }) => [command, ...args]);
}

function buildServer() {
  const server = new McpServer({ name: 'hyperframes-mcp-server', version: PACKAGE.version }, { capabilities: { tools: {} }, instructions: 'Use HyperFrames tools to create, edit, validate and render HTML-native video projects. After rendering, download videos from /artifacts/<project>/<file>.' });
  registerTools(server); return server;
}
const handler = createMcpHandler(buildServer);
const nodeHandler = toNodeHandler(handler);

const httpServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: PACKAGE.name, version: PACKAGE.version, hyperframesVersion: PACKAGE.dependencies.hyperframes }));
      return;
    }

    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('HyperFrames MCP server is running.\nMCP endpoint: /mcp\nArtifacts: /artifacts/<project>/<file>');
      return;
    }

    // Safe artifact download: /artifacts/<project>/<relative-file>
    if (url.pathname.startsWith('/artifacts/') && req.method === 'GET') {
      const parts = url.pathname.slice('/artifacts/'.length).split('/').filter(Boolean);
      if (parts.length < 2) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Usage: /artifacts/<project>/<file>');
        return;
      }
      const projectName = parts[0];
      const relFile = parts.slice(1).join('/');
      try {
        const cwd = projectPath(projectName);
        const target = relativeSafe(cwd, relFile);
        const stat = await fs.stat(target);
        if (!stat.isFile()) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Not a file');
          return;
        }
        res.writeHead(200, {
          'content-type': contentTypeFor(target),
          'content-length': stat.size,
          'content-disposition': `inline; filename="${path.basename(target)}"`,
          'cache-control': 'no-store',
        });
        createReadStream(target).pipe(res);
        return;
      } catch (e) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('File not found');
        return;
      }
    }

    nodeHandler(req, res);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Internal error');
  }
});

httpServer.listen(PORT, HOST, () => {
  console.log(`HyperFrames MCP server listening on http://${HOST}:${PORT}/mcp`);
  console.log(`Artifacts: http://${HOST}:${PORT}/artifacts/<project>/<file>`);
  console.log(`HyperFrames binary: ${HYPERFRAMES_BIN}`);
});
