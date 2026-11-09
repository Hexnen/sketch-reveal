# sketch-reveal performance audit (2026-11-09, base commit 9a94f40)

Read-only measurement pass. No module file was changed; this file is the only output.
The implementer should keep every look, timing and choreography identical; each finding says what could change visibly.

Legend: **MEASURED** = number produced by a run described in section 4. **INFERRED** = derived from code reading or arithmetic,
not measured directly. **UNVERIFIED** = observed but root cause not proven.

---

## 1. Baseline

### 1.1 Machine and method

- Windows 11, RTX 3070 Ti, 16 GB RAM. Headless Edge (`--headless=new --use-angle=d3d11 --enable-gpu`), renderer
  `ANGLE (NVIDIA GeForce RTX 3070 Ti Direct3D11)`, viewport 1600x900, DPR 1, vsync about 165 Hz (6.1 ms frame interval).
- CPU slowdown through `Emulation.setCPUThrottlingRate` (1x and 6x). Throttling slows the renderer main thread only. GPU,
  workers and image decoders are not slowed, so 6x numbers are a lower bound for a weak laptop.
- Static harness: a scratch page (`probe.html`, appendix A) imports the real `scripts/player.mjs` and `scripts/config.mjs`
  and monkey-patches `toBlob`, `getImageData`, `texImage2D`, `generateMipmap`, `readPixels`, `getContext("webgl*")`,
  `URL.createObjectURL/revokeObjectURL` and a `longtask` observer. Prepare-phase times come from `RevealPlayer.onPhase`.
- Live Foundry: lane server 1 (port 30001, world `invincible`, Foundry 14.363), users `Test Gracz 1/2` and `claude` (GM).
  Startup is traced with the CDP Tracing domain (`devtools.timeline`, `v8`).
- Test images: `samples/ulica` 1024x572, `samples/miasto` 2752x1536, plus scratch upscales of miasto to
  4096x2286 (`big4k`, which needs no fit) and 5504x3072 (`big`, which takes the >4096 `fitImage` path).
- Variance: single runs unless stated. Repeats differed by roughly ±15%. Treat every number as an order of magnitude.

### 1.2 Prepare (time from `new RevealPlayer` to `prepare()` resolved). MEASURED, 1x, first run of each effect in a fresh profile

| effect | ulica 1024 | miasto 2752 | big 5504→4096 | longest main-thread task |
|---|---|---|---|---|
| spread | 280 ms | 338 ms | 2343 ms | 185 / 120 / 436 ms |
| speedpaint | 1273 ms | 227 ms | 1359 ms | **1073** / 118 / 326 ms |
| strokes | 689 ms | 906 ms | 2128 ms | 139 / 137 / 480 ms |
| watercolor | 1105 ms | 192 ms | 2240 ms | **1075** / 120 / 549 ms |

- The about 1 s tasks are cold shader compile and link (finding F4). The same effect in a second browser launch on the same
  profile takes 36–49 ms for `effect-created`, against 952–998 ms on the first launch.
- For "big", the `images-fitted` phase alone takes 888–1718 ms. That is the PNG round trip (finding F3).

**Full-fx preset** (spread + sketch intro + glow + sway live + title + residue 10, miasto 2752). Each row is a fresh
browser; `run1+` means the same page after one warm-up:

| case | prepare | longest task | of which `texImage2D(HTMLImageElement)` |
|---|---|---|---|
| miasto 1x cold (first in profile) | 2173 ms | 1058 ms | 171 ms |
| miasto 1x warm (run1, run2) | 801 / 731 ms | 412 / 394 ms | 179 / 173 ms |
| miasto 6x (run0–2) | 3694 / 3791 / 5598 ms | 2163 / 2221 / 3750 ms | 1170 / 1212 / 1992 ms |
| big4k 1x (run0, run1) | 3116 / 1939 ms | 1457 / 1220 ms | 577 / 597 ms |
| big4k 6x | 7538 ms | **5982 ms** | 3561 ms |

### 1.3 Texture upload microbench (`upload.html`). MEASURED, 1x unless noted

| image | `texImage2D(<img>)`, each call (repeat calls) | `texImage2D(ImageBitmap)` | `createImageBitmap(blob)` | pixel diff |
|---|---|---|---|---|
| 1024x572 | 8.0 (7.8, 7.8) ms | 0.7 ms | 7 ms | 0 |
| 2752x1536 | 52.6 (49.7, 48.5) ms | 7.5 ms | 40 ms | 0 |
| 4096x2286 | 116.9 (107.9, 115.2) ms | 13.1 ms | 91 ms | 0 |
| 5504x3072 | 205 (189, 188) ms | 25.7 ms | 153 ms | 0 |
| 4096x2286 at 6x | **829 / 834 / 844 ms** | **75 ms** | 182 ms (decode is off-thread) | 0 |

- An `<img>` upload is paid again on every `texImage2D`, even for the same element. Nothing is cached.
- `createImageBitmap(img)`, the in-thread conversion, costs 90 ms at 1x and 730 ms at 6x. `createImageBitmap(blob)` costs
  91 ms at 1x and 182 ms at 6x, because it decodes off the main thread.
- The >4096 resize path takes 557 ms for the PNG encode, 153 ms for the decode and 168 ms for the upload. The alternative,
  `createImageBitmap(canvas)` plus upload, takes 36 + 12 ms. The two paths are byte-identical (`maxDiff 0`).

### 1.4 Playback (per-frame JS). MEASURED

| preset | x | frames | rAF interval med / p95 / max | `_apply` med / p95 / max | long tasks during play |
|---|---|---|---|---|---|
| ulica spread + title | 1 | 2317 | 6.1 / 6.1 / 30 ms | 0.1 / 0.2 / 0.6 ms | 0 |
| miasto speedpaint | 1 | 1132 | 6.1 / 12.2 / 60 ms | 0.1 / 0.3 / 1.2 ms | 1 (65 ms) |
| baza watercolor + intro | 1 | 1751 | 6.1 / 6.1 / 103 ms | 0.2 / 0.5 / 3.1 ms | 1 (106 ms) |
| miasto full-fx (+3 s live tail) | 1 | 3214 | 6.1 / 6.1 / 36 ms | 0.2 / 0.5 / 1.3 ms; tail 0.1 ms | 0 |
| miasto strokes + glow from 60% | 1 | 1258 | 6.1 / 6.2 / 67 ms | 0.2 / 0.4 / 70.6 ms (glow.update 70 ms once) | 1 (71 ms) |
| miasto full-fx | 6 | 2647 | 6.1 / 12.1 / 303 ms | 0.3 / 2.7 / 75 ms | 6 (sum 483, max 151 ms) |

Per-layer medians (effect.render, intro.render, glow.update, residue.update, title.update, camera.update) are all
≤ 0.1 ms, with p95 ≤ 0.3 ms at 1x. The playback loop is not a JS bottleneck.

### 1.5 World load (every client, even when no reveal plays). MEASURED, live lane 1, user Test Gracz 1

- 29 files under `/modules/sketch-reveal/` with 924 KB decoded: `vendor/reveal-core.js` 343 KB, `fx/newspaper.mjs` 122 KB,
  `fx/ticker.mjs` 49 KB, `fx/title.mjs` 41 KB, and so on. The full module graph is loaded statically from `main.mjs`
  (apps, export, ticker-form, newspaper forms, ai-hints).
- Main thread: `v8.evaluateModule main.mjs` takes **8.2 ms at 1x and 44.6 ms at 6x**. Background parse takes 46–158 ms
  off-thread. Script compile time on the main thread is negligible.
- At 6x, the only idle callback in the trace window took **388 ms**. INFERRED: this is `warmNewspaperFont()` →
  `prewarmNewspaper` (`fx/newspaper.mjs:389`), which runs on every client at `ready`. Repeating the paint calls by hand
  without fonts gave a first `paintPage` of 117 ms at 1x and 1062 ms at 6x, and a first `paintModern` of 41 ms at 1x and
  246 ms at 6x.
- Foundry serves module and asset files with `Cache-Control: no-store` (checked with `curl -I`). This matters for F6.

### 1.6 Sync barrier (live, GM `claude`, preset `builtin-ulica`, 2 runs). MEASURED

- `settings.set("splashState")` round trip: 1–17 ms. Every live client finished `layers-ready` within 0.35–1.05 s.
- `go` was nevertheless sent after **90.5 s** in both runs: `READY_TIMEOUT_MS` expired. One listed-active user
  ("Gamemaster", or a second stale `claude` tab, probably another agent's headless session on the lane) never produced a
  counted `ready`. UNVERIFIED which client it was, or why.
- Start skew between clients after `go`: 0–4 ms (`started` events). The clock sync works well.

### 1.7 Repeated plays (leaks). MEASURED, harness, `cycle` = prepare → skip → dispose with no pause between

| scenario | live (not lost) WebGL contexts after each cycle | JS heap |
|---|---|---|
| 20 cycles, 4 effects, no glow/intro | 0 | returns to baseline |
| full-fx, 14 cycles | 3, 5, 7 … 15, 16, 16 (browser cap) | 58 → 121 MB; 15.5 MB 12 s later |
| glow only x4 | 5 | 30.8 MB; 5.1 MB 12 s later |
| intro only x4 (fresh page) | 5 | 76.7 MB |
| full-fx, but **overlay removed before `dispose()`** (simulated fix), 14 + 8 + 6 cycles | plateau **3–5**, 0 within 3 s | 15.5 MB 3 s later |

- Blob URLs: all revoked (`made == revoked`). Canvases and DOM nodes are fully removed.
- **Hang:** in 3 of 3 sessions that ran 8–14 full-fx or glow/intro cycles back to back, the page stopped responding, and
  page timers stopped firing too. CDP `Debugger.pause` caught JS only once. A browser launched fresh never hung on a single
  full play at 1x or 6x. With the simulated fix, the same sequence of 30 prepares did not hang.
  UNVERIFIED root cause; the leading hypothesis is WebGL context overflow (F1).

---

## 2. Findings, highest priority first

### F1. Glow and sketch-intro WebGL contexts are kept for 10 s after dispose, so a few replays hit the 16-context cap. Correctness and performance, **high**

- **Where:** `scripts/player.mjs:203-210` (`_teardownLayers`: `dispose()` first, then `this.cam.replaceChildren()`) and
  `player.mjs:412-422` (`dispose()`: `_teardownLayers()` before `this.frame.remove()`).
  Core: `src/reveal-core/sketchIntro/glContext.ts:35-37`. `GL_RELEASE_MS = { connected: 10_000, detached: 1_000 }`, and the
  delay is chosen from `canvas.isConnected` **at release time**. Callers are `glow/index.ts:430` and `sketchIntro/index.ts:264`.
  Effects use `effects/guard.ts`, which has a 50 ms delay and checks `isConnected` when the timer fires, so effects are not
  affected.
- **What:** the player disposes glow and intro while their canvases are still in the DOM, so each play keeps 2 extra live
  contexts for 10 s. At 16 contexts Chromium silently loses the **oldest** context on the page. In Foundry that is most
  likely the PIXI board canvas: `guard.ts:7-9` warns about exactly this. INFERRED for Foundry; not reproduced live.
- **Evidence:** table 1.7. With the cap reached, prepare also slowed from 670–760 ms to 1240–2070 ms, and heap stayed
  around 120 MB until release.
- **Fix:** detach before disposing. In `_teardownLayers`, take the children (or call `this.cam.replaceChildren()`) first,
  then call `dispose()` on effect, intro, glow and residue. In `dispose()`, also remove `this.frame` before
  `_teardownLayers`. Glow and intro then release after 1 s. A further option is to have the player call
  `WEBGL_lose_context` immediately, since its canvases are never reused. That needs care with `claimGlCanvas`.
- **Expected gain:** at most about 2 context leftovers per play for 1 s, instead of 10 s. Simulated fix: contexts plateau at
  3–5, heap is back to baseline within 3 s, and the hang did not reproduce.
- **Risk to look:** none. Teardown and rebuild happen in the same task. `_buildLayers` calls `_teardownLayers` immediately
  before appending the new canvases, with no frame in between. The auto-quality rebuild (`setPerf` → `_buildLayers`) goes
  through the same path. Check that no layer's `dispose()` needs the canvas connected, for example to read its size.
  Code reading found none.
- **Verify:** `s12/s13` recipe (section 4.4). After 14 rapid full-fx cycles, `ctx` stays ≤ 5, and `mem()` 3 s later shows
  `ctx: 0`. Live check: in Foundry, run "Play for me" on the full-fx preset 10 times quickly, then confirm
  `canvas.app.renderer.gl.isContextLost() === false`.

### F2. Every texture upload from `HTMLImageElement` costs 50–200 ms at 1x, up to about 0.8 s at 6x, and is repeated 2–3 times per prepare. **High**

- **Where:** player decodes to `<img>` in `scripts/player.mjs:29-36` (`loadImage`) and passes those elements everywhere.
  Upload sites: `effects/spread/renderer.ts:77`, `effects/strokes/glUtil.ts:35`, `effects/watercolor/index.ts:141`,
  `effects/speedpaint/instance.ts:126`, `glow/renderer.ts:170` (painted again), and `glow/backdrop.ts:106`. The sketch intro
  draws the `<img>` into a 2D canvas (`sketchIntro/index.ts:138-151`), which is cheaper but still rasterises the `<img>`.
- **What:** Chromium re-converts the `<img>` on every `texImage2D` (table 1.3: 52 → 50 → 49 ms for the same element). A
  pre-decoded `ImageBitmap` uploads 7–8x faster and is **pixel-identical**: `maxDiff 0` measured for opaque PNG at all sizes.
- **Evidence:** table 1.2. On miasto full-fx, `<img>` uploads take 171–179 ms of a 394–412 ms task at 1x, and 1.2–2.0 s at
  6x. On 4096 full-fx they take 577–597 ms at 1x and 3.56 s of a 5.98 s task at 6x.
- **Fix (two levels):**
  1. Decode with `fetch(url)` → `blob` → `createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "default" })`,
     which decodes off-thread. Pass the `ImageBitmap` to `effect.setImages`, `glow.setImage` and `intro.setSketch`. Core
     types already allow it (`types.ts:27 RevealImageSource = ImageBitmap | HTMLImageElement`). Keep a blob URL of the same
     blob for the residue `<img>` (`fx/residue.mjs:122` uses `sketchImage.src`; `residueMask` reads `currentSrc`). That
     avoids a second network fetch, which matters because Foundry serves `no-store`.
  2. Smaller alternative: keep the `<img>` for identity, and create an `ImageBitmap` once per image in `prepare()` for the
     upload sites. Every core upload site has to accept it, so the core needs a rebuild (`npm install && npm run build`,
     then delete `node_modules`).
  - Places that read `.naturalWidth/.naturalHeight` and need `.width` fallbacks: `player.mjs:40,128,130,197,227,229,257,259`,
    `effects/spread/analysis.ts:21` (falls through to `.width`, fine) and `spread/renderer.ts:54`. Places that already
    handle both: `fx/glow.mjs:210`, `strokes/glUtil.ts:98`, `speedpaint/instance.ts:42`, `watercolor/params.ts:49`.
  - `spread/prep.ts:30` has a cache signature that already supports `ImageBitmap`. Caches are per object (WeakMap), so
    nothing is lost.
- **Expected gain (INFERRED from 1.3 × upload counts):** main-thread prepare on miasto full-fx drops by about 150 ms at 1x
  and about 1.0–1.7 s at 6x. On 4096 full-fx, it drops by about 550 ms at 1x and about 3.3 s at 6x. Decode moves off-thread
  (182 ms against 730 ms at 6x for 4096).
- **Risk to look:** low. Every upload site sets `UNPACK_FLIP_Y_WEBGL=false` and `UNPACK_PREMULTIPLY_ALPHA_WEBGL=false`
  (grep `pixelStorei`). An `ImageBitmap` ignores those flags, so it must be created with `premultiplyAlpha:"none"` and the
  default orientation to match. Not verified: PNGs **with alpha**, JPEGs with EXIF orientation, and wide-gamut or ICC
  images (the intro sets `UNPACK_COLORSPACE_CONVERSION_WEBGL=NONE` at `sketchIntro/render.ts:110`; use
  `colorSpaceConversion:"none"` for bitmaps on that path).
- **Verify:** pixel-diff the effect canvas at p = 0 / 0.5 / 1 for each effect, before and after (`readPixels` on the effect
  canvas, as `upload.html` `readTex` does), plus a glow frame and an intro frame. Then rerun the section 4.2 full-fx
  prepare at 1x and 6x and compare `texImg` and `long.max`.

### F3. Images larger than 4096 px take a PNG encode and decode round trip: 0.9–1.7 s before any layer exists. **High for large maps, nothing for ≤ 4096**

- **Where:** `scripts/player.mjs:39-52` (`fitImage`: draw → `toBlob("image/png")` → blob URL → `loadImage`). The same
  pattern is in `canvasToImage` (`:54-59`), used when the sketch size differs from the painted image (`:131-136`), and in
  `blankImage` (`:61-67`), which builds a full-size white sheet as a PNG for intro overlap mode (`colorAt < 100`, as in
  builtin "baza"). Not measured separately; INFERRED to cost the same as the encode below for its size.
- **Evidence:** "big" (5504x3072): `toBlob` took 387–1164 ms per image, about 20 MB each, and `images-fitted` ended at
  888–1718 ms (table 1.2). Microbench: encode 557 ms + decode 153 ms + upload 168 ms, against 36 + 12 ms via
  `createImageBitmap(canvas)`. Byte-identical.
- **Fix:** produce the resized image as `createImageBitmap(canvas, { premultiplyAlpha: "none" })`, or resize directly with
  `createImageBitmap(blob, { resizeWidth, resizeHeight, resizeQuality: "high" })`. The second option may **not** be
  pixel-identical to canvas `imageSmoothingQuality:"high"`; not measured, so prefer the canvas version. This fits naturally
  with F2. For `blankImage`, use a white canvas or bitmap; no PNG is needed. Residue still needs a URL: create one lazily
  after ready (residue opacity is 0 until colour starts), or show the residue as a canvas.
- **Expected gain:** about 0.85–1.6 s less prepare per >4096 reveal at 1x (INFERRED: more at 6x because the PNG encode is
  partly on the main thread), and about 40 MB less transient blob memory.
- **Risk:** none for opaque images (pixel-identical). Verify alpha images.
- **Verify:** run `runPrep({set:'/__s/big'})` for each effect; `toBlob` must be empty and `images-fitted` < 100 ms.

### F4. Cold shader compile blocks the main thread for about 1 s on the first play per browser profile. **Medium**

- **Where:** synchronous `getShaderParameter(COMPILE_STATUS)` and `getProgramParameter(LINK_STATUS)` right after compile in
  `effects/speedpaint/gl.ts:9,28`, `watercolor/gl.ts:9,28`, `spread/renderer.ts:29,47` and `strokes/glUtil.ts:9,27`. The
  glow and intro programs do the same.
- **Evidence:** first launch on a fresh profile: speedpaint `effect-created` 998 ms, watercolor 952 ms, both single long
  tasks. Second launch on the same profile: 36 ms and 38 ms (Chromium's GPU program disk cache). Full-fx cold:
  1058 ms long task, against 394–412 ms warm.
- **Fix options:** (a) use `KHR_parallel_shader_compile`: compile all programs, poll `COMPLETION_STATUS_KHR` across frames,
  and only then query status. Prepare is already async, so this fits `whenReady`. (b) Compile the programs of the preset's
  effect in an idle callback when a scene or preset that needs them is known (`updateScene` preload hook), not at world load.
- **Expected gain:** removes a one-time freeze of about 1 s at 1x per machine (and per shader change). Total prepare time is
  unchanged.
- **Risk:** none to the look. The code needs more await points.
- **Verify:** use a fresh `--user-data-dir` each run (`drive.py` default) and compare `long.max` on the first prepare of each
  effect.

### F5. `_buildLayers` runs as one synchronous block, so Foundry freezes for 0.4 s at 1x and up to 6 s at 6x during the barrier. **Medium (pairs with F2)**

- **Where:** `scripts/player.mjs:213-279`. From `Core.getEffect().create` through residue, glow, intro and `_seam` there is
  no `await` until `Promise.all(waits)`. Only the `blankImage` await in overlap mode breaks it.
- **Evidence:** full-fx miasto warm has a single 394–412 ms task at 1x and 2.2–3.7 s at 6x. 4096 has 1.2 s at 1x and 6.0 s
  at 6x. The UI, chat and the token layer are frozen while every client prepares behind the curtain.
- **Fix:** yield (for example `await new Promise(requestAnimationFrame)`, or `scheduler.yield()` where available) between
  effect creation, `setImages`, residue, glow creation and intro creation and `_seam`. Re-check `stale()` after each await,
  as the code already does after `blankImage`.
- **Expected gain:** total time is unchanged, but the longest task shrinks to the biggest single step. After F2 that is
  INFERRED at about 100 ms at 1x.
- **Risk:** none to the look. Everything is hidden (`sr-loading` hides the stage, transitions sit behind the cover).
  Ordering bugs with `this._gen` are possible; keep the `stale()` checks.
- **Verify:** `long.max` in the section 4.2 full-fx prepare.

### F6. `preloadImages` loads without CORS, so the real CORS load re-requests and re-decodes. **Medium (transition start latency)**

- **Where:** `scripts/play.mjs:41-44`. Player loads use `crossOrigin="anonymous"` (`player.mjs:32`).
- **Evidence (live Foundry, lane 1, 2 clean runs):** preload without CORS followed by the real load: a second request with
  a 300 B transfer and **135–297 ms** to decode the 2752 px sketch again. Preload with CORS followed by the real load:
  **1–2 ms**, no request. Foundry sends `Cache-Control: no-store`, so the HTTP cache does not help either way.
- **Fix:** add `img.crossOrigin = "anonymous"` in `preloadImages`. The same-origin filter is already there. If F2 switches to
  fetch → `ImageBitmap`, change the preload to match: keep the blob or bitmap in a small URL-keyed LRU, so that the
  transition prepare is a cache hit.
- **Expected gain:** about 130–300 ms less prepare per 2752 px image, with 2 images per transition. INFERRED: more for
  4096 images.
- **Risk:** none. Cost: decoded bitmaps stay resident for a while (about 17 MB per 2752 px image). Not verified: how long
  Blink keeps the decoded entry when the preload happened minutes before the transition. The test gap was 300 ms.
- **Verify:** `xpre.txt` recipe (section 4.5).

### F7. Main-thread pixel readbacks in prepare. **Low–medium**

MEASURED `getImageData` costs per prepare, miasto full-fx:

- sketch-intro analysis key `sketchIntro/analysisCache.ts:30-39`: drawImage plus read at 1584x884 runs on **every** prepare,
  even on an IndexedDB hit, because the key is a hash of the ink. It costs 37–39 ms at 1x and **265–561 ms at 6x**.
  - Fix: do the draw and read in the existing worker (`sketchIntro/worker.ts`) from an `ImageBitmap` (F2), or cache the key
    per URL.
- `player.mjs:286-298` (`_seam`) reads the full-resolution effect canvas: 21–47 ms at 1x, 50–142 ms at 6x. Needed for the
  seam; options are a `readPixels` straight from the effect's GL context, or an async PBO. Leave it if F2 and F5 land.
- `sketchIntro/index.ts:151` lazy `srcPx` full-resolution read: 21–38 ms at 1x, 39–102 ms at 6x.
- glow analysis `glow/analyze.ts:48` at 768x429: 43 ms on the first call in a session, 1.5–2.7 ms afterwards (decode
  warm-up). Leave it.

### F8. Every client runs the newspaper prewarm at world load and downloads the whole module graph. **Low**

- **Where:** `scripts/main.mjs:56` (`warmNewspaperFont()` on every client) and `main.mjs:2-12`, which statically imports
  apps, export, ticker-form, newspaper forms and ai-image.
- **Evidence:** section 1.5. The idle task is about 388 ms at 6x (INFERRED attribution) and the download is 924 KB per client.
  Main-thread eval is only 8 ms at 1x and 45 ms at 6x.
- **Fix:** (a) prewarm only when a newspaper preset exists, or when the active or viewed scene resolves to a newspaper
  (`resolveNewspaperFor`). (b) Use `import()` for `apps.mjs` (manager, editor, export) and the form modules from their
  entry points (scene control button, `renderSceneConfig`, `hotbarDrop`), because players never open them.
- **Gain:** about 0.4 s of idle-time CPU at 6x per client, and about 300–400 KB less download for players (INFERRED from
  file sizes).
- **Risk:** (a) a newspaper on a client that skipped the prewarm stutters on its first frame. That is exactly what the
  prewarm exists for, so gate it, don't remove it. (b) none to the look.

### F9. Export renders a fresh SVG snapshot of the title on every frame, even when it is unchanged. **Low**

- **Where:** `scripts/fx/export.mjs:315-341` (`titleImage`), called per frame at `:409-413`.
- **Evidence:** 1280 px at 30 fps, 193 frames: export 5.32 s total, SVG decode 850 ms, serialize 111 ms and 4136
  `getComputedStyle` calls. **64 of 140** SVG strings were identical to the previous frame.
- **Fix:** keep the last `svg` string and decoded `img`; reuse them when the string is identical. The output is identical by
  construction.
- **Gain:** about 0.35–0.45 s per export (about 8%). Offline only.

### F10. Sync barrier: one silent "active" client holds everyone for the full 90 s. **Behaviour change, flag only**

- **Where:** `scripts/play.mjs:244-277` and `READY_TIMEOUT_MS = 90000` at `:12`.
- **Evidence:** section 1.6. All responding clients were ready within about 1 s, but `go` came at 90.5 s.
- **Option:** stop waiting for a user who sent **no** `phase` message at all within N seconds. Clients send `start` within
  milliseconds of `prepare` arriving, so silence means a missing module, a dead socket or a ghost session. Keep the 90 s
  wait for clients that are slow but reporting, such as during cold vectorisation. This changes when splashes start, so the
  user decides.

---

## 3. No change needed (measured or reviewed, leave alone)

- **Playback loop and every fx layer per frame** (`player.mjs:359-380`, `fx/glow.mjs` update, `fx/camera.mjs`, `fx/residue.mjs`,
  `fx/title.mjs:662-685`): medians ≤ 0.1 ms and `_apply` p95 ≤ 0.5 ms at 1x (2.7 ms at 6x). These are already dirty-checked
  and write styles only on change. The glow coverage gate already avoids GPU readback for spread and uses a worker for the
  other effects.
- **Live tail** (glow life, sway live): about 30 fps, 0.1 ms per tick.
- **`fx/perf.mjs`**: frame gate, FPS meter and auto-quality are off by default and cheap (`setInterval` 250/500 ms only when
  enabled). Do not change the defaults. `preview:"full"` is lossy to change.
- **Blob URLs, DOM nodes, `ResizeObserver`, timers:** all released on dispose (table 1.7: made == revoked, canvases 0).
  The residue mask worker is terminated per build.
- **Clock sync and start skew** (0–4 ms) and the `settings.set` round trip (≤ 17 ms).
- **Startup main-thread cost** apart from F8: 8 ms module eval. Style sheets parse in under 2 ms.
- **Effects' own context release** (`effects/guard.ts`): 50 ms, correct.
- **Newspaper and ticker:** re-checked only through startup (F8) and the live trace. No other cheap leftovers seen. The rest
  was optimised in 9a94f40.
- **Manager thumbnails** (`templates/manager.hbs:16,56`) load the full painted image for a 96 px thumbnail with
  `loading="lazy"`. The cost is a one-time decode while the window is open. Not measured, ignore unless users report it.

Observed but **UNVERIFIED**, not to be acted on blindly:
- strokes + glow from 60%: wall time from `play()` to finished was 11.1 s against a 9.4 s timeline at 1x. rAF intervals
  never exceeded 67 ms, so this is unexplained.
- Even with the F1 simulation, cycles 10–12 took 2.4–6.9 s to prepare. `images-loaded` was 0.5–1.2 s at a heap of about
  100–140 MB, so GC or GPU memory pressure is likely. This was only seen in the back-to-back stress loop.

---

## 4. Reproducible measurement recipe

All scripts are in appendix A. Put them in a scratch folder **outside** the module, for example `%TEMP%\sr-perf\`. Needs Python 3 with
`websocket-client` and `Pillow`, plus Edge at `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`. In Git
Bash, prefix commands that pass `/modules/...` arguments with `MSYS_NO_PATHCONV=1`, or MSYS rewrites them into Windows
paths.

### 4.1 Setup
```bash
cd "$TEMP/sr-perf"
python serve.py 8853 &          # module dir at /, scratch dir at /__s/
python -c "from PIL import Image;import os
src=r'C:/Users/santa/AppData/Local/FoundryVTT/Data/modules/sketch-reveal/samples/miasto/%s.png'
for d,s in [('big',(5504,3072)),('big4k',(4096,2286))]:
  os.makedirs(d,exist_ok=True)
  [Image.open(src%k).convert('RGB').resize(s,Image.LANCZOS).save(f'{d}/{k}.png') for k in ('painted','sketch')]"
```
`drive.py URL steps.json [throttle]` launches a fresh headless Edge on a random debug port, runs each step's JS
(`{"label","js","throttle","gc"}`) and prints one JSON line per step. Set `SRPROF=<dir>` to reuse a profile, which tests
the warm shader cache (F4).

### 4.2 Prepare and uploads (F2, F3, F4, F5, F7)
Example step JS:
```js
runPrep({set:'miasto', cfg:{effectId:'spread',intro:{enabled:true,seconds:4,colorAt:100},glow:{enabled:true},
  sway:{enabled:true,live:true},title:{enabled:true,text:'Miasto'}}})
 .then(v=>({prep:v.prepMs, ph:v.phases, long:v.long,
   texImg:sum(v.tex.filter(t=>t.src==='HTMLImageElement').map(t=>t.ms)), toBlob:v.toBlob, gid:v.gid}))
```
Run it three times per session (cold, then warm) at throttle 1 and 6. Use sets `ulica`, `miasto`, `/__s/big4k` and
`/__s/big`, and loop `effectId` over spread, speedpaint, strokes and watercolor. Upload microbench: `upload.html`, steps
`bench('/samples/miasto/painted.png')`, `bench('/__s/big4k/painted.png')` and `bench('/__s/big/painted.png')`.

### 4.3 Playback
`runPlay({set, cfg, tailMs:3000})`. It returns rAF interval stats, `_apply` and per-layer stats, long tasks, and the
`tex`, `rp` and `gid` events recorded during play. Wrap it in a `Promise.race` with a watchdog, because the page can hang
(see 1.7).

### 4.4 Leaks (F1)
```js
// current behaviour (dispose while attached)
(async()=>{const x=await runPrep({set:'miasto',keep:true,cfg:FULL}); __p.skip();
  await new Promise(r=>requestAnimationFrame(r)); __p.dispose(); __o.remove(); return mem()})()
// simulated fix (detach first): swap to  __o.remove(); __p.dispose();
```
Run 14 steps of either form, then `new Promise(r=>setTimeout(()=>r(mem()),3000))` with `"gc":true`. `mem()` reports
`ctx` (live WebGL contexts), `heapMB`, `blobsOpen` and `canvases`. Pass criterion after F1: `ctx` ≤ 5 during the loop and
0 after 3 s, with no hang.

### 4.5 Live Foundry (startup, preload, sync)
- Lane lease: `multi-foundry.ps1 lease 1 -agent <name> -ttl 120`, and `release 1 -agent <name>` when done. Never use
  port 30000.
- Startup trace: `MSYS_NO_PATHCONV=1 python fstart.py http://127.0.0.1:30001 "Test Gracz 1" 1 /modules/sketch-reveal/`.
  It joins as the user, traces from the Join click until `game.ready` + 6 s, and prints resource sizes. It saves
  `lasttrace.json`; `python atrace.py lasttrace.json` sums `v8.evaluateModule`, `v8.parseOnBackground` and the rest per file.
  The optional 5th argument is JS to run after `ready`.
- Preload check: the `xpre.txt` JS as the 5th argument. It compares a no-CORS preload followed by a CORS load against a
  CORS preload followed by a CORS load, and calls the module's own `preloadImages`.
- Sync: as GM `claude`, use the `xsync.txt` JS. It wraps `game.settings.set`, listens to `sketchReveal.phase` and calls
  `api.showToAll('builtin-ulica')`. Check first which users are active; stale sessions skew `goAt` (1.6).
- Hang diagnostics: `hang.py URL "JS" throttle seconds [preJS]` runs the step without blocking and pauses the debugger every
  8 s to print the JS stack.

The original scratch copies of everything (`fstart.py`, `atrace.py`, `hang.py`, `export.html`, `xpre.txt`, `xsync.txt`,
the step files `s*.json` and raw results `r*.txt`) are in
`C:\Users\santa\AppData\Local\Temp\claude\48dc353776a1781e\3ba048d3-c1d5-4a78-b784-6f552dd60093\scratchpad\perf\`.
That folder is temporary; appendix A has the core ones.

---

## Appendix A. Core scripts

### serve.py
```python
"""Static server: module dir at /, this scratch dir at /__s/.  usage: python serve.py PORT"""
import sys, os, http.server, socketserver, mimetypes
MOD = r"C:\Users\santa\AppData\Local\FoundryVTT\Data\modules\sketch-reveal"
S = os.path.dirname(os.path.abspath(__file__))
mimetypes.add_type("text/javascript", ".mjs"); mimetypes.add_type("text/javascript", ".js")
class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm"}
    def translate_path(self, path):
        p = path.split("?")[0].split("#")[0]
        if p.startswith("/__s/"):
            return os.path.join(S, p[5:].replace("/", os.sep))
        return os.path.join(MOD, p.lstrip("/").replace("/", os.sep))
    def log_message(self, *a): pass
    def end_headers(self):
        self.send_header("Cache-Control", "max-age=3600")
        super().end_headers()
class T(socketserver.ThreadingMixIn, http.server.HTTPServer): daemon_threads = True
T(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
```

### drive.py
```python
"""Drive headless Edge (GPU) against a page and run JS steps.
usage: python drive.py URL STEPS.json [throttle] [W H]   (env SRPROF=<dir> reuses a profile)"""
import sys, json, time, subprocess, tempfile, urllib.request, random, shutil, os
import websocket
url, steps = sys.argv[1], json.load(open(sys.argv[2], encoding="utf-8"))
thr = float(sys.argv[3]) if len(sys.argv) > 3 else 1
W = int(sys.argv[4]) if len(sys.argv) > 4 else 1600
H = int(sys.argv[5]) if len(sys.argv) > 5 else 900
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
prof = os.environ.get("SRPROF") or tempfile.mkdtemp(prefix="srprof")
port = random.randint(20000, 29000)
p = subprocess.Popen([EDGE, "--headless=new", f"--remote-debugging-port={port}", f"--user-data-dir={prof}", f"--window-size={W},{H}",
                      "--hide-scrollbars", "--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-precise-memory-info",
                      "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(50):
        try:
            tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json")); break
        except Exception:
            time.sleep(0.2)
    tab = [t for t in tabs if t["type"] == "page"][0]
    ws = websocket.create_connection(tab["webSocketDebuggerUrl"], max_size=None); ws.settimeout(900)
    n = [0]; cons = []
    def call(m, prm=None):
        n[0] += 1; rid = n[0]; ws.send(json.dumps({"id": rid, "method": m, "params": prm or {}}))
        while True:
            x = json.loads(ws.recv())
            if x.get("method") == "Runtime.consoleAPICalled":
                a = x["params"]["args"]; cons.append(x["params"]["type"] + ": " + " ".join(str(v.get("value", v.get("description", "")))[:200] for v in a))
            if x.get("method") == "Runtime.exceptionThrown": cons.append("EXC: " + json.dumps(x["params"]["exceptionDetails"])[:300])
            if x.get("id") == rid: return x
    def ev(e):
        r = call("Runtime.evaluate", {"expression": e, "awaitPromise": True, "returnByValue": True})
        if "exceptionDetails" in r.get("result", {}): return {"error": r["result"]["exceptionDetails"].get("exception", {}).get("description", "")[:500]}
        return r.get("result", {}).get("result", {}).get("value")
    call("Runtime.enable"); call("Page.enable"); call("HeapProfiler.enable")
    call("Emulation.setDeviceMetricsOverride", {"width": W, "height": H, "deviceScaleFactor": 1, "mobile": False})
    call("Page.navigate", {"url": url})
    for _ in range(100):
        time.sleep(0.2)
        if ev("!!window.__ok") is True: break
    for s in steps:
        t = s.get("throttle", thr)
        call("Emulation.setCPUThrottlingRate", {"rate": t})
        if s.get("gc"):
            call("HeapProfiler.collectGarbage"); time.sleep(0.3); call("HeapProfiler.collectGarbage")
        t0 = time.time(); v = ev(s["js"])
        print(json.dumps({"label": s.get("label", ""), "throttle": t, "sec": round(time.time() - t0, 2), "v": v}, ensure_ascii=False), flush=True)
    warn = [c for c in cons if "WebGL" in c or "EXC" in c or "error" in c.lower() or "warn" in c.lower()]
    print(json.dumps({"label": "console-warnings", "v": warn[:30]}, ensure_ascii=False))
    ws.close()
finally:
    p.kill(); time.sleep(0.5)
    if not os.environ.get("SRPROF"): shutil.rmtree(prof, ignore_errors=True)
```

### probe.html (served at `/__s/probe.html`)
```html
<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="/styles/reveal.css">
<style>html,body{margin:0;height:100%;background:#222}</style>
<body>
<script>
window.T = { toBlob: [], gid: [], tex: [], mip: [], rp: [], long: [], ctx: [], blobs: new Set(), blobMade: 0, blobRevoked: 0 };
(() => {
  const P = HTMLCanvasElement.prototype, oTB = P.toBlob;
  P.toBlob = function (cb, type, q) {
    const t0 = performance.now(), w = this.width, h = this.height;
    oTB.call(this, (b) => { T.toBlob.push({ w, h, type: type || "image/png", ms: +(performance.now() - t0).toFixed(1), kb: b ? Math.round(b.size / 1024) : 0 }); cb(b); }, type, q);
  };
  const oGID = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function (x, y, w, h) {
    const t0 = performance.now(); const r = oGID.apply(this, arguments);
    if (w * h > 4096) T.gid.push({ w, h, ms: +(performance.now() - t0).toFixed(1), at: ((new Error().stack || "").split("\n")[2] || "").trim().slice(0, 140) });
    return r;
  };
  const C = WebGL2RenderingContext;
  const oT = C.prototype.texImage2D, oM = C.prototype.generateMipmap, oR = C.prototype.readPixels;
  C.prototype.texImage2D = function () {
    const t0 = performance.now(); const r = oT.apply(this, arguments); const ms = performance.now() - t0;
    const src = arguments[arguments.length - 1];
    if (ms > 0.5) T.tex.push({ ms: +ms.toFixed(1), src: src && src.constructor ? src.constructor.name : String(src), w: (src && (src.naturalWidth || src.width)) || arguments[3], h: (src && (src.naturalHeight || src.height)) || arguments[4] });
    return r;
  };
  C.prototype.generateMipmap = function () { const t0 = performance.now(); const r = oM.apply(this, arguments); const ms = performance.now() - t0; if (ms > 0.5) T.mip.push(+ms.toFixed(1)); return r; };
  C.prototype.readPixels = function () { const t0 = performance.now(); const r = oR.apply(this, arguments); const ms = performance.now() - t0; if (ms > 0.5) T.rp.push({ ms: +ms.toFixed(1), w: arguments[2], h: arguments[3] }); return r; };
  const oGC = P.getContext;
  P.getContext = function (k, o) { const c = oGC.call(this, k, o); if (c && /webgl/.test(k) && !this.__srT) { this.__srT = 1; T.ctx.push(new WeakRef(c)); } return c; };
  const oC = URL.createObjectURL, oRv = URL.revokeObjectURL;
  URL.createObjectURL = function (b) { const u = oC.call(URL, b); T.blobMade++; T.blobs.add(u); return u; };
  URL.revokeObjectURL = function (u) { if (T.blobs.delete(u)) T.blobRevoked++; return oRv.call(URL, u); };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) T.long.push({ t: Math.round(e.startTime), ms: Math.round(e.duration) }); }).observe({ type: "longtask", buffered: true }); } catch (e) {}
})();
window.liveCtx = () => T.ctx.map((r) => r.deref()).filter((c) => c && !c.isContextLost()).length;
window.resetT = () => { T.toBlob = []; T.gid = []; T.tex = []; T.mip = []; T.rp = []; T.long = []; };
const sum = (a) => +a.reduce((s, x) => s + x, 0).toFixed(1);
const st = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), q = (k) => +s[Math.min(s.length - 1, Math.floor(k * (s.length - 1)))].toFixed(2); return { n: s.length, med: q(0.5), p95: q(0.95), max: +s[s.length - 1].toFixed(2), mean: +(sum(s) / s.length).toFixed(2) }; };
window.st = st; window.sum = sum;
</script>
<script type="module">
import { RevealPlayer } from "/scripts/player.mjs";
import { sanitizeConfig, deepMerge } from "/scripts/config.mjs";
const raf = () => new Promise((r) => requestAnimationFrame(r));
function mkStage() {
  const o = document.createElement("div"); o.className = "sketch-reveal-overlay sr-splash";
  const s = document.createElement("div"); s.className = "sr-stage"; o.append(s); document.body.append(o); return { o, s };
}
const url = (set, k) => (set.startsWith("/") || set.startsWith("http") ? `${set}/${k}.png` : `/samples/${set}/${k}.png`);
const longOf = () => ({ n: T.long.length, sum: sum(T.long.map((x) => x.ms)), max: Math.max(0, ...T.long.map((x) => x.ms)) });
window.runPrep = async (opts = {}) => {
  resetT();
  const { o, s } = mkStage();
  const ph = [];
  const cfg = sanitizeConfig(deepMerge({ effectId: "spread" }, opts.cfg || {}));
  const t0 = performance.now();
  const p = new RevealPlayer({ container: s, sketchUrl: url(opts.set || "ulica", "sketch"), paintedUrl: url(opts.set || "ulica", "painted"), config: cfg, fit: "contain", perf: opts.perf, onPhase: (n, ms) => { ph.push([n, ms]); window.__lastPh = ph; } });
  await p.prepare();
  const prepMs = Math.round(performance.now() - t0);
  await raf(); await raf();
  window.__p = p; window.__o = o;
  const res = { prepMs, firstPaint: Math.round(performance.now() - t0), W: p.W, H: p.H, phases: ph, toBlob: T.toBlob, gid: T.gid, tex: T.tex, mip: T.mip, rp: T.rp, long: longOf(), ctx: liveCtx(), total: +p.total.toFixed(2) };
  if (!opts.keep) { p.dispose(); o.remove(); }
  return res;
};
window.runPlay = async (opts = {}) => {
  const r = await runPrep({ ...opts, keep: true });
  const p = window.__p, o = window.__o;
  const L = { effect: [], intro: [], glow: [], residue: [], title: [], cam: [], apply: [] };
  const wrap = (obj, fn, arr) => { if (!obj || !obj[fn]) return; const f = obj[fn].bind(obj); obj[fn] = (...a) => { const t = performance.now(); const v = f(...a); arr.push(performance.now() - t); return v; }; };
  wrap(p.effect, "render", L.effect); wrap(p.intro, "render", L.intro); wrap(p.glow, "update", L.glow); wrap(p.residue, "update", L.residue);
  wrap(p.title, "update", L.title); wrap(p.cameraCtl, "update", L.cam);
  const oa = p._apply.bind(p); p._apply = (...a) => { const t = performance.now(); oa(...a); L.apply.push(performance.now() - t); };
  resetT();
  const iv = []; let last = 0, stop = false;
  const loop = (t) => { if (last) iv.push(t - last); last = t; if (!stop) requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  const t0 = performance.now();
  const dur = opts.maxSec ? Math.min(opts.maxSec, p.total) : p.total;
  const pr = p.play();
  await Promise.race([pr, new Promise((res) => setTimeout(res, dur * 1000 + 200))]);
  const wall = performance.now() - t0;
  const nPlay = L.apply.length;
  await new Promise((res) => setTimeout(res, opts.tailMs ?? 0));
  stop = true;
  const out = { prep: r.prepMs, total: r.total, wall: Math.round(wall), frames: iv.length, interval: st(iv), apply: st(L.apply.slice(0, nPlay)), tailApplies: L.apply.length - nPlay, tailApply: st(L.apply.slice(nPlay)) };
  for (const k of ["effect", "intro", "glow", "residue", "title", "cam"]) out[k] = st(L[k]);
  out.long = longOf(); out.tex = T.tex.slice(0, 12); out.rp = T.rp.slice(0, 12); out.gid = T.gid.slice(0, 12);
  p.dispose(); o.remove();
  return out;
};
window.cycle = async (n, opts = {}) => {
  for (let i = 0; i < n; i++) {
    await runPrep({ ...opts, keep: true });
    window.__p.skip(); await raf(); await raf();
    window.__p.dispose(); window.__o.remove(); window.__p = window.__o = null;
    await new Promise((res) => setTimeout(res, opts.gapMs ?? 50));
  }
  return mem();
};
window.mem = () => ({ heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1), ctx: liveCtx(), blobsOpen: T.blobs.size, blobMade: T.blobMade, blobRevoked: T.blobRevoked, canvases: document.querySelectorAll("canvas").length, nodes: document.getElementsByTagName("*").length });
window.__ok = true;
</script>
```

### upload.html (served at `/__s/upload.html`)
```html
<!doctype html>
<meta charset="utf-8">
<body>
<script type="module">
const load = async (u, cors = true) => { const i = new Image(); if (cors) i.crossOrigin = "anonymous"; i.decoding = "async"; i.src = u; await i.decode(); return i; };
const gl = document.createElement("canvas").getContext("webgl2");
gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
const up = (src) => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); const t0 = performance.now(); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src); const ms = performance.now() - t0; gl.finish(); const ms2 = performance.now() - t0; gl.deleteTexture(t); return [+ms.toFixed(1), +ms2.toFixed(1)]; };
const readTex = (src) => {
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
  const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height, px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb); gl.deleteTexture(t); return px; };
const diff = (a, b) => { let m = 0, n = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) { n++; if (d > m) m = d; } } return { maxDiff: m, nDiff: n }; };
window.bench = async (u) => {
  const r = {};
  let t0 = performance.now(); const img = await load(u); r.loadDecode = +(performance.now() - t0).toFixed(1);
  r.size = [img.naturalWidth, img.naturalHeight];
  r.uploadImg1 = up(img); r.uploadImg2 = up(img); r.uploadImg3 = up(img);
  t0 = performance.now(); const bm = await createImageBitmap(img, { premultiplyAlpha: "none", colorSpaceConversion: "default" }); r.bitmapFromImg = +(performance.now() - t0).toFixed(1);
  r.uploadBitmap1 = up(bm); r.uploadBitmap2 = up(bm);
  t0 = performance.now(); const blob = await (await fetch(u)).blob(); r.fetchBlob = +(performance.now() - t0).toFixed(1);
  t0 = performance.now(); const bm2 = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "default" }); r.bitmapFromBlob = +(performance.now() - t0).toFixed(1);
  r.uploadBitmapBlob = up(bm2);
  const W = img.naturalWidth, H = img.naturalHeight, k = Math.min(1, 4096 / Math.max(W, H));
  if (k < 1) {
    const c = document.createElement("canvas"); c.width = Math.round(W * k); c.height = Math.round(H * k);
    const g = c.getContext("2d"); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    t0 = performance.now(); g.drawImage(img, 0, 0, c.width, c.height); r.resizeDraw = +(performance.now() - t0).toFixed(1);
    t0 = performance.now(); const b = await new Promise((res) => c.toBlob(res, "image/png")); r.pngEncode = +(performance.now() - t0).toFixed(1);
    t0 = performance.now(); const back = await load(URL.createObjectURL(b), false); r.pngDecode = +(performance.now() - t0).toFixed(1);
    r.uploadRoundtripImg = up(back);
    t0 = performance.now(); const cb = await createImageBitmap(c, { premultiplyAlpha: "none" }); r.bitmapFromCanvas = +(performance.now() - t0).toFixed(1);
    r.uploadCanvasBitmap = up(cb);
    r.eq_roundtrip_vs_canvasBitmap = diff(readTex(back), readTex(cb));
  } else {
    r.eq_img_vs_bitmap = diff(readTex(img), readTex(bm));
    r.eq_img_vs_blobBitmap = diff(readTex(img), readTex(bm2));
  }
  return r;
};
window.__ok = true;
</script>
```

---

## 5. Implementation results (2026-11-09, working tree on top of 9a94f40, not committed)

Same machine and harness as section 1 (`probe.html`, `parity.html`, `drive.py`). The old code was served unchanged at
`/__s/old`, so before and after runs alternate in the same session. Single runs unless stated; noise is ±15%.

### 5.1 Status per finding

| # | status | what was done |
|---|---|---|
| F1 | **done** | `dispose()` removes the frame from the DOM before disposing the layers. The canvases are detached, so they are released after 1 s instead of 10 s. `_teardownLayers` empties the camera first. |
| F2 | **done, PNG only** | "Upload twin": the `<img>` stays the source for every 2D draw and analysis. The core's 7 `texImage2D` sites (`imageTwin.ts` → `uploadSource`) use a registered `ImageBitmap` of the same pixels. The twin is used only for opaque PNG with no colour management (`bitmapSafe`: colour type not 4 or 6, no iCCP/cHRM/gAMA/cICP/tRNS). Everything else keeps the old path (see 5.4). |
| F3 | **partial** | Fitted (>4096) and mismatch images still take the PNG round trip for the 2D source, because parity needs it (5.4). For uploads they get a bitmap twin made from the fitted canvas. The blank image is a bitmap. |
| F4 | **done** | `fx/shader-warm.mjs` runs 3 s after ready, in an idle callback. It compiles the programs of every effect used by presets and scenes (plus glow) on a throwaway WebGL2 canvas with `KHR_parallel_shader_compile`: status queries answer "true", the programs finish compiling in the GPU process, then `loseContext`. This fills the GPU program cache and costs 3–4 ms of main thread per effect. Skipped if the extension is missing. |
| F5 | **done** | On the first build only, `_buildLayers` yields (`scheduler.yield` / MessageChannel, not rAF) between the effect, residue+glow, and intro steps. The intro's seam pixels are read in the same task as `setImages`, which keeps the p=0 paper colour identical. |
| F6 | **done** | `preloadImages` fetches the images as CORS blobs into an in-memory cache (10 min TTL, 160 MB LRU), and `prepare` reuses them (`fetchImageBlob`: arrayBuffer → Blob, because `r.blob()` fails on files over about 10 MB in Edge). |
| F7 | **partial** | Moving the ink analysis to a worker was rejected: max diff 117 on 4096 and 5504 images, because 2D downscaling gives different pixels for `<img>` and bitmap. It was replaced by a content-id cache of the ink analysis, which helps only replays of the same image. |
| F8 | **done** | `apps.mjs` and `scene-tab.mjs` load lazily; the GM preloads them in an idle callback. The newspaper font prewarm runs only for a GM or when a scene resolves to a newspaper. A player now loads 10 module files at world load (was 29). |
| F9 | **done** | Export reuses the title SVG image while its markup is unchanged: 76 SVG decodes instead of 140 on the test export. |
| F10 | **done** (scope added by the coordinator, who relayed the user's approval) | Splash barrier: a client that has sent **no** message at all 8 s after `prepare` is no longer waited for. A client whose last report says its tab is `hidden` is dropped 3 s after every other client is done. 90 s stays the upper bound for visible clients that are still reporting. Dropped clients still get `go` and start on their own when ready (the existing late start). The GM sees the existing "not ready in time" warning. The transition barrier (60 s) is unchanged. |

### 5.2 Before / after. MEASURED unless marked

| measurement | before | after |
|---|---|---|
| full-fx miasto 1x, prepare cold / warm (run0, run1, run2) | 2775 / 1013 / 1077 ms | 1679 / 675 / 647 ms |
| … longest task, same runs | 1221 / 504 / 476 ms | 255 / 95 / 96 ms |
| … `texImage2D` total (`<img>` before, bitmap after) | 207–216 ms | 28–30 ms |
| full-fx big4k 1x prepare (run0, run1); longest task | 2729 / 1502 ms; 1232 / 934 ms | 1528 / 1038 ms; 271 / 171 ms |
| full-fx big (5504→4096) 1x prepare (run0, run1); longest task | 5504 / 3417 ms; 1732 / 1606 ms | 3184 / 3058 ms; 466 / 532 ms |
| full-fx miasto 6x prepare (run0–2); longest task | 4792 / 3298 / 5668 ms; 2018–3255 ms | 3886 / 2060 / 2090 ms; 308–684 ms |
| full-fx big4k 6x prepare; longest task | 10795 ms; **8113 ms** | 6662 ms; 1956 ms |
| cold speedpaint prepare, no prewarm / after F4 prewarm (`warm.html`) | 1755 ms (long task 1298 ms) | 192 ms, no long task |
| playback full-fx 6x: `_apply` med / p95 / max | 0.8 / 1.9 / 15.4 ms | 0.7 / 1.8 / 10.2 ms |
| playback, other presets at 1x | 6.1 ms frame interval, no long tasks | unchanged |
| 14 full-fx cycles: live WebGL contexts | 3, 5 … 15, 16, 16; 15 after 3 s | **5 flat; 0 after 3 s** |
| … heap 3 s later, after GC | 15.5 MB | 16.8 MB |
| 30 quick full-fx cycles: hang | no hang this session (contexts stuck at 16) | no hang; 5 contexts, 0 after 3 s |
| … prepare per cycle, cycles 1–10 / 11–29 | 650–750 / 965–1012 ms | 613–670 / 785–930 ms |
| export (miasto, title on, 193 frames) | 3164–3189 ms, 140 SVG decodes | 3103–3115 ms, 76 decodes |
| live splash, GM + 2 players + hidden ghost "Gamemaster", all answering | go at 90.5 s with one silent client (section 1.6) | go after **393 ms** |
| live splash, one player hidden and never sending ready | 90 s (INFERRED from code, same path as 1.6) | go after **3.5 s**; that player started late on its own |
| live splash, one player silent (ignores `prepare`) | 90 s (INFERRED from code; 1.6 measured 90.5 s) | go after **8.0 s** |
| player world load: module files | 29 | 10 |

Regressions seen:
- On big images at 6x, `images-loaded` arrives 50–600 ms later, because the blob fetch and arrayBuffer copy come before the decode. The whole prepare is still faster.
- `bigalpha` (4800 px PNG with alpha, which keeps the old path) did not get faster: 3612 ms before, 4086 ms after, one run, within the noise.

### 5.3 Open items from section 3

- **strokes + glow 60%, "1.7 s past the timeline": not reproduced, no fix.**
  - In a fresh browser, old and new both finish exactly on the timeline: `p1At` = `finAt` = 9403 ms for a 9.4 s timeline.
  - The CDP step time was 10.9 s, which is prepare (1.5 s) plus play (9.4 s). So the 11.1 s in section 3 most likely included prepare. INFERRED: the original run cannot be re-checked.
- **Slowdown at cycles 10–12: cause not proven, no fix.**
  - Old code: prepare jumps from 650 to 990 ms exactly when the contexts reach the 16 cap.
  - New code (5 contexts): one 30-cycle run showed a smaller jump, 640 → 900 ms, at cycles 11–12. A 16-cycle run did not show it (575–650 ms throughout, 822 ms at c15).
  - The heap stays flat. GPU memory or GC pressure is still only a guess.
- **Harness artefact found, which also affects section 1.7.**
  - Headless Edge marks the page `hidden` about 15 s into a long `Runtime.evaluate`, and rAF stops. This happens even with no module code running (blank-page test).
  - Long chains of sequential `runPlay` calls then "hang" in old and new code alike, so every play row above was re-run in a fresh browser.
  - The "hang" in section 1.7 may partly be this artefact. UNVERIFIED.

### 5.4 Parity evidence (`parity.html`)

Method:
- The old and new player get the same input, with `preserveDrawingBuffer` forced.
- Every camera layer (effect, residue, glow, intro) is read back at p = 0, 0.25, 0.5, 0.75 and 1, after the effect reports ready plus a 2 s settle.
- Each layer's computed style is compared, and so is the timeline (W, H, total, sec, cs, effectDur, glowStart, glowSec, side).
- Determinism was checked old-old and new-new.

Results:
- **Worst diff 0, with identical styles and timeline, in all 27 cases:**
  - ulica × 4 effects, miasto × 4 effects;
  - mismatch PNG, overlap (colorAt < 100), preview 1 and 1.5, strokes + glow 60;
  - big4k, big 5504 (fit);
  - old-path formats: JPEG, JPEG with EXIF orientation 6, P3 JPEG, ICC PNG, CMYK JPEG, lossy WebP, WebP with alpha, PNG with alpha, 4800 px PNG with alpha.
  - The twin path (`uploadTwins true,true`) was used for every opaque PNG case and the old path (`false,false`) for the rest.
- big 5504 strokes first showed a residue difference. The residue mask is built asynchronously in a worker and was ready in one run but not the other: the multiply path versus the mask path, which are equivalent by design. With a 15 s settle the diff is 0.
- Export webm sha: old and new each produced the same two hashes (`78ff042d…`, `a1617c2c…`) over 5 runs each. The export is not deterministic even old-old, and the set of outputs is identical.
- Why some formats keep the old path: a raw `ImageBitmap` upload differs from `<img>` for these inputs:

  | input | max diff |
  |---|---|
  | JPEG | 255 |
  | lossy WebP | 251 |
  | PNG with alpha | 246 |
  | ICC-tagged images | 255 |
  | WebP with alpha | 1 LSB |

  Also, a 2D `drawImage` of a bitmap downscaled more than 2× differs even for opaque PNG (up to 117). These cases keep the old upload path, so their prepare gains come only from F1, F4, F5 and F6.

### 5.5 Live check (lane 1, world `invincible`, GM `claude` + `Test Gracz 1` + `Test Gracz 2`, headless)

- **Splash** `builtin-ulica` to all: the overlay reached `sr-ready` and played on both players, and a screenshot showed the spread effect mid-play. F10 scenarios as in 5.2.
- **Scene transition** `builtin-miasto` (scene "IB Test Scene") and **newspaper transition** `builtin-gazeta` (scene "map"): the player showed `sr-transition` and `sr-transition sr-newspaper` overlays, and the newspaper closed after 8.6 s.
- `canvas.app.renderer.gl.isContextLost()` was false on GM and player after all plays. No module errors in either console.
- Scene flags and the active scene ("map fire test") were restored afterwards.
- Not verified live:
  - smoothness (headless Foundry renders 1–4 fps);
  - the F4 prewarm effect in Foundry;
  - the F6 cache hit rate in Foundry;
  - 6x CPU in Foundry.

Video after the changes: `tools/opt-splash-po.webm`. It is a harness recording of ulica (spread + intro + glow + sway + title), 17.5 s long. Frames were captured at about 8–11 fps with `Page.captureScreenshot`, so it is choppier than the real playback.
