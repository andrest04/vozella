# Vozella presentation video

A 50-second product presentation of Vozella (1920x1080, 30 fps, no audio), authored as a
[HyperFrames](https://hyperframes.heygen.com) project: plain HTML and CSS driven by one paused
GSAP timeline, rendered to MP4 by the `hyperframes` CLI. On-screen copy is in Spanish.

## Preview and render

Requires Node (built with Node 24) and FFmpeg on `PATH`. Run everything from this folder (`video/`).

```bash
npm run dev        # live preview in the browser (HyperFrames Studio)
npm run check      # lint + runtime + layout + motion + contrast
npx hyperframes render --fps 30 --output renders/vozella-presentation.mp4
```

The MP4 lands in `video/renders/`, which is git-ignored (so is the `.hyperframes/` cache).
The first render downloads a headless Chrome. To look at single frames without rendering:

```bash
npx hyperframes snapshot --at 6.5,15,47.5
```

`npm run check` passes with warnings that are accepted on purpose: the linter prefers one
sub-composition per scene (this project keeps a single file so shared elements such as the
recording pill and the bar wipe can cross scene cuts), and it notes the film has no sound.

## Files

| Path | What it is |
| --- | --- |
| `index.html` | The whole composition: CSS tokens, one section per scene, one timeline script |
| `assets/fonts/` | Schibsted Grotesk (variable) and IBM Plex Mono, latin subsets, OFL |
| `assets/vendor/gsap.min.js` | GSAP 3.15.0, vendored so renders need no network |
| `assets/screens/` | The real app screenshot used in the recording scene |

## Scenes

| # | Scene | Start (s) |
| --- | --- | --- |
| 1 | Hook | 0.0 |
| 2 | Mark reveal | 4.0 |
| 3 | Nothing joins the call | 8.3 |
| 4 | Records | 12.8 |
| 5 | Local transcription | 17.9 |
| 6 | Notes | 23.3 |
| 7 | Live copilot | 28.3 |
| 8 | Library and chat | 34.0 |
| 9 | Your engine, your files | 39.4 |
| 10 | Outro | 45.4 (ends 50.0) |

## Changing things

- **Copy:** edit the text inside each `<section id="sN">` in `index.html`. Headlines are split
  into `<span class="line">` rows; keep one row per line you want on screen. Words are wrapped
  and animated by the script, so no script change is needed. Check that a longer line still
  fits its column with `npx hyperframes snapshot`.
- **Timing:** scene start times live in the `T` object at the top of the script. Each
  `<section>` also carries `data-start` / `data-duration` attributes, which the renderer reads
  before any script runs: update both, and the root `data-duration` if the total changes.
  Scenes alternate between track 0 and 1 because neighbours overlap during transitions.
- **Brand:** colors and fonts are CSS variables at the top of the `<style>` block and mirror
  `DESIGN.md` (dark values). Signal red is reserved for the recording dot.
- **Determinism:** everything is driven by the one timeline registered at
  `window.__timelines["main"]`. Do not add CSS animations, timers, `Date.now()` or
  `Math.random()`; use the seeded `rng()` helper for anything that should look random.

Only claims documented in `PRODUCT.md` / `README.md` appear in the video. The meeting shown in
the mock-ups (a launch planning call) is fictional.

## Audio

The soundtrack and sound effects in `assets/audio/` are generated with ElevenLabs by
`scripts/generate-audio.mjs` (music: Eleven Music; riser, impact and whoosh: sound effects).
The files are committed, so rendering needs no API key.

```sh
npm install              # once, installs the ElevenLabs SDK
npm run audio            # generate missing files
npm run audio -- --force # regenerate everything (uses credits, results differ each run)
```

The script reads `ELEVENLABS_API_KEY` from the repo's `.env.local` (git-ignored). Prompts and
lengths are at the top of the script. Cue times, volumes and fades are the `<audio>` elements
at the end of the composition root in `index.html`; they follow the scene times in `T`.
