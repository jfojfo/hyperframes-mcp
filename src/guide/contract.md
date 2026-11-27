# HyperFrames composition contract (via hyperframes-mcp)

Read this before writing or editing any composition HTML. HyperFrames renders HTML to video by seeking
paused timelines frame by frame; a composition that breaks these rules lints clean in places but renders
blank, frozen or late. Adapted from the upstream `hyperframes` skill for HyperFrames 0.9.43, for clients
that reach HyperFrames only through this MCP server. The order of tools is in topic `workflow`.

## Not for you in a project

- `AGENTS.md` / `CLAUDE.md` written by `hyperframes_init` describe upstream skills (`/hyperframes`, ...)
  and local `npx` / `npm run` commands. Those skills are not installed here and you have no shell on
  the host: use this topic, `workflow` and the MCP tools instead.
- Ignore CLI notices about missing or stale skills, `_meta.updateNotice` and "Bump it" upgrade hints:
  the server operator pins the HyperFrames version.

## Project layout

- `index.html` is the root composition: it declares the video's variables and mounts one scene per
  sub-composition file in `compositions/`. Media and fonts live in `assets/` (upload them over HTTP).
- A new video is 1920x1080 at 30 fps unless asked otherwise.
- Keep the scaffold's GSAP `<script>` tag in `index.html` (the host loads it from the CDN when it
  checks, snapshots and renders); scene files use the same global `gsap`.

## The rules

`hyperframes_check` (json: true) reports most violations with a `Fix:` line.

1. Every timed element has `class="clip"`, `data-start` and `data-duration` in seconds, and shows over
   `[start, start + duration)`: land an end state just before its end. `data-track-index` is only a
   Studio lane; paint order is `z-index`.
2. The video's length is the root's `data-duration`: anything past it is cut, an early end holds the
   last frame. Raise it when you add a clip that ends later (no tool changes it for you).
3. Each composition builds one paused timeline and registers it after its tweens:
   `window.__timelines["<data-composition-id>"] = tl`. Never `tl.play()`; never `add()` a scene's
   timeline to the root's (the runtime drives each scene itself).
4. Deterministic only: no `Date.now()`, unseeded `Math.random()`, network fetches, timers or
   `repeat: -1`. Everything visible is a function of timeline time.
5. Never tween `display`, `visibility` or `autoAlpha` on a `.clip`; animate a child (or its `opacity`).
6. No CSS `transform` on an element GSAP transforms (set the start state in `fromTo`); animate
   transforms, not `left`/`top`/`width`/`height`. Inside scenes use `fromTo`, not `from`.
7. Never `play()`, `pause()` or seek media. A `<video>` keeps its sound with `data-has-audio="true"`,
   else it is `muted`. Music, voiceover and replacement sound are a separate `<audio>`.
8. Every `<audio>` has an `id` or it is left out of the mix. No `crossorigin` on media. Time the
   `<video>` itself, never a wrapper around it.
9. Fonts: only Inter, Montserrat, Outfit, Nunito, Oswald, League Gothic, Archivo Black, Space Mono,
   IBM Plex Mono, JetBrains Mono, EB Garamond, Playfair Display, Source Code Pro, Noto Sans JP, Roboto,
   Open Sans, Lato and Poppins resolve by name. Any other family needs `@font-face` with
   `src: url('assets/fonts/<file>.woff2')` in the file that uses it (upload the font first).
10. Asset paths are `assets/...` with no leading `/`, in scene files too. Never reference URLs on the
    internet for media.
11. A scene file puts its styles, markup and scripts inside `<template>` (anything outside is dropped)
    and styles its root as `#root` with `position: absolute; inset: 0`. Only scene files use
    `<template>`; `index.html` never does.
12. The scene host in `index.html`, the scene's root and its `__timelines` key share one id. A
    mismatch makes every render wait 45 s per scene, then show static frames.
13. Ids are unique across the assembled page: prefix them per scene (`#intro-title`). A scene's
    timeline cannot reach elements outside its own file.
14. Grades, grain, blur and vignettes on footage go through `hyperframes_cli` with
    `command: "media-treatment"` (see its `--help` in `args`), never CSS filters on the media.
15. A root or host with no timeline at all (a still) gets `data-no-timeline`.
16. Intended overflow or overlap: `data-layout-allow-overflow` / `data-layout-allow-overlap` on the
    smallest element that needs it.

## Minimal two-scene project

`index.html` (keep the scaffold's `<head>` with its GSAP script):

```html
<body>
  <div id="root" data-composition-id="main" data-start="0" data-duration="6"
       data-width="1920" data-height="1080">
    <div id="intro" data-composition-id="intro" data-composition-src="compositions/intro.html"
         data-start="0" data-duration="3" data-track-index="1" data-track-kind="graphics"
         data-width="1920" data-height="1080"></div>
    <div id="outro" data-composition-id="outro" data-composition-src="compositions/outro.html"
         data-start="3" data-duration="3" data-track-index="1" data-track-kind="graphics"
         data-width="1920" data-height="1080"></div>
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    window.__timelines["main"] = gsap.timeline({ paused: true });
  </script>
</body>
```

`compositions/intro.html` (outro is the same shape with its own ids):

```html
<template>
  <style>
    #root { position: absolute; inset: 0; display: flex; align-items: center;
            justify-content: center; font-family: Inter; }
    #intro-title { color: #fff; font-size: 120px; font-weight: 700; }
  </style>
  <div id="root" data-composition-id="intro" data-width="1920" data-height="1080">
    <h1 id="intro-title" class="clip" data-start="0" data-duration="2.9">Hello</h1>
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.fromTo("#intro-title", { y: 40, scale: 0.94 }, { y: 0, scale: 1, duration: 0.6, ease: "power3.out" }, 0);
    tl.to("#intro-title", { scale: 1.08, duration: 2, ease: "none" }, 0.6);
    window.__timelines["intro"] = tl;
  </script>
</template>
```

## Timing details

- A scene's clock starts at 0 at its host's `data-start`; `data-start` is local to the file that
  declares it. A host's `data-duration` is the scene's slot.
- `<video>` / `<audio>` without `data-duration` play their full length; an `<img>` without one lasts 3 s.
  `data-media-start` trims into the source; `data-volume` (1 = 0 dB), `data-fade-in`, `data-fade-out`.
- `data-start="intro + 0.5"` starts 0.5 s after `intro` ends (spaces required); a typo silently
  resolves to 0, so snapshot what you time this way.
- Media that fills the frame: `position: absolute; left: 0; top: 0`, canvas width and height,
  `object-fit: contain` (or `cover`).
- Keep content inside the 90% action-safe box and text inside 80% title-safe.

## Variables

Declare `data-composition-variables` (a JSON array of `{id, type, label, default}`) on `index.html`'s
`<html>`; bind without script via `data-var-text="id"`, `data-var-src="id"` or `var(--id)` in CSS, or read
`window.__hyperframes.getVariables()` once at init. `hyperframes_render` `variables` overrides them;
`batch` renders one video per row. Details: topic `compositions`.

## More

The `hyperframes_docs` tool description lists the CLI reference topics (`compositions`,
`data-attributes`, `gsap`, ...). Keep the title or key image on screen at 0 s: the first frame is the
thumbnail, and `check` warns `first_frame_empty` otherwise. Before hand-building a named effect, transition, caption style,
chart or card, search the registry with `hyperframes_catalog` and install with `hyperframes_add`.
