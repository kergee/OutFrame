# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this is

OutFrame (iOutBox) — a browser-based tool that turns a photo into a pseudo-3D "breaking the frame" effect: AI cuts out the foreground subject, overlays a photo frame, and renders the subject bursting past the frame's edges. Runs entirely client-side (no backend); also ships as a desktop app via Tauri. UI strings and comments in the source are Chinese.

## Commands

```bash
npm install          # install JS deps — must run BEFORE npm run download
npm run download     # download AI models into public/models/ (~140MB, one-time) AND copy ORT runtime files from node_modules into public/onnxruntime-web/
npm run dev           # start Vite dev server (http://localhost:5173) — REQUIRED; opening index.html directly will not work
npm run build         # production build (outputs to dist/)
npm run tauri:dev     # run as desktop app in dev mode (wraps npm run dev)
npm run tauri:build   # build desktop installers (.dmg/.msi/.exe/.AppImage) via Tauri/Rust
```

There is no test suite or linter configured in this repo.

Desktop release builds run via `.github/workflows/release.yml`, triggered by pushing a `v*` tag or manual dispatch; it builds Tauri binaries for macOS (Intel + Apple Silicon), Windows, and Linux and drafts a GitHub release.

## Why `npm run dev` is required

AI inference needs `SharedArrayBuffer`, which requires `Cross-Origin-Embedder-Policy: require-corp` / `Cross-Origin-Opener-Policy: same-origin` response headers. `vite.config.js` injects these for the dev server; the Tauri app injects the same headers via `src-tauri/tauri.conf.json` (`app.security.headers`). Opening `index.html` as a `file://` URL skips these headers and breaks model loading.

`vite.config.js` also excludes `onnxruntime-web` from `optimizeDeps` — this is deliberate (Vite pre-bundling breaks its WASM path resolution); don't remove it.

## Architecture

Everything lives in one page and one script — there's no framework, bundler-driven component tree, or router:

- `index.html` — all DOM structure/controls (upload zone, canvas, control panel) as static markup with `id`s that `js/app.js` binds to directly via `document.getElementById`.
- `js/app.js` (~1000 lines) — the entire app: state, event wiring, AI inference, and Canvas 2D compositing. It's organized top-to-bottom as one pipeline rather than split into modules; when editing, find the relevant `// ----` section header rather than assuming file-per-feature structure.
- `css/style.css` — all styling.

### Rendering pipeline (`js/app.js`)

1. **Upload** → `loadPhoto()` reads EXIF (`exif-js`, loaded via a jsdelivr CDN `<script>` in `index.html`, exposing the global `EXIF` — the only runtime network dependency; code degrades gracefully if it's absent), auto-detects camera brand from EXIF `Make`, auto-picks the closest aspect ratio (`autoSelectRatio`), then immediately kicks off background extraction in the background (doesn't wait for a button press).
2. **Subject extraction** (`extractSubject`) — runs `@imgly/background-removal` (ONNX `isnet_fp16`, loaded from local `public/models/` via `MODEL_PUBLIC_PATH`, not a CDN) to cut out the foreground, then separately runs Depth Anything V2 Small (`estimateDepth`, loaded lazily via dynamic `import('onnxruntime-web')` to avoid colliding with @imgly's own onnxruntime init) to get a depth map. `applyDepthToSubject` uses the depth map to fade the alpha of far-background subject pixels, exaggerating the "near subject pops out" illusion. These two ONNX sessions are run sequentially (background removal first, then depth) specifically to avoid initialization conflicts between two onnxruntime-web instances — don't parallelize them. Results are cached in `state.subjectImage` / `state.depthMap`; re-running only happens on explicit "regenerate" (forceRedo).
   - **WebGPU first, WASM fallback**: both models prefer WebGPU when `navigator.gpu` exists (`HAS_WEBGPU`) — @imgly via `device: 'gpu'` with a catch-and-retry on `'cpu'`, the depth session by trying execution providers `['webgpu']` then `['wasm']`. Keep the fallbacks; WebGPU init fails on some drivers and in headless Chromium.
   - **ORT runtime files** live in `public/onnxruntime-web/` and are copied from `node_modules/onnxruntime-web/dist` by the download script so they exactly match the dynamically-imported JS version. `_ort.env.wasm.wasmPaths` must point at `/onnxruntime-web/` — pointing it at `/models/` (the old bug) silently 404s and depth estimation gets skipped without any visible error.
   - **Race guard**: `photoGeneration` increments on every successful photo load; the in-flight extraction task captures its generation and re-checks it after every await and in its `finally` before touching `state` or UI. Without this, switching photos mid-extraction composites the old photo's subject onto the new photo. Preserve the `gen !== photoGeneration` checks when editing this function.
3. **Compositing** (`renderEffect`) — the core visual trick: the frame's "photo area" rectangle and a larger "total area" rectangle (photo area expanded by each side's overflow %) are computed once, and the *same* `drawImageCover` cover-fit math is applied to both layers so they stay aligned. `drawImageCover`'s source crop is subject-aware: it takes the subject's alpha bounding box (`state.subjectBox`, computed by `computeSubjectBox` after extraction) and shifts the crop window so cover-fit never amputates the subject (e.g. beheading a tall subject on a wide canvas); all draw calls in a render must pass the same box or the layers misalign.
   - The original photo is drawn clipped to the *inside* of the frame, blurred and dimmed via `ctx.filter` (depth-of-field background; degrades to unblurred where `ctx.filter` is unsupported).
   - The subject cutout (depth-faded via `applyDepthToSubject`, edge-feathered via `featherAlpha`) is drawn over the whole canvas — sharp subject over blurred background inside the frame, overlaying the border and extending beyond it outside. The layer is micro-scaled (~1.045×) around the photo center for perspective pop, with a two-pass shadow (wide soft + tight contact) drawn using the shadow-offset trick — the subject is painted one canvas-width off-canvas with `shadowOffsetX` shifting the shadow back; note shadow offsets ignore the CTM, hence the `POP` compensation.
   - `FRAME_CONFIGS` defines per-style (polaroid/classic/dark/minimal) color, default border widths, corner radius, and shadow. `ASPECT_RATIOS` maps ratio keys to fixed canvas pixel dimensions.
4. **Live preview**: any control change calls `renderEffect()` if a subject has already been generated, otherwise falls back to the plainer `renderPreview()` (just the original photo, no cutout) — check `state.generated` before assuming which render path is active.

### Models (`public/models/`, gitignored)

Fetched by `scripts/download-models.js`, not committed. Two sources: `@imgly/background-removal-data` CDN (background removal model + onnxruntime-web WASM) and a HuggingFace direct download (Depth Anything V2 Small, quantized). The script also copies the four ORT runtime files (`ort-wasm-simd-threaded*.{mjs,wasm}`) from `node_modules/onnxruntime-web/dist` into `public/onnxruntime-web/`, so it must run after `npm install`. If you touch model loading code, remember these files won't exist until `npm run download` has been run. The release CI workflow runs the download step (with an actions/cache on `public/models`) before building — removing it ships desktop binaries that can't run inference.

### Desktop shell (`src-tauri/`)

Thin Tauri v2 wrapper — `src-tauri/src/lib.rs`/`main.rs` are minimal (just bootstraps the Tauri window + shell plugin around the same web frontend). Config lives in `src-tauri/tauri.conf.json`. No native Rust logic beyond boilerplate; don't expect Rust-side business logic here.
