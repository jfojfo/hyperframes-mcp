import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

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
const base = `http://127.0.0.1:${port}`;
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const child = spawn(process.execPath, ['src/server.js'], {
  cwd: root,
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), HF_WORKSPACE: workspace,
    HYPERFRAMES_NO_UPDATE_CHECK: '1', DO_NOT_TRACK: '1',
    ...(process.platform === 'darwin' && !process.env.PUPPETEER_EXECUTABLE_PATH ? { PUPPETEER_EXECUTABLE_PATH: chrome } : {}),
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
  assert.equal(tools.length, 21);
  for (const name of ['hyperframes_check', 'hyperframes_snapshot', 'hyperframes_timeline', 'hyperframes_audio', 'hyperframes_version']) assert.ok(report.tools.includes(name));
  assert.equal((await call('hyperframes_version')).trim(), '0.9.43');
  await call('hyperframes_init', { name: project, fps: 24 });
  assert.match(await fs.readFile(path.join(workspace, project, 'index.html'), 'utf8'), /data-fps="24"/);
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
  await call('hyperframes_render', { project, quality: 'looks', output: 'renders/smoke.mp4', workers: 1, lowMemoryMode: true, framesCacheDir: 'off', gpu: false, browserGpu: false });
  const video = path.join(workspace, project, 'renders/smoke.mp4');
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video], { encoding: 'utf8' }));
  const stream = probe.streams.find(item => item.codec_type === 'video');
  assert.equal(stream.width, 320); assert.equal(stream.height, 180); assert.equal(stream.nb_frames, '24');
  assert.equal(stream.avg_frame_rate, '24/1');
  execFileSync('ffmpeg', ['-v', 'error', '-i', video, '-f', 'null', '-'], { stdio: 'pipe' });
  report.media = probe;
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
  await call('hyperframes_render', { project, format: 'hls', output: 'renders/hls', workers: 1, lowMemoryMode: true, browserGpu: false, hlsSegmentSeconds: 1 });
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
