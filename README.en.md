# HyperFrames MCP Server

[简体中文](README.md) | English

HTTP MCP server for HyperFrames 0.9.43, intended to run on a machine in your LAN. It exposes HyperFrames project creation, file authoring, linting, validation, composition inspection, rendering, transcription, TTS, catalog access, documentation, and an advanced HyperFrames CLI tool over Streamable HTTP.

## Architecture

LAN client → HTTP /mcp → this host → project-local HyperFrames CLI → local Chromium/FFmpeg → local rendered video
LAN client ← HTTP /artifacts/<project>/<file> ← this host

This repository does **not** copy Nate Herk's student kit into your repository. It uses the public HyperFrames npm package directly. The student kit is MIT licensed, while its included AIS brand assets are not licensed for reuse; do not copy those assets into this server.

## Local run

Requirements: Node.js 22+, FFmpeg, Chromium/Chrome.

```bash
npm ci
npm start
```

The MCP endpoint is:

`http://localhost:9006/mcp` on this machine; LAN clients use `http://<this-machine-LAN-IP>:9006/mcp` (Streamable HTTP).

The default listener is `0.0.0.0:9006`. All render work happens on the MCP host. No HeyGen login, official cloud render, or global HyperFrames installation is required.

Browser selection, in order: `PUPPETEER_EXECUTABLE_PATH`, then `HYPERFRAMES_BROWSER_PATH`, then `/usr/local/bin/hyperframes-chromium` if that file exists (the wrapper the Docker image installs), otherwise HyperFrames auto-detects Chrome/Chromium. The chosen path is passed to the CLI as both variables. Every CLI call also runs with `CI=1`.

The client must support plain HTTP LAN MCP endpoints; a cloud-hosted client cannot directly reach a private LAN IP.

Configuration:

| Variable | Default |
| --- | --- |
| `HOST` | `0.0.0.0` |
| `PORT` | `9006` |
| `HF_WORKSPACE` | `<install dir>/.hyperframes-mcp/projects` (see Install); `<this-repo>/.hyperframes-mcp/projects` in a source checkout |
| `HYPERFRAMES_BIN` | `node_modules/.bin/hyperframes` of this package (`<repo>/node_modules/...`, or `<install dir>/app/node_modules/...`) |
| `HYPERFRAMES_MCP_HOME` | Base directory for the default `HF_WORKSPACE`. Set by the installed launcher to the install directory; unset in a source checkout (repo root is used) |
| `HYPERFRAMES_MCP_NODE` | Launcher only: Node.js executable to use instead of the first `node` on `PATH` |
| `HF_COMMAND_TIMEOUT_MS` | `900000` (15 minutes per synchronous command; does not apply to `hyperframes_render` jobs) |
| `HF_RENDER_TIMEOUT_MS` | `7200000` (2 hours per render job; the job is then stopped and marked failed) |
| `HF_MAX_CONCURRENT_RENDERS` | `1` (render jobs running at once; later jobs queue) |
| `PUPPETEER_EXECUTABLE_PATH` / `HYPERFRAMES_BROWSER_PATH` | Explicit browser override, otherwise auto-detect |
| `HF_MAX_UPLOAD_BYTES` | `1073741824` (1 GiB per upload request, file or archive) |
| `HF_MAX_EXTRACT_BYTES` | `2147483648` (2 GiB total extracted size per archive) |
| `HF_MAX_ARCHIVE_ENTRIES` | `10000` |
| `HF_REQUEST_TIMEOUT_MS` | `3600000` (time allowed to receive one HTTP request, including upload body) |
| `PUBLIC_BASE_URL` | Unset: download URLs use the request's `Host` / `X-Forwarded-*` headers. Set e.g. `https://hf.example.com` to force |

Command-line flags (`bin/hyperframes-mcp.js`, also the installed launcher) set the same variables: `--host`, `-p/--port`, `-w/--workspace` (`~` is expanded), `--browser` (sets `PUPPETEER_EXECUTABLE_PATH`), `-v/--version`, `-h/--help`.

Health check:

`http://localhost:9006/health` returns `{ ok, service, version, hyperframesVersion, maxUploadBytes }`. `hyperframesVersion` is the declared dependency; call `hyperframes_version` for the CLI actually running. `GET /` prints a short summary of the routes.

On startup the server creates `HF_WORKSPACE` and empties its `.staging/` subdirectory (temporary upload/archive/delete area; project names cannot start with `.`, so it is never a project).

## Install

`npm run package` builds a self-contained install directory, separate from the source checkout. Run it on the machine that will host the server (the install contains platform-specific binaries):

```bash
cd hyperframes-mcp            # source checkout
npm ci
npm run package -- --out="$HOME/.local/share/hyperframes-mcp"
"$HOME/.local/share/hyperframes-mcp/hyperframes-mcp" --version
```

It copies `bin/`, `src/` and the lockfile into `<out>/app/`, installs production dependencies there with `npm ci`, and writes the launcher `hyperframes-mcp` and a reference `hyperframes-mcp.env.example`.

```text
~/.local/share/hyperframes-mcp/
├── hyperframes-mcp                launcher (launchd points here)
├── hyperframes-mcp.env            your settings (optional; copy from the example)
├── hyperframes-mcp.env.example    reference settings (replaced on upgrade)
├── service.log                    launchd log, if you use the launchd agent
├── app/                           server code and dependencies (replaced on upgrade)
└── .hyperframes-mcp/projects/     projects (HF_WORKSPACE default), created by the server
```

**Upgrade**: pull the new source, run the same `npm run package -- --out=...`, then restart the server. Only `app/`, the launcher and the example are replaced; the new `app/` is installed beside the old one before being swapped in. `hyperframes-mcp.env` and `.hyperframes-mcp/` are kept.

**Settings**: `cp hyperframes-mcp.env.example hyperframes-mcp.env` and edit it; it holds the environment variables from the table above. Flags override it: `hyperframes-mcp --help` lists `--host`, `--port`, `--workspace` and `--browser`. The launcher runs the first `node` (22+) on `PATH`, or `HYPERFRAMES_MCP_NODE`, and works through a symlink. It sets `HYPERFRAMES_MCP_HOME` to its own directory, which is where `.hyperframes-mcp/projects` is created; in a source checkout (`npm start`) that is the repo root instead.

### Background service on macOS (launchd)

Copy the [launchd template](docs/launchd/com.example.hyperframes-mcp.plist) and replace `/path/to/hyperframes-mcp` with the absolute directory passed to `--out`. Use `command -v node ffmpeg ffprobe` to find the tools, then replace `/path/to/tool-bin` with their directories separated by colons. Keep `ProcessType` set to `Interactive`. With `Background` or the default, macOS can throttle CPU and I/O for the server and its Chrome/FFmpeg processes.

To select a browser manually, set its path in `hyperframes-mcp.env`, for example `PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`.

```bash
mkdir -p ~/Library/LaunchAgents
cp docs/launchd/com.example.hyperframes-mcp.plist ~/Library/LaunchAgents/
# edit the paths, then:
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.hyperframes-mcp.plist   # start now and at login
launchctl print gui/$(id -u)/com.example.hyperframes-mcp | head -20                          # status
launchctl kickstart -k gui/$(id -u)/com.example.hyperframes-mcp                              # restart (e.g. after upgrade)
launchctl bootout gui/$(id -u)/com.example.hyperframes-mcp                                   # stop and disable
tail -f "$HOME/.local/share/hyperframes-mcp/service.log"                                     # log in the example install directory
curl --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:9006/health             # wait until ready
```

Stopping sends SIGTERM: running render jobs are stopped and lost (jobs live in memory), so resubmit them after a restart. Projects and finished outputs stay on disk.

## Optional Render.com / Docker deployment

This repo also includes `Dockerfile` and `render.yaml`. This hosts the same MCP server on Render.com; it is separate from the HyperFrames official cloud render service. For a LAN deployment, use the local instructions above. The container uses `/workspace/projects` and the same locked npm dependency as the local server. The image installs Debian `chromium` and FFmpeg and wraps Chromium in `/usr/local/bin/hyperframes-chromium` (`--disable-dev-shm-usage --no-sandbox --disable-gpu --single-process …`) because Render provides only ~64 MB `/dev/shm`; the server picks this wrapper up automatically.

1. In Render, create a **Web Service** from this GitHub repository.
2. Select the Docker runtime (the Blueprint already specifies it).
3. Deploy the `main` branch.
4. After deployment, verify `/health` returns JSON with `ok: true`.
5. Your MCP endpoint is:

`https://YOUR-SERVICE.onrender.com/mcp`

Render web services must listen on `0.0.0.0` and the `PORT` environment variable; this server does that by default. The included health check uses `/health`.

## MCP connector

For LAN use, connect your MCP client to `http://<this-machine-LAN-IP>:9006/mcp` using **Streamable HTTP**. For a Render.com deployment, use the deployed HTTPS endpoint ending in `/mcp`.

Example:

```text
https://YOUR-SERVICE.onrender.com/mcp
```

The server also sends MCP `instructions` describing the upload → render → poll → download → cleanup workflow, so clients learn it on connect.

### Composition guide for clients

`hyperframes init` runs with `--skip-skills`, so the upstream HyperFrames agent skills (which assume a local shell and `npx`) never reach MCP clients. Instead, `hyperframes_docs` serves two topics written for clients of this server from [`src/guide/`](src/guide/):

- `contract`: the rules composition HTML must follow (timed clips, timeline registration, determinism, scene `<template>` files, matching ids, fonts, asset paths), with a minimal two-scene example.
- `workflow`: the order of tools and HTTP calls, from `hyperframes_init` through upload, write, check, snapshot, render, download and `project_cleanup`.

The MCP `instructions` and the `hyperframes_init` / `project_write_file` descriptions tell clients to read both before writing compositions. Other topics pass through to `hyperframes docs`. When upgrading HyperFrames, compare the guide with the new upstream skills in `node_modules/hyperframes/dist/skills/` (`hyperframes`, `hyperframes-cli`) and update `CLI_DOC_TOPICS` in `src/server.js`; `npm run smoke` checks that the contract's example still passes `check`.

After connecting, the client discovers 25 tools:

| Tool | Purpose and notable parameters |
| --- | --- |
| `hyperframes_doctor` | Check HyperFrames, Node, FFmpeg and Chromium on the host. |
| `hyperframes_version` | Version of the CLI actually running. |
| `hyperframes_init` | Create a project (`name`, `example`, `resolution`, `fps`). Runs `init --non-interactive --skip-skills`; `fps` is written to the composition root's `data-fps` afterwards. Must be called before uploading. |
| `hyperframes_info` / `hyperframes_lint` / `hyperframes_validate` / `hyperframes_compositions` | Project metadata (JSON), lint, legacy validation, composition IDs and durations. |
| `hyperframes_check` | Preferred unified check (lint, runtime, layout, motion, contrast): `samples`, `at`, `range`, `components`, `atTransitions`, `strict`, `contrast`, `craft`, `cache`, `snapshots`, `timeout`, `budget`, `json`. |
| `hyperframes_snapshot` | PNG key frames / review sheets: `frames`, `at`, `range`, `composition`, `review`, `end`, `keep`, `zoom`, `zoomScale`, `angle`, `against`, `json`, `timeout`. An explicit `output` must be a dedicated directory (not the project root, `index.html`, `assets`, `compositions`, `.hyperframes` …) because the CLI clears it. No AI vision service is called. |
| `hyperframes_timeline` | Read tracks, clips and timing (read-only; edit through `hyperframes_cli`). |
| `hyperframes_audio` | Local signal analysis of timing, loudness and silence, always `--quality fast`: `input`, `target`, `at`, `range`, `capabilities`, `json`. |
| `hyperframes_render` | Submit a background render job, see [Render jobs](#render-jobs). |
| `hyperframes_render_status` / `_cancel` / `_list` | Poll, cancel and list render jobs. |
| `hyperframes_transcribe` | Local transcription (`engine`: `auto`/`whisper`/`parakeet`, `model`, `language`) or SRT/VTT/JSON import. May download models. |
| `hyperframes_tts` | Local Kokoro voiceover (`text` ≤ 20 000 chars, `output`, `voice`, `speed`, `language`). May download the model. |
| `hyperframes_catalog` / `hyperframes_add` | Search the registry / install a catalog item (needs internet). |
| `hyperframes_docs` | `contract` and `workflow` (see [Composition guide for clients](#composition-guide-for-clients)), or a CLI documentation topic. |
| `project_write_file` / `project_read_file` / `project_list_files` | UTF-8 text files only (≤ 2 MB per write); binary reads are refused with a download URL. Listing skips `node_modules` and `.git` but includes renders and snapshots. |
| `project_cleanup` | Delete a finished project, or only its intermediate files, see [Cleaning up](#cleaning-up-finished-projects). |
| `hyperframes_cli` | Advanced, synchronous, with raw `args` (≤ 60). Allowed commands: `doctor init info lint validate check preview render compositions catalog add transcribe tts upgrade docs snapshot timeline audio normalize-audio beats inspect keyframes layout measure diff compare grade-compare media-treatment media-use remove-background capture history`. Cloud, publishing, sharing and account commands are excluded. |

Project names must match `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$`. Every file path argument is project-relative and is rejected if it resolves (including through symlinks) outside the project.

## Files and render lifecycle

Projects are retained under `HF_WORKSPACE/<project>/`. The MCP server does not create a new temporary project for each render. The CLI runs with that project as its working directory.

- Final output: by default `renders/<project>_<date>_<time>.<ext>` inside the project, or the explicit project-relative `output`.
- Snapshots: `.hyperframes/artifacts/snapshots/<unique-id>/`; check reports: `.hyperframes/artifacts/checks/`.
- Intermediate render work: on macOS/Windows, OS temp directory `hf-render-*`; on Linux, `work-<job-id>-*` next to the output. HyperFrames normally removes this work directory on success/failure. Debug mode, `KEEP_TEMP=1`, or an abrupt process/host failure can leave files behind.
- Extracted media cache: OS temp directory `hyperframes-extract-cache-<uid>` by default, reused across renders. Set render `framesCacheDir: "off"` to disable this cache for a render.
- A LAN client gets text/JSON results, then downloads files using `/artifacts/<project>/<relative-file>`. Files are not automatically copied to the client. When a render job succeeds, `hyperframes_render_status` lists the files it wrote under `artifacts`, each with `url`, `size` and `sha256`. Use `project_list_files` to discover other media, including HLS segments and PNG sequence files.

## Cleaning up finished projects

Projects are never deleted automatically. When a project is finished and the client has downloaded the outputs it needs, call `project_cleanup`:

| Argument | Default | Meaning |
| --- | --- | --- |
| `project` | required | Project name. |
| `scope` | `"project"` | `"project"` deletes the whole project directory (sources, uploads, renders) and forgets its finished render jobs. `"intermediate"` keeps sources and renders and deletes only `.hyperframes/artifacts/` (snapshots, check reports) and `work-<8 hex>-*` render work directories left behind by crashed or killed renders. |
| `dryRun` | `false` | Return what would be deleted (paths, file counts, bytes) without deleting anything. |
| `cancelRenders` | `false` | The call is refused while the project has queued or running render jobs. With `true`, those jobs are cancelled first (SIGTERM, then SIGKILL after 10 s); if one does not stop, nothing is deleted. |

The result lists each removed path with `files` and `bytes`, plus `totalFiles` / `totalBytes`. A whole-project delete first renames the directory into the workspace staging area, so the project disappears at once (later tool calls, uploads and `/artifacts` downloads get "not found"), and then removes it. Deletion is permanent. The shared HyperFrames media cache (`hyperframes-extract-cache-<uid>` in the OS temp directory) is used by all projects and is not touched.

## Binary files over HTTP

MCP tool calls carry text only: `project_write_file` / `project_read_file` handle UTF-8 text, and `project_read_file` refuses binary files. Images, audio, video and fonts move over plain HTTP routes next to `/mcp`, so the bytes never pass through the model's context. Paths are project-relative and percent-encoded per segment. The project must already exist (`hyperframes_init`).

| Route | Purpose |
| --- | --- |
| `PUT /files/<project>/<path>` | Upload one file; the body is the raw bytes. Parent directories are created. Returns `201` (new) or `200` (replaced) with `{ path, size, sha256, url }`. |
| `POST /archives/<project>[/<dir>]` | Upload a `tar` or gzip-compressed `tar.gz` and extract it into the project or `<dir>`. Returns every written file with `size`, `sha256` and `url`. |
| `GET` / `HEAD /artifacts/<project>/<file>` | Download. Supports single `Range` requests (`206` / `416`), `ETag` / `If-Range`, and UTF-8 filenames. |

Optional request headers for uploads: `X-Content-SHA256: <hex>` rejects the upload with `422` if the received bytes differ, and `If-None-Match: *` refuses to overwrite existing files (`412`). Oversized uploads get `413`; uploads to a project that does not exist get `404`; a wrong HTTP method gets `405`. Errors are returned as JSON `{ "error": ... }`. Uploads are written to a temporary file and renamed into place, so a failed or rejected upload never leaves a partial file.

Archives are read with the bundled `tar` npm package, so behaviour is identical on Linux and macOS and no system `tar` is needed. They are checked before extraction and again after it. Only regular files and directories are accepted: symlinks, hard links, devices, absolute paths and `..` paths cause the whole archive to be rejected (`400`) with nothing written. Total extracted size and entry count are limited (`413`), checked from the headers before anything is written.

```bash
BASE=http://<host>:9006
curl -T logo.png "$BASE/files/demo/assets/logo.png"
curl -H "X-Content-SHA256: $(sha256sum voice.wav | cut -d' ' -f1)" -T voice.wav "$BASE/files/demo/assets/voice.wav"
tar -czf assets.tgz -C ./assets . && curl --data-binary @assets.tgz "$BASE/archives/demo/assets"
curl -C - -o out.mp4 "$BASE/artifacts/demo/renders/out.mp4"   # resumable download
```

## Render jobs

MCP clients usually time out a tool call after about a minute, while renders often take longer. Rendering therefore runs as a background job:

1. `hyperframes_render` validates the arguments, queues the job and returns at once with `jobId` and `status`. Invalid arguments still fail immediately.
2. `hyperframes_render_status { jobId, waitSeconds?, logLines? }` returns `queued` (with `queuePosition`), `running` (with `progress` from the CLI's `@hf-progress` lines and `etaSeconds` when known), `succeeded` (with the CLI `output` and `artifacts`), `failed` (with `error` and a longer `logTail`) or `cancelled`. `waitSeconds` (0–30) blocks until the job finishes or the time runs out; keep it below the client's tool-call timeout.
3. `hyperframes_render_cancel { jobId }` stops a queued or running job (SIGTERM to the whole process group, SIGKILL after 10 s).
4. `hyperframes_render_list { project? }` lists jobs.

`hyperframes_render` parameters (all optional except `project`; each maps to the CLI flag of the same name):

| Group | Parameters |
| --- | --- |
| Output | `output`, `composition`, `format` (`mp4` `mov` `webm` `gif` `png-sequence` `hls`), `resolution`, `fps` (1–240, integer or fraction such as `"30000/1001"`), `start` / `end` (seconds) |
| Quality | `quality` (`draft` `standard` `high` `looks` `delivery`), `crf` (0–51) **or** `videoBitrate`, `maxBitrate`, `bufferSize`, `keyframeInterval`, `proresProfile` (`proxy` `lt` `422` `hq` `4444`), `hdr` **or** `sdr`, `motionBlur: "off"`, `videoFrameFormat` (`auto` `jpg` `png`), `gifLoop`, `hlsSegmentSeconds` (1–60) |
| Performance | `workers` (1–32 or `"auto"`), `gpu`, `browserGpu`, `docker`, `lowMemoryMode`, `framesCacheDir` (project-relative, or `off`/`none`/`false`/`0`) |
| Variables / batch | `variables` (object, passed as JSON), `strictVariables`, `batch`, `batchConcurrency` (1–10), `batchFailFast` |
| Diagnostics | `strict`, `strictAll`, `bestEffort`, `debug`, `json` |
| Job | `waitSeconds` (0–30) |

`output`, `composition`, `batch` and `framesCacheDir` must stay inside the project. A succeeded job lists the files it wrote: the explicit `output` (file or directory), otherwise files under `renders/` modified since the job started (at most 200 are listed; `truncated` gives the rest).

`hyperframes_render` also accepts `waitSeconds`, so a short render can finish within the submitting call. Jobs run one at a time by default (`HF_MAX_CONCURRENT_RENDERS`). Job state lives in memory: a server restart stops running renders and forgets all jobs (rendered files stay in the project), and only the latest 200 finished jobs are kept. `hyperframes_cli` with `command: "render"` is still synchronous and subject to the client timeout.

`start`/`end` (and `--start`/`--end` through `hyperframes_cli`) make HyperFrames 0.9.43 use its segmented path, which ignores `workers` (automatic count, about frames/30 per chunk), renders WebGL in software (SwiftShader) even with `browserGpu: true`, and restarts Chrome for each chunk the range touches. The render job view then carries a `warnings` entry, and `hyperframes_cli` prefixes its output with `WARNING:`. Do not use range renders to measure speed or GPU benefit; render the whole composition instead.

Numeric parameters whose schema is "number or string" (`workers`, `fps`, `waitSeconds`, `logLines`) also accept digit strings such as `"4"`, because some clients send them that way.

## Verification

```bash
npm run check
npm run smoke
```

The smoke check starts an isolated loopback server and exercises real HTTP MCP calls, project creation, lint/check, snapshots, timeline, MP4 and HLS render jobs (submit, status polling, cancel, list), full FFmpeg decode, artifact download, binary upload/archive/Range/symlink-escape checks, local audio analysis, transcript import, the guide topics (served verbatim; the contract's example project passes lint and check and its snapshots show the mounted scenes), and error handling. It preserves media and reports in `workspace/verification/`. Chrome and FFmpeg must be installed. Speech/TTS model downloads are not part of the smoke check.

See [the version comparison and verification notes](docs/hyperframes-upgrade.md) for the upgrade scope and limits.

## Render.com storage limitation

The default Render filesystem is ephemeral. A project created during one running instance is not a permanent cloud drive and can disappear after instance replacement/redeploy. For serious production use, add persistent storage or object storage for project media and renders.

## Security

The service is designed to be easy to connect first. It has no authentication and is intended for trusted LAN clients; anyone who can reach it can upload into and download from any project. All file paths (MCP tools and HTTP routes) are resolved through symlinks and must stay inside the project. The advanced CLI accepts raw command arguments and is not a filesystem sandbox. If you expose it publicly, protect the MCP endpoint before using it with untrusted clients. Do not put private media, credentials, or secrets into project files.

## HyperFrames

HyperFrames is an HTML-native video framework/CLI. The server uses the installed npm package and its CLI rather than attempting to reimplement the rendering engine.
