import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import * as tar from 'tar';

// Exercises the real HTTP MCP transport and real HyperFrames/Chrome/FFmpeg.
// Preserves media and a machine-readable report under workspace/verification.
const root = fileURLToPath(new URL('..', import.meta.url));
const workspace = path.join(root, 'workspace/verification');
await fs.mkdir(workspace, { recursive: true });
const socket = net.createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const project = `smoke-${Date.now()}`;
const UPLOAD_LIMIT = 4 * 1024 * 1024;
const EXTRACT_LIMIT = 2 * 1024 * 1024;
const base = `http://127.0.0.1:${port}`;
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const child = spawn(process.execPath, ['src/server.js'], {
  cwd: root,
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), HF_WORKSPACE: workspace,
    HYPERFRAMES_NO_UPDATE_CHECK: '1', DO_NOT_TRACK: '1', HF_MAX_UPLOAD_BYTES: String(UPLOAD_LIMIT), HF_MAX_EXTRACT_BYTES: String(EXTRACT_LIMIT),
    // Only use the standard macOS Chrome location if it exists; otherwise HyperFrames auto-detects.
    ...(process.platform === 'darwin' && !process.env.PUPPETEER_EXECUTABLE_PATH && existsSync(chrome) ? { PUPPETEER_EXECUTABLE_PATH: chrome } : {}),
  }, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', data => { serverLog += data; });
child.stderr.on('data', data => { serverLog += data; });
const report = { project, checks: [], responses: {}, startedAt: new Date().toISOString() };
let id = 0;
async function rpc(method, params) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(180000),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const messages = response.headers.get('content-type').includes('text/event-stream')
    ? body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
    : [JSON.parse(body)];
  const message = messages.find(item => item.id === id);
  assert.ok(message, body);
  assert.ok(!message.error, JSON.stringify(message.error));
  return message.result;
}
async function call(name, args = {}, expectedError = false) {
  const result = await rpc('tools/call', { name, arguments: args });
  (report.responses[name] ??= []).push(result);
  assert.equal(Boolean(result.isError), expectedError, JSON.stringify(result));
  report.checks.push(`${name}${expectedError ? ' rejects invalid input' : ''}`);
  console.log(`PASS ${name}${expectedError ? ' (expected error)' : ''}`);
  return result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
}
const sha256 = data => createHash('sha256').update(data).digest('hex');
// hyperframes_render returns a job; poll hyperframes_render_status until it is terminal.
async function render(args) {
  let view = JSON.parse(await call('hyperframes_render', { ...args, waitSeconds: 5 }));
  assert.match(view.jobId, /^render-/);
  for (let i = 0; i < 60 && !['succeeded', 'failed', 'cancelled'].includes(view.status); i++) {
    view = JSON.parse(await call('hyperframes_render_status', { jobId: view.jobId, waitSeconds: 30 }));
  }
  assert.equal(view.status, 'succeeded', JSON.stringify(view, null, 2));
  (report.responses.renderJobs ??= []).push(view);
  return view;
}
async function http(method, file, body, headers = {}) {
  const response = await fetch(`${base}${file}`, { method, body, headers, ...(body?.getReader ? { duplex: 'half' } : {}) });
  return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
}
function check(name) { report.checks.push(name); console.log(`PASS ${name}`); }
const parseJsonOutput = text => JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
// The guide topics are what MCP clients learn the HTML rules from: they must be advertised, served verbatim,
// and their example project must pass check and render visible frames (needs the GSAP CDN, like real projects).
async function guideChecks() {
  assert.match(report.initialize.instructions, /hyperframes_docs with topic "contract"/);
  const guide = topic => fs.readFile(path.join(root, 'src/guide', `${topic}.md`), 'utf8');
  const contract = await guide('contract');
  assert.equal(await call('hyperframes_docs', { topic: 'contract' }), contract);
  assert.equal(await call('hyperframes_docs', { topic: ' Workflow ' }), await guide('workflow'));
  assert.match(await call('hyperframes_docs', { topic: 'gsap' }), /__timelines/);
  assert.match(await call('hyperframes_docs', { topic: 'no-such-topic' }, true), /data-attributes[\s\S]*Topics served by this MCP server: contract, workflow/);
  check('guide topics advertised in instructions and served by hyperframes_docs');

  const example = `${project}-guide`;
  const [body, intro] = [...contract.matchAll(/```html\n([\s\S]*?)```/g)].map(match => match[1]);
  assert.ok(body?.includes('<body>') && intro?.includes('<template>'), 'contract.md lost its example blocks');
  await call('hyperframes_init', { name: example });
  const scaffold = await call('project_read_file', { project: example, file: 'index.html' });
  await call('project_write_file', { project: example, file: 'index.html', content: scaffold.replace(/<body>[\s\S]*<\/body>/, body.trim()) });
  await call('project_write_file', { project: example, file: 'compositions/intro.html', content: intro });
  await call('project_write_file', { project: example, file: 'compositions/outro.html', content: intro.replaceAll('intro', 'outro') });
  assert.equal(parseJsonOutput(await call('hyperframes_lint', { project: example, json: true })).errorCount, 0);
  const checked = parseJsonOutput(await call('hyperframes_check', { project: example, json: true }));
  assert.ok(checked.ok, JSON.stringify(checked, null, 2));
  // The example is what clients copy: it must not teach a warning either (e.g. first_frame_empty).
  const warnings = Object.values(checked).flatMap(section => section?.findings ?? []).filter(item => item.severity !== 'info');
  assert.deepEqual(warnings, [], JSON.stringify(warnings, null, 2));
  // Map snapshot paths to artifact URLs the way topic "workflow" tells clients to.
  const shots = parseJsonOutput(await call('hyperframes_snapshot', { project: example, at: [1.5, 4.5], json: true }));
  const projectDir = await fs.realpath(path.join(workspace, example)) + path.sep;
  const picked = shots.frames.filter(item => [1.5, 4.5].includes(item.time));
  assert.equal(picked.length, 2, JSON.stringify(shots.frames));
  for (const frame of picked) {
    assert.ok(frame.path.startsWith(projectDir + '.hyperframes/artifacts/snapshots/'), frame.path);
    const response = await fetch(`${base}/artifacts/${example}/${frame.path.slice(projectDir.length)}`);
    assert.equal(response.status, 200);
    // A mounted scene draws a large white title on the dark ground; a scene that failed to mount is blank.
    const gray = execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
      { input: Buffer.from(await response.arrayBuffer()), maxBuffer: 64 * 1024 * 1024 });
    assert.ok(gray.filter(value => value > 200).length > 5000, `frame at ${frame.time}s shows no title`);
  }
  await call('project_cleanup', { project: example });
  check('contract example passes lint and check, and snapshots download via the documented artifact path');
}
async function binaryTransferChecks() {
  const dir = path.join(workspace, project);
  // Every byte value, so any text/encoding mangling shows up.
  const data = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), randomBytes(300_000)]);
  const name = 'assets/bin/sample data ü.bin', urlPath = name.split('/').map(encodeURIComponent).join('/');
  let r = await http('PUT', `/files/${project}/${urlPath}`, data);
  assert.equal(r.status, 201, r.body.toString());
  let json = JSON.parse(r.body);
  assert.equal(json.size, data.length); assert.equal(json.sha256, sha256(data)); assert.equal(json.path, name);
  assert.deepEqual(await fs.readFile(path.join(dir, name)), data);
  assert.equal(json.url, `${base}/artifacts/${project}/${urlPath}`);
  check('PUT /files binary upload, byte-exact with sha256');

  assert.equal((await http('PUT', `/files/${project}/${urlPath}`, Buffer.from('x'), { 'if-none-match': '*' })).status, 412);
  assert.equal((await http('PUT', `/files/${project}/${urlPath}`, Buffer.from('x'), { 'x-content-sha256': sha256(Buffer.from('y')) })).status, 422);
  assert.deepEqual(await fs.readFile(path.join(dir, name)), data);
  r = await http('PUT', `/files/${project}/${urlPath}`, data, { 'x-content-sha256': sha256(data) });
  assert.equal(r.status, 200); assert.equal(JSON.parse(r.body).replaced, true);
  assert.equal((await http('PUT', `/files/${project}/assets`, data)).status, 409);
  assert.equal((await http('PUT', `/files/no-such-project/a.bin`, data)).status, 404);
  assert.equal((await http('PUT', `/files/${project}/..%2Fescape.bin`, data)).status, 400);
  assert.equal((await http('PUT', `/files/${project}/%E0%A4%A`, data)).status, 400);
  assert.equal((await http('GET', `/files/${project}/a.bin`)).status, 405);
  check('upload preconditions, sha256 mismatch, conflicts and bad paths rejected; file untouched');

  r = await http('PUT', `/files/${project}/too-big.bin`, Buffer.alloc(UPLOAD_LIMIT + 1));
  assert.equal(r.status, 413);
  const chunks = [Buffer.alloc(UPLOAD_LIMIT), Buffer.alloc(1024)];
  const stream = new ReadableStream({ pull(controller) { const chunk = chunks.shift(); chunk ? controller.enqueue(chunk) : controller.close(); } });
  r = await http('PUT', `/files/${project}/too-big.bin`, stream);
  assert.equal(r.status, 413);
  assert.ok(!(await fs.readdir(dir)).some(file => file.includes('too-big')));
  check('413 for declared and chunked oversize uploads, no partial file left');

  const artifact = `/artifacts/${project}/${urlPath}`;
  r = await http('GET', artifact);
  assert.equal(r.status, 200); assert.deepEqual(r.body, data);
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.match(r.headers.get('content-disposition'), /filename\*=UTF-8''sample%20data%20%C3%BC\.bin/);
  const etag = r.headers.get('etag');
  r = await http('HEAD', artifact);
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-length'), String(data.length)); assert.equal(r.body.length, 0);
  r = await http('GET', artifact, undefined, { range: 'bytes=100-199' });
  assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), `bytes 100-199/${data.length}`); assert.deepEqual(r.body, data.subarray(100, 200));
  r = await http('GET', artifact, undefined, { range: 'bytes=-10' });
  assert.equal(r.status, 206); assert.deepEqual(r.body, data.subarray(-10));
  r = await http('GET', artifact, undefined, { range: `bytes=${data.length - 5}-` });
  assert.equal(r.status, 206); assert.deepEqual(r.body, data.subarray(-5));
  r = await http('GET', artifact, undefined, { range: `bytes=${data.length}-` });
  assert.equal(r.status, 416); assert.equal(r.headers.get('content-range'), `bytes */${data.length}`);
  r = await http('GET', artifact, undefined, { range: 'bytes=0-9', 'if-range': etag });
  assert.equal(r.status, 206);
  r = await http('GET', artifact, undefined, { range: 'bytes=0-9', 'if-range': '"stale"' });
  assert.equal(r.status, 200); assert.equal(r.body.length, data.length);
  assert.equal((await http('POST', artifact)).status, 405);
  check('GET/HEAD /artifacts with Range, suffix/open ranges, 416, If-Range, UTF-8 filename');

  // Symlinks pointing out of the project must not be readable or writable through it.
  const outside = path.join(workspace, `${project}-outside`);
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(dir, 'leak.txt'));
  await fs.symlink(outside, path.join(dir, 'linkdir'));
  assert.equal((await http('GET', `/artifacts/${project}/leak.txt`)).status, 404);
  assert.equal((await http('GET', `/artifacts/${project}/linkdir/secret.txt`)).status, 404);
  assert.equal((await http('PUT', `/files/${project}/linkdir/planted.bin`, data)).status, 403);
  assert.ok(!existsSync(path.join(outside, 'planted.bin')));
  await call('project_read_file', { project, file: 'leak.txt' }, true);
  await call('project_write_file', { project, file: 'linkdir/planted.txt', content: 'x' }, true);
  assert.ok(!existsSync(path.join(outside, 'planted.txt')));
  await fs.rm(path.join(dir, 'leak.txt')); await fs.rm(path.join(dir, 'linkdir'));
  check('symlink escapes blocked for download, upload and file tools');
  assert.match(await call('project_read_file', { project, file: name }, true), /Binary file .*\/artifacts\//);

  // Archive upload: nested files + empty dir; then malicious archives must leave the project untouched.
  const src = await fs.mkdtemp(path.join(tmpdir(), 'hf-smoke-archive-'));
  await fs.mkdir(path.join(src, 'pack/sub'), { recursive: true }); await fs.mkdir(path.join(src, 'pack/empty'));
  await fs.writeFile(path.join(src, 'pack/a.txt'), 'hello');
  await fs.writeFile(path.join(src, 'pack/sub/b.bin'), data);
  // Archives are built with node-tar so the test runs unchanged on Linux and macOS.
  const pack = path.join(src, 'pack');
  await tar.c({ gzip: true, file: path.join(src, 'good.tgz'), cwd: pack }, ['.']);
  r = await http('POST', `/archives/${project}/imported`, await fs.readFile(path.join(src, 'good.tgz')));
  assert.equal(r.status, 201, r.body.toString());
  json = JSON.parse(r.body);
  assert.deepEqual(json.files.map(item => item.path).sort(), ['imported/a.txt', 'imported/sub/b.bin']);
  assert.equal(json.files.find(item => item.path === 'imported/sub/b.bin').sha256, sha256(data));
  assert.deepEqual(await fs.readFile(path.join(dir, 'imported/sub/b.bin')), data);
  assert.ok((await fs.stat(path.join(dir, 'imported/empty'))).isDirectory());
  assert.equal((await http('POST', `/archives/${project}/imported`, await fs.readFile(path.join(src, 'good.tgz')), { 'if-none-match': '*' })).status, 412);
  // Archives produced by whichever system tar tools exist (GNU tar on Linux, bsdtar on macOS) must also import.
  const systemTars = ['tar', 'bsdtar', 'gtar'].filter(bin => { try { execFileSync(bin, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } });
  for (const bin of systemTars) {
    const archive = path.join(src, `${bin}.tgz`);
    execFileSync(bin, ['-czf', archive, '-C', pack, '.']);
    r = await http('POST', `/archives/${project}/from-${bin}`, await fs.readFile(archive));
    assert.equal(r.status, 201, `${bin}: ${r.body}`);
    assert.deepEqual(await fs.readFile(path.join(dir, `from-${bin}/sub/b.bin`)), data);
  }
  report.archiveSystemTars = systemTars;

  const rejected = async (label, archive, status = 400) => {
    const result = await http('POST', `/archives/${project}/${label}`, archive);
    assert.equal(result.status, status, `${label}: ${result.body}`);
    assert.ok(!existsSync(path.join(dir, label)), label);
  };
  const evil = path.join(src, 'evil');
  await fs.mkdir(evil);
  await fs.writeFile(path.join(evil, 'ok.txt'), 'fine');
  await fs.symlink('/etc/passwd', path.join(evil, 'link'));
  await tar.c({ gzip: true, file: path.join(src, 'link.tgz'), cwd: evil }, ['ok.txt', 'link']);
  await rejected('evil-symlink', await fs.readFile(path.join(src, 'link.tgz')));
  await fs.rm(path.join(evil, 'link'));
  await fs.link(path.join(evil, 'ok.txt'), path.join(evil, 'hard.txt'));
  await tar.c({ file: path.join(src, 'hard.tar'), cwd: evil }, ['ok.txt', 'hard.txt']);
  const hardTypes = [];
  await tar.t({ file: path.join(src, 'hard.tar'), onReadEntry: entry => hardTypes.push(entry.type) });
  assert.ok(hardTypes.includes('Link'), hardTypes.join());
  await rejected('evil-hardlink', await fs.readFile(path.join(src, 'hard.tar')));
  await tar.c({ file: path.join(src, 'dotdot.tar'), cwd: path.join(pack, 'sub'), preservePaths: true }, ['../a.txt']);
  const dotdotPaths = [];
  await tar.t({ file: path.join(src, 'dotdot.tar'), onReadEntry: entry => dotdotPaths.push(entry.path) });
  assert.deepEqual(dotdotPaths, ['../a.txt']);
  await rejected('evil-dotdot', await fs.readFile(path.join(src, 'dotdot.tar')));
  await fs.writeFile(path.join(evil, 'bomb.bin'), Buffer.alloc(EXTRACT_LIMIT + 1));
  await tar.c({ gzip: true, file: path.join(src, 'bomb.tgz'), cwd: evil }, ['bomb.bin']);
  assert.ok((await fs.stat(path.join(src, 'bomb.tgz'))).size < 64 * 1024);
  await rejected('evil-bomb', await fs.readFile(path.join(src, 'bomb.tgz')), 413);
  await rejected('garbage', Buffer.from('not a tar archive'));
  assert.ok(!existsSync(path.join(workspace, 'a.txt')) && !existsSync(path.join(dir, '..', 'a.txt')));
  assert.deepEqual(await fs.readdir(path.join(workspace, '.staging')), []);
  await fs.rm(src, { recursive: true, force: true });
  check(`POST /archives: node-tar + ${systemTars.join("/") || "no system"} tar archives import; symlink, hardlink, ../, oversize and garbage rejected; staging cleaned`);
}
// project_cleanup runs on a throwaway project so the main smoke project and its media are preserved.
async function cleanupChecks(html) {
  const name = `${project}-cleanup`, dir = path.join(workspace, name);
  await call('hyperframes_init', { name });
  await call('project_write_file', { project: name, file: 'index.html', content: html });
  await fs.mkdir(path.join(dir, '.hyperframes/artifacts/snapshots/x'), { recursive: true });
  await fs.writeFile(path.join(dir, '.hyperframes/artifacts/snapshots/x/a.png'), randomBytes(1000));
  await fs.mkdir(path.join(dir, 'renders/work-0123abcd-xyz'), { recursive: true });
  await fs.writeFile(path.join(dir, 'renders/work-0123abcd-xyz/frame.jpg'), randomBytes(500));
  await fs.writeFile(path.join(dir, 'renders/keep.mp4'), randomBytes(100));
  const preview = JSON.parse(await call('project_cleanup', { project: name, scope: 'intermediate', dryRun: true }));
  assert.deepEqual(preview.removed.map(item => item.path).sort(), ['.hyperframes/artifacts', 'renders/work-0123abcd-xyz']);
  assert.equal(preview.totalBytes, 1500);
  assert.ok(existsSync(path.join(dir, 'renders/work-0123abcd-xyz')));
  await call('project_cleanup', { project: name, scope: 'intermediate' });
  assert.ok(!existsSync(path.join(dir, '.hyperframes/artifacts')) && !existsSync(path.join(dir, 'renders/work-0123abcd-xyz')));
  assert.ok(existsSync(path.join(dir, 'renders/keep.mp4')) && existsSync(path.join(dir, 'index.html')));
  // An active render blocks deletion unless cancelRenders is set.
  const job = JSON.parse(await call('hyperframes_render', { project: name, output: 'renders/busy.mp4', workers: 1, browserGpu: false }));
  assert.match(await call('project_cleanup', { project: name }, true), /active render jobs/);
  assert.ok(existsSync(dir));
  const done = JSON.parse(await call('project_cleanup', { project: name, cancelRenders: true }));
  assert.deepEqual(done.cancelledRenderJobs, [job.jobId]);
  assert.ok(!existsSync(dir));
  assert.equal((await http('GET', `/artifacts/${name}/renders/keep.mp4`)).status, 404);
  assert.equal((await http('PUT', `/files/${name}/a.bin`, Buffer.from('x'))).status, 404);
  assert.equal(JSON.parse(await call('hyperframes_render_list', { project: name })).jobs.length, 0);
  await call('project_cleanup', { project: name }, true);
  await call('project_cleanup', { project: '../etc' }, true);
  assert.deepEqual(await fs.readdir(path.join(workspace, '.staging')), []);
  check('project_cleanup: intermediate dry run + delete keeps sources/renders; active render blocks, cancelRenders deletes project and forgets jobs');
}
try {
  let health;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { health = await (await fetch(`${base}/health`)).json(); break; }
    catch { if (child.exitCode !== null) throw new Error(serverLog); await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(health?.ok, serverLog);
  report.health = health;
  report.initialize = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'hyperframes-smoke', version: '1' } });
  const { tools } = await rpc('tools/list', {});
  report.tools = tools.map(tool => tool.name);
  assert.equal(tools.length, 25);
  for (const name of ['hyperframes_check', 'hyperframes_snapshot', 'hyperframes_timeline', 'hyperframes_audio', 'hyperframes_version',
    'hyperframes_render_status', 'hyperframes_render_cancel', 'hyperframes_render_list', 'project_cleanup']) assert.ok(report.tools.includes(name));
  // workers must stay advertised as integer-or-string so clients can send "4" or "auto".
  const workersSchema = tools.find(tool => tool.name === 'hyperframes_render').inputSchema.properties.workers;
  assert.deepEqual(workersSchema.anyOf.map(item => item.type).sort(), ['integer', 'string'], JSON.stringify(workersSchema));
  assert.equal((await call('hyperframes_version')).trim(), '0.9.43');
  await guideChecks();
  await call('hyperframes_init', { name: project, fps: 24 });
  assert.match(await fs.readFile(path.join(workspace, project, 'index.html'), 'utf8'), /data-fps="24"/);
  await binaryTransferChecks();
  // Use a tiny, self-contained animated composition, with no CDN or model dependency.
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;width:320px;height:180px;overflow:hidden;background:#102030}
    #main{position:relative;width:320px;height:180px;background:#102030}
    #box{position:absolute;top:60px;left:20px;width:60px;height:60px;background:#00ccff}
    </style></head><body><div id="main" data-composition-id="main" data-start="0" data-duration="1" data-width="320" data-height="180" data-fps="24">
    <div id="box" class="clip" data-start="0" data-duration="1" data-track-index="0"></div></div><script>
    const box=document.getElementById('box');window.__timelines=window.__timelines||{};
    window.__timelines.main={duration:()=>1,pause(){return this},seek(t){box.style.transform='translateX('+(200*t)+'px)';return this}};
    </script></body></html>`;
  await call('project_write_file', { project, file: 'index.html', content: html });
  assert.equal(await call('project_read_file', { project, file: 'index.html' }), html);
  await call('hyperframes_info', { project });
  await call('hyperframes_lint', { project, json: true });
  await call('hyperframes_compositions', { project });
  await call('hyperframes_timeline', { project, json: true });
  await call('hyperframes_check', { project, json: true, samples: 2, craft: false, cache: false, budget: '60s' });
  await call('hyperframes_snapshot', { project, at: [0, 0.5], end: false, json: true });
  await call('hyperframes_snapshot', { project, output: '.', frames: 1 }, true);
  await call('hyperframes_render', { project, output: '../escape.mp4' }, true);
  await call('hyperframes_render', { project, crf: 20, videoBitrate: '1M' }, true);
  await call('hyperframes_render', { project, workers: 0 }, true);
  await call('hyperframes_render', { project, workers: '33' }, true);
  await call('hyperframes_render', { project: 'missing-project-xyz' }, true);
  await call('hyperframes_render_status', { jobId: 'render-does-not-exist' }, true);
  // workers as a numeric string: some clients send anyOf integer|string parameters this way.
  const renderView = await render({ project, quality: 'looks', output: 'renders/smoke.mp4', workers: '1', lowMemoryMode: true, framesCacheDir: 'off', gpu: false, browserGpu: false });
  assert.ok(renderView.args.includes('--workers') && renderView.args.includes('1'));
  report.checks.push('render job accepts workers as a numeric string and finishes via status polling');
  assert.equal(renderView.warnings, undefined);
  // start/end goes through HyperFrames' segmented path; the job must say workers/browserGpu are ignored there.
  const rangeView = await render({ project, output: 'renders/range.mp4', start: 0, end: 0.5, workers: 4, browserGpu: false });
  assert.match(rangeView.warnings?.[0] ?? '', /ignores workers/);
  const rangeProbe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v', '-show_entries', 'stream=nb_read_frames', '-of', 'json', path.join(workspace, project, 'renders/range.mp4')], { encoding: 'utf8' }));
  assert.equal(rangeProbe.streams[0].nb_read_frames, '12');
  const cliRange = await rpc('tools/call', { name: 'hyperframes_cli', arguments: { project, command: 'render', args: ['--start', '0', '--unsupported-range-smoke-flag'] } });
  assert.ok(cliRange.isError);
  assert.match(cliRange.content[0].text, /^WARNING: start\/end/);
  report.checks.push('start/end renders carry the segmented-path warning (render job + CLI)');
  const video = path.join(workspace, project, 'renders/smoke.mp4');
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video], { encoding: 'utf8' }));
  const stream = probe.streams.find(item => item.codec_type === 'video');
  assert.equal(stream.width, 320); assert.equal(stream.height, 180); assert.equal(stream.nb_frames, '24');
  assert.equal(stream.avg_frame_rate, '24/1');
  execFileSync('ffmpeg', ['-v', 'error', '-i', video, '-f', 'null', '-'], { stdio: 'pipe' });
  report.media = probe;
  const reported = renderView.artifacts.find(item => item.path === 'renders/smoke.mp4');
  assert.ok(reported, JSON.stringify(renderView));
  assert.equal(reported.sha256, sha256(await fs.readFile(video)));
  assert.equal(reported.url, `${base}/artifacts/${project}/renders/smoke.mp4`);
  assert.equal((await fetch(reported.url, { method: 'HEAD' })).headers.get('content-length'), String(reported.size));
  report.checks.push('render reports artifact url + size + sha256');
  const artifact = await fetch(`${base}/artifacts/${project}/renders/smoke.mp4`);
  assert.equal(artifact.status, 200); assert.equal(artifact.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await artifact.arrayBuffer()), await fs.readFile(video));
  report.checks.push('ffprobe + full FFmpeg decode + HTTP download byte match');
  const files = JSON.parse(await call('project_list_files', { project }));
  assert.ok(files.includes('renders/smoke.mp4'));
  const png = files.find(file => file.endsWith('.png') && file.includes('snapshots/'));
  assert.ok(png);
  const snapshot = await fetch(`${base}/artifacts/${project}/${png}`);
  assert.equal(snapshot.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await snapshot.arrayBuffer()), await fs.readFile(path.join(workspace, project, png)));
  // Exercise new HLS output plus the new downloadable playlist/segment types.
  await render({ project, format: 'hls', output: 'renders/hls', workers: 1, lowMemoryMode: true, browserGpu: false, hlsSegmentSeconds: 1 });
  // Cancel: a queued or running job must end as cancelled and stay listed.
  const cancelTarget = JSON.parse(await call('hyperframes_render', { project, output: 'renders/cancel.mp4', workers: 1, browserGpu: false }));
  const cancelled = JSON.parse(await call('hyperframes_render_cancel', { jobId: cancelTarget.jobId }));
  assert.equal(cancelled.status, 'cancelled', JSON.stringify(cancelled));
  const listed = JSON.parse(await call('hyperframes_render_list', { project }));
  assert.equal(listed.jobs.find(job => job.jobId === cancelTarget.jobId)?.status, 'cancelled');
  assert.equal(listed.jobs.filter(job => job.status === 'succeeded').length, 3);
  report.checks.push('render cancel + list');
  const hlsFiles = JSON.parse(await call('project_list_files', { project, subdir: 'renders/hls' }));
  const playlist = hlsFiles.find(file => file.endsWith('.m3u8'));
  const segment = hlsFiles.find(file => file.endsWith('.ts'));
  assert.ok(playlist); assert.ok(segment);
  const playlistResponse = await fetch(`${base}/artifacts/${project}/${playlist}`);
  assert.equal(playlistResponse.headers.get('content-type'), 'application/vnd.apple.mpegurl');
  assert.match(await playlistResponse.text(), /#EXTM3U/);
  const segmentResponse = await fetch(`${base}/artifacts/${project}/${segment}`);
  assert.equal(segmentResponse.headers.get('content-type'), 'video/mp2t');
  execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(workspace, project, playlist), '-f', 'null', '-'], { stdio: 'pipe' });
  report.checks.push('HLS playlist + segment download and full decode');
  // Check signal analysis and transcript import without downloading models.
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', path.join(workspace, project, 'tone.wav')]);
  await call('hyperframes_audio', { project, input: 'tone.wav', capabilities: 'loudness,silence', json: true });
  await call('project_write_file', { project, file: 'captions.srt', content: '1\n00:00:00,000 --> 00:00:00,800\nHello world\n' });
  await call('hyperframes_transcribe', { project, input: 'captions.srt', engine: 'whisper', json: true });
  await call('hyperframes_cli', { project, command: 'tts', args: ['--list'] });
  await call('hyperframes_cli', { command: 'cloud', args: [] }, true);
  // A failure from the real CLI must be marked as an MCP tool error.
  await call('hyperframes_cli', { project, command: 'render', args: ['--unsupported-upgrade-smoke-flag'] }, true);
  await cleanupChecks(html);
  report.renderWorkDirsRemaining = (await fs.readdir(path.join(workspace, project, 'renders'))).filter(name => name.startsWith('work-'));
  assert.equal(report.renderWorkDirsRemaining.length, 0);
  report.systemTempRenderDirs = (await fs.readdir(tmpdir())).filter(name => name.startsWith('hf-render-'));
  report.ok = true;
  console.log(`Verified media: ${video}`);
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => { child.once('exit', resolve); if (child.exitCode !== null) resolve(); });
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(workspace, `${project}-report.json`), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(workspace, `${project}-server.log`), serverLog);
}
