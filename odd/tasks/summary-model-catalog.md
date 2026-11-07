# Feature: Diverse summary model catalog + "Recommended for your PC"

Locator: `odd/tasks/summary-model-catalog.md` · Engram mirror: `odd/summary-model-catalog/tasks` · Branch: to create after `feat/action-item-deadlines` lands (single writer, no parallel worktree)

## Objective
Replace the Gemma-heavy summary catalog (Llama 3.2 1B + three Gemma 4) with six models from different vendors, and show one "Recommended for your PC" pick: the highest-quality model that runs well on the user's hardware.

## Why
User request (2026-11-06): variety, lightweight and text-focused models, and a clear best pick per machine. Today `rateFor` (`packages/core/src/settings/summary-models.ts:99`) rates fit per model, but the "recommended" label is fixed on Gemma 4 E2B.

## Approved catalog (user approved 2026-11-06)
| Tier | Model | Vendor |
|---|---|---|
| Light | Granite 4.0 Micro (3B) | IBM |
| Light | Llama 3.2 3B Instruct | Meta |
| Balanced | Qwen3-4B-Instruct-2507 | Alibaba |
| Balanced | Gemma 4 E4B Instruct (kept) | Google |
| Strong | Qwen3-8B (thinking off) | Alibaba |
| Strong | Gemma 4 12B Instruct (kept) | Google |
Excluded: DeepSeek distills (reasoning, slow, lower faithfulness), Nemotron Nano (English only), Phi-4-mini (weak Spanish).

## Constraints
- Every model must load and run with the bundled llama.cpp `LLAMA_TAG = 'b12063'` (`packages/platform/src/llama/llama-runtime-catalog.ts:4`); pin exact URL (commit), `sizeBytes`, `sha256`, Q4_K_M.
- Quality rank is from research, not our own eval; revisit after the eval set exists.
- Users who already downloaded removed models (Llama 1B, Gemma E2B) must not break: decide migration (keep as legacy/hidden vs. delete).
- Qwen3-8B needs thinking disabled (`/no_think` or reasoning budget 0).

## Tasks
- [x] C1 Verify candidates (read-only): exact HF GGUF repos, pinned commit URLs, byte sizes, SHA-256, licenses, llama.cpp b12063 architecture support, chat template quirks. Route: delegated explorer.
- [ ] C2 Catalog + quality rank + `recommendedFor(hardware)` pick in core, with tests. Route: delegated.
- [ ] C3 Legacy handling for removed models + settings UI "Recommended for your PC" badge, en/es i18n. Route: delegated.
- [ ] C4 Real smoke test: each model loads in the sidecar and produces a summary. Route: delegated.

## Progress
- 2026-11-06: catalog approved by user.
- 2026-11-06: C1 done (delegated explorer; HF tree API + llama-server README at b12063, released 2026-11-03). All six repos ungated, Q4_K_M, URL = `https://huggingface.co/<repo>/resolve/<commit>/<file>`:
  - Granite: `ibm-granite/granite-4.0-micro-GGUF@ec48475f0c811d812fbfb61975717a9c36eeb652` `granite-4.0-micro-Q4_K_M.gguf` 2099502528 B, sha `97c417dcc0534b0737c74016fb2af083cb17c3b51eaac621192d23961b7024eb`; arch `granite` (dense); 131k ctx; minRam 8.
  - Llama 3B: `bartowski/Llama-3.2-3B-Instruct-GGUF@5ab33fa94d1d04e903623ae72c95d1696f09f9e8` `Llama-3.2-3B-Instruct-Q4_K_M.gguf` 2019377696 B, sha `6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff`; Llama 3.2 Community license (ship license copy + "Built with Llama"); minRam 8.
  - Qwen3-4B-2507: `unsloth/Qwen3-4B-Instruct-2507-GGUF@a06e946bb6b655725eafa393f4a9745d460374c9` `Qwen3-4B-Instruct-2507-Q4_K_M.gguf` 2497281120 B, sha `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597`; no thinking mode; 262k ctx; minRam 12 (8 with q8_0 KV).
  - Gemma E4B: `unsloth/gemma-4-E4B-it-GGUF@bfc15c382204943c3a8fff0c750b94ae2364d7a3`, sha `85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87` (same bytes as current entry); minRam 8.
  - Qwen3-8B: `Qwen/Qwen3-8B-GGUF@7c41481f57cb95916b40956ab2f0b139b296d974` `Qwen3-8B-Q4_K_M.gguf` 5027783488 B, sha `d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785`; 32k native ctx; thinking off via `--reasoning off` at server start (not `/no_think`, not budget 0); minRam 16.
  - Gemma 12B: `unsloth/gemma-4-12b-it-GGUF@fc034cfff751157913579611efad8462ac1be606`, sha `0a270ec9fe6b34f4a0d33992b6135117b484ebc4766ab76b51d4ae8c457e4c42` (same bytes); minRam 16.
  - Research rank (not measured): 1 Gemma 12B, 2 Qwen3-8B, 3 Gemma E4B, 4 Qwen3-4B-2507, 5 Granite Micro, 6 Llama 3B.
  - Open issue: without Llama 1B, the lightest model needs ~8 GB RAM at a 25k-token context; 4–6 GB PCs get no "runs well" option. Decide in C3.
  - Unverified: Gemma thinking default in the app; Gemma 12B actually loading at b12063 (C4).

## Next step
C2 after `feat/action-item-deadlines` lands.
