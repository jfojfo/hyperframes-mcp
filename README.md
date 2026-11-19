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
- A LAN client gets text/JSON results, then downloads files using `/artifacts/<project>/<relative-file>`. Files are not automatically copied to the client. Use `project_list_files` to discover media, including HLS segments and PNG sequence files.

Rendering is synchronous: the tool waits for the CLI to finish and then returns its output. There is no persistent render queue or job-status API. The MCP client needs a timeout suitable for the video length, within the server command limit.

## Verification

```bash
npm run check
npm run smoke
```

The smoke check starts an isolated loopback server and exercises real HTTP MCP calls, project creation, lint/check, snapshots, timeline, MP4 and HLS renders, full FFmpeg decode, artifact download, local audio analysis, transcript import, and error handling. It preserves media and reports in `workspace/verification/`. Chrome and FFmpeg must be installed. Speech/TTS model downloads are not part of the smoke check.

See [the version comparison and verification notes](docs/hyperframes-upgrade.md) for the upgrade scope and limits.

## Render.com storage limitation

The default Render filesystem is ephemeral. A project created during one running instance is not a permanent cloud drive and can disappear after instance replacement/redeploy. For serious production use, add persistent storage or object storage for project media and renders.

## Security

The service is designed to be easy to connect first. It has no authentication and is intended for trusted LAN clients. The advanced CLI accepts raw command arguments and is not a filesystem sandbox. If you expose it publicly, protect the MCP endpoint before using it with untrusted clients. Do not put private media, credentials, or secrets into project files.

## HyperFrames

HyperFrames is an HTML-native video framework/CLI. The server uses the installed npm package and its CLI rather than attempting to reimplement the rendering engine.
