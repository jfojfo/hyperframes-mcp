# HyperFrames work loop (via hyperframes-mcp)

The order of MCP tools and HTTP calls for making or editing a video on this server. The rules the HTML
must follow are in topic `contract`: read it first. Everything runs on the MCP host; you have no shell
there. `<base>` below is the server's HTTP origin (the one serving `/mcp`).

## 1. Start

- New video: `hyperframes_init` with `name` (and `resolution`, `fps` if asked; default 1920x1080, 30 fps).
  It writes a blank `index.html`; read it with `project_read_file` and build on its `<head>`.
- Existing project: `hyperframes_timeline` (json: true) lists every clip with `absStart`/`absEnd`, its
  `file` and `ref`; `hyperframes_compositions` lists composition ids and durations. Read the files you
  will change before changing them.

## 2. Bring in media

- Binary files (images, video, audio, fonts) never go through MCP. Upload them into `assets/`:
  `PUT <base>/files/<project>/assets/<name>` with the raw bytes, or many at once with
  `POST <base>/archives/<project>` and a tar/tar.gz (no symlinks or hard links). The project must exist.
- Voiceover: `hyperframes_tts` (local Kokoro) writing to `assets/...`. Transcripts for captions:
  `hyperframes_transcribe`. Audio timing and loudness: `hyperframes_audio`.
- Ready-made effects, transitions, captions, charts, cards: `hyperframes_catalog`, then `hyperframes_add`.
  Search before hand-building any named visual.

## 3. Write

- Text files (HTML, CSS, JSON) with `project_write_file`: `index.html` plus one file per scene in
  `compositions/`. Follow `contract`.
- Timeline edits on an existing project (keeps the shape Studio writes): `hyperframes_cli` with
  `project`, `command: "timeline"` and `args` such as `["move", "#outro", "2.5", "--plan", "--json"]`,
  then the same without `--plan`. Verbs: `move <ref> <time>`, `trim`, `split`, `set`, `duplicate`,
  `delete`, `ids`. A refused edit still succeeds as a tool call: read `ok` in the JSON, and its `fix`
  when `ok` is false. An edit is refused when the clip would end past its composition: raise the
  root's `data-duration` first.

## 4. Check, then look

1. `hyperframes_lint` after the first pass and after structural changes.
2. `hyperframes_check` with `json: true` is the gate: fix every error, weigh every warning. While a lint
   error remains, layout and contrast audits don't run ("0 samples" means nothing was checked).
   Contrast failures carry a `suggestedColor`; `sweep_static` means 3 s+ with no visible change.
   A heavy page that times out: raise `timeout`.
3. `hyperframes_snapshot` with `at` (seconds) or `range`, `composition` for one scene, `json: true`.
   It returns `frames[].path` as absolute paths on the host under
   `.../<project>/.hyperframes/artifacts/snapshots/<id>/`; download each as
   `GET <base>/artifacts/<project>/.hyperframes/artifacts/snapshots/<id>/<file>.png` and look at it.
   `project_list_files` with `subdir: ".hyperframes/artifacts/snapshots"` lists their project paths.
   With scenes, snapshot the midpoint of every scene. Tiny unstyled content or a missing hero means a
   scene failed to mount (ids not matching, content outside `<template>`).
   A passing check does not show how it looks: always look before you report back or render.

## 5. Render

1. `hyperframes_render` returns a `jobId` at once. Use `quality: "draft"` while iterating and
   `"delivery"` (or `"high"`) for the final. Default output goes to `renders/`; set `output`
   (e.g. `renders/final.mp4`) to name it.
2. Poll `hyperframes_render_status` with `waitSeconds` (up to 30) until `succeeded`, `failed` or
   `cancelled`. A failure carries `error` and `logTail`; `hyperframes_render_cancel` stops a job.
3. On success, download each `artifacts[].url` with HTTP GET (Range supported), verify `size` and
   `sha256`, and check that the video's duration matches the root `data-duration`.

## 6. Finish

- Once every output you need is downloaded: `project_cleanup` deletes the project (scope `"project"`),
  or scope `"intermediate"` keeps sources and renders and drops snapshots, check reports and render
  leftovers. Never delete `.hyperframes` by hand while working: it holds the project's state.

## When something fails

| Symptom | Do |
| --- | --- |
| Chrome or FFmpeg missing, renders fail at start | `hyperframes_doctor`; report to the server operator |
| Upload returns 404 | Create the project with `hyperframes_init` first |
| Scene shows static frames, render waits 45 s per scene | Host id, scene root id and `__timelines` key differ (`contract` rule 12) |
| Clip never appears | Its window misses its parent's or the root's `data-duration`; check `hyperframes_timeline` warnings |
| Disk full on the host | `project_cleanup` with scope `"intermediate"` or on finished projects |
