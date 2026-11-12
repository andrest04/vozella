# Feature: Product presentation video (HyperFrames)

Locator: `odd/tasks/presentation-video.md` · Engram mirror: `odd/presentation-video/tasks` · Branch: `feat/presentation-video`

## Objective
A short, high-impact presentation video of Vozella, authored as a HyperFrames (HTML + GSAP) project in `video/` and rendered to MP4.

## Problem
There is no video to present the product. The user asked (2026-11-11) for an "epic" presentation video with strong animations, built with HyperFrames; it presents the product, it does not sell it.

## Scope
- New HyperFrames project in `video/` (composition, assets copied from `docs/`, README with preview/render commands).
- Rendered MP4 is a build output, not committed (`video/renders/` ignored).
- No changes to the app, the website, or the packages.

## Constraints
- Brand: `DESIGN.md` and `PRODUCT.md`. Ink `#0a0a0a`, paper `#ffffff`, signal red `#ff5a4f` (dark), Schibsted Grotesk + IBM Plex Mono, the five-bar mark from `docs/brand/`.
- Voice: plain, short, factual. No invented numbers, customers, testimonials, pricing or benchmarks.
- Product claims only from `PRODUCT.md` / `README.md`.
- Video copy in Spanish (neutral); user-chosen default by the orchestrator, cheap to swap.
- No audio: the repo has no licensed music or voiceover.
- Deterministic: one paused GSAP timeline on `window.__timelines`, no wall-clock time, no unseeded randomness.
- 1920x1080, 30 fps, about 40 to 50 seconds.

## Delivery strategy
`exception-ok` (solo project, merge to main, no PRs). RDD is off (global), so no native review.

## Tasks
- [x] P1 HyperFrames project + composition + render. Route: delegated writer (2+ non-trivial files, needs HyperFrames docs research).
  - Storyboard: hook (meeting noise, nobody takes notes) → mark reveal + tagline → nothing joins the call → records mic + system audio → local transcription → summary and action items → Live copilot "What did I miss?" → library and chat with source links → choose your engine, meetings are Markdown files → outro lockup (beta, Windows).
  - Checks: `npx hyperframes lint` / `check` clean; `npx hyperframes render` produces an MP4; ffprobe confirms 1920x1080, 30 fps and duration; frames extracted with ffmpeg at each scene and inspected for overlap, clipping and blank frames.

## Acceptance criteria
- `video/` renders to an MP4 with one command documented in `video/README.md`.
- Every scene is legible, on-brand, and makes only documented claims.
- No blank or broken frames at scene boundaries.

## Progress
- 2026-11-11: explored brand, product docs and HyperFrames docs; branch created from main `ad21d4b`; feature document created (1 task).
- 2026-11-11: P1 done (delegated writer, not committed). `video/` holds the HyperFrames 0.9.36 project: single composition `index.html`, local fonts, vendored GSAP 3.15.0, one real screenshot, README. `.gitignore` ignores `video/renders/`, `video/node_modules/`, `video/.hyperframes/`.
  - Observed checks:
    - `npx hyperframes check`: passed, 0 errors (lint 0 errors / 15 warnings, runtime 0/0, layout 0/0, motion 0/0, contrast 57/57 AA, craft 1 warning). Accepted warnings: `nested_structure_needs_subcomposition` x12, `timeline_track_too_dense` x2, `composition_file_too_large` x1 (single-file composition kept on purpose so the pill and bar wipe cross scene cuts) and `film_silent` (no audio by constraint).
    - `npx hyperframes lint`: 0 errors, the same 15 structural warnings.
    - `npx hyperframes render --fps 30 --output renders/vozella-presentation.mp4`: render complete, 8.2 MB, 1500 frames.
    - `ffprobe`: h264, 1920x1080, 30/1 fps, duration 50.000 s.
    - Frame inspection: three passes (28 snapshot stills, then 36 + 36 frames extracted from the MP4 with ffmpeg at scene midpoints and boundaries, plus a 4-frame recheck). Fixed along the way: masked headlines counted as overlapping text, title bar hidden under the panned screenshot, a dead beat entering scene 8, a headline colliding with the Markdown card in scene 9, a long white hold before the outro tile, sub-28 px labels. Final frames: no overlap, clipping, blank frames or fallback fonts.
  - Final duration: 50.0 s. Scene timing:

    | # | Scene | Start (s) | End (s) | Hand-off out |
    | --- | --- | --- | --- | --- |
    | 1 | Hook | 0.0 | 4.0 | level bars collapse into the mark |
    | 2 | Mark reveal | 4.0 | 8.3 | five-column bar wipe |
    | 3 | Nothing joins the call | 8.3 | 12.8 | call recedes, window rises |
    | 4 | Records | 12.8 | 17.9 | recording pill stays on screen |
    | 5 | Local transcription | 17.9 | 23.3 | recording stops, transcript panel collapses into the notes card |
    | 6 | Notes | 23.3 | 28.3 | vertical push |
    | 7 | Live copilot | 28.3 | 34.0 | scale-through |
    | 8 | Library and chat | 34.0 | 39.4 | horizontal push |
    | 9 | Your engine, your files | 39.4 | 45.4 | bar wipe closes and shrinks into the logo tile |
    | 10 | Outro | 45.4 | 50.0 | final lockup holds about 2.4 s |

## Next step
User reviews the MP4 (`video/renders/vozella-presentation.mp4`); merge `feat/presentation-video` into main when approved. Work-unit commit: `739f9a9`. Parent spot check: ffprobe h264 1920x1080 30 fps 50.0 s and a 10-frame contact sheet, clean. Stock scaffold `video/CLAUDE.md` and `video/AGENTS.md` removed (they pointed at skills that are not installed). RDD off: no review.
