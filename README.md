# HyperFrames MCP Server

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

The default listener is `0.0.0.0:9006`. All render work happens on the MCP host. No HeyGen login, official cloud render, or global HyperFrames installation is required. Chrome is auto-detected by HyperFrames, or set `PUPPETEER_EXECUTABLE_PATH` to your Chrome executable.

The client must support plain HTTP LAN MCP endpoints; a cloud-hosted client cannot directly reach a private LAN IP.

Configuration:

| Variable | Default |
| --- | --- |
| `HOST` | `0.0.0.0` |
| `PORT` | `9006` |
| `HF_WORKSPACE` | `<this-repo>/workspace/projects` |
| `HYPERFRAMES_BIN` | `<this-repo>/node_modules/.bin/hyperframes` |
| `HF_COMMAND_TIMEOUT_MS` | `900000` (15 minutes per command) |
| `PUPPETEER_EXECUTABLE_PATH` / `HYPERFRAMES_BROWSER_PATH` | Explicit browser override, otherwise auto-detect |
| `HF_MAX_UPLOAD_BYTES` | `1073741824` (1 GiB per upload request, file or archive) |
| `HF_MAX_EXTRACT_BYTES` | `2147483648` (2 GiB total extracted size per archive) |
| `HF_MAX_ARCHIVE_ENTRIES` | `10000` |
| `HF_REQUEST_TIMEOUT_MS` | `3600000` (time allowed to receive one HTTP request, including upload body) |
| `PUBLIC_BASE_URL` | Unset: download URLs use the request's `Host` / `X-Forwarded-*` headers. Set e.g. `https://hf.example.com` to force |

Health check:

`http://localhost:9006/health`

## Optional Render.com / Docker deployment

This repo also includes `Dockerfile` and `render.yaml`. This hosts the same MCP server on Render.com; it is separate from the HyperFrames official cloud render service. For a LAN deployment, use the local instructions above. The container uses `/workspace/projects` and the same locked npm dependency as the local server.

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

After connecting, Claude should discover tools such as:

- `hyperframes_version`
- `hyperframes_init`
- `hyperframes_info`
- `hyperframes_check` (preferred unified check)
- `hyperframes_snapshot`
- `hyperframes_timeline`
- `hyperframes_audio` (local signal analysis)
- `project_write_file`
- `project_read_file`
- `project_list_files`
- `hyperframes_lint`
- `hyperframes_validate`
- `hyperframes_compositions`
- `hyperframes_render`
- `hyperframes_transcribe`
- `hyperframes_tts`
- `hyperframes_catalog`
- `hyperframes_add`
- `hyperframes_docs`
- `hyperframes_doctor`
- `hyperframes_cli`

## Files and render lifecycle

Projects are retained under `HF_WORKSPACE/<project>/`. The MCP server does not create a new temporary project for each render. The CLI runs with that project as its working directory.

- Final output: by default `renders/<project>_<date>_<time>.<ext>` inside the project, or the explicit project-relative `output`.
- Snapshots: `.hyperframes/artifacts/snapshots/<unique-id>/`; check reports: `.hyperframes/artifacts/checks/`.
- Intermediate render work: on macOS/Windows, OS temp directory `hf-render-*`; on Linux, `work-<job-id>-*` next to the output. HyperFrames normally removes this work directory on success/failure. Debug mode, `KEEP_TEMP=1`, or an abrupt process/host failure can leave files behind.
- Extracted media cache: OS temp directory `hyperframes-extract-cache-<uid>` by default, reused across renders. Set render `framesCacheDir: "off"` to disable this cache for a render.
- A LAN client gets text/JSON results, then downloads files using `/artifacts/<project>/<relative-file>`. Files are not automatically copied to the client. `hyperframes_render` returns a second JSON content item listing the files it wrote with `url`, `size` and `sha256`. Use `project_list_files` to discover other media, including HLS segments and PNG sequence files.

## Binary files over HTTP

MCP tool calls carry text only: `project_write_file` / `project_read_file` handle UTF-8 text, and `project_read_file` refuses binary files. Images, audio, video and fonts move over plain HTTP routes next to `/mcp`, so the bytes never pass through the model's context. Paths are project-relative and percent-encoded per segment. The project must already exist (`hyperframes_init`).

| Route | Purpose |
| --- | --- |
| `PUT /files/<project>/<path>` | Upload one file; the body is the raw bytes. Parent directories are created. Returns `201` (new) or `200` (replaced) with `{ path, size, sha256, url }`. |
| `POST /archives/<project>[/<dir>]` | Upload a `tar` or gzip-compressed `tar.gz` and extract it into the project or `<dir>`. Returns every written file with `size`, `sha256` and `url`. |
| `GET` / `HEAD /artifacts/<project>/<file>` | Download. Supports single `Range` requests (`206` / `416`), `ETag` / `If-Range`, and UTF-8 filenames. |

Optional request headers for uploads: `X-Content-SHA256: <hex>` rejects the upload with `422` if the received bytes differ, and `If-None-Match: *` refuses to overwrite existing files (`412`). Oversized uploads get `413`. Uploads are written to a temporary file and renamed into place, so a failed or rejected upload never leaves a partial file.

Archives are read with the bundled `tar` npm package, so behaviour is identical on Linux and macOS and no system `tar` is needed. They are checked before extraction and again after it. Only regular files and directories are accepted: symlinks, hard links, devices, absolute paths and `..` paths cause the whole archive to be rejected (`400`) with nothing written. Total extracted size and entry count are limited (`413`), checked from the headers before anything is written.

```bash
BASE=http://<host>:9006
curl -T logo.png "$BASE/files/demo/assets/logo.png"
curl -H "X-Content-SHA256: $(sha256sum voice.wav | cut -d' ' -f1)" -T voice.wav "$BASE/files/demo/assets/voice.wav"
tar -czf assets.tgz -C ./assets . && curl --data-binary @assets.tgz "$BASE/archives/demo/assets"
curl -C - -o out.mp4 "$BASE/artifacts/demo/renders/out.mp4"   # resumable download
```

Rendering is synchronous: the tool waits for the CLI to finish and then returns its output. There is no persistent render queue or job-status API. The MCP client needs a timeout suitable for the video length, within the server command limit.

## Verification

```bash
npm run check
npm run smoke
```

The smoke check starts an isolated loopback server and exercises real HTTP MCP calls, project creation, lint/check, snapshots, timeline, MP4 and HLS renders, full FFmpeg decode, artifact download, binary upload/archive/Range/symlink-escape checks, local audio analysis, transcript import, and error handling. It preserves media and reports in `workspace/verification/`. Chrome and FFmpeg must be installed. Speech/TTS model downloads are not part of the smoke check.

See [the version comparison and verification notes](docs/hyperframes-upgrade.md) for the upgrade scope and limits.

## Render.com storage limitation

The default Render filesystem is ephemeral. A project created during one running instance is not a permanent cloud drive and can disappear after instance replacement/redeploy. For serious production use, add persistent storage or object storage for project media and renders.

## Security

The service is designed to be easy to connect first. It has no authentication and is intended for trusted LAN clients; anyone who can reach it can upload into and download from any project. All file paths (MCP tools and HTTP routes) are resolved through symlinks and must stay inside the project. The advanced CLI accepts raw command arguments and is not a filesystem sandbox. If you expose it publicly, protect the MCP endpoint before using it with untrusted clients. Do not put private media, credentials, or secrets into project files.

## HyperFrames

HyperFrames is an HTML-native video framework/CLI. The server uses the installed npm package and its CLI rather than attempting to reimplement the rendering engine.
