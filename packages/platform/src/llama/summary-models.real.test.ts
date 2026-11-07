import fs from 'node:fs';
import nodePath from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CancelSource,
  parseOffsetDate,
  SUMMARY_MODELS,
  type CancelSignal,
  type SummaryModelInfo,
} from '@vozella/core';
import { LlamaSidecar } from './llama-sidecar';
import { LocalLlmHost } from './local-llm-host';
import { LocalLlmSummaryProvider } from './local-llm-provider';
import { createProcessGuard } from './process-guard';

/**
 * Smoke test of the summary catalog on the bundled llama.cpp build: every catalog model whose file
 * is in VOZELLA_LLM_MODELS_DIR (with its pinned size) loads in llama-server and summarizes a tiny
 * Spanish transcript. VOZELLA_LLAMA_BIN_DIR is the folder with the `cuda12` / `cpu` builds;
 * VOZELLA_LLM_BACKEND picks one (default cuda12 when present, else cpu). Opt-in: without both
 * folders the suite is skipped, and a model whose file is missing is skipped with a note.
 */
const binDir = process.env.VOZELLA_LLAMA_BIN_DIR;
const modelsDir = process.env.VOZELLA_LLM_MODELS_DIR;
const ready =
  process.platform === 'win32' &&
  !!binDir &&
  !!modelsDir &&
  fs.existsSync(nodePath.join(binDir, 'cpu', 'llama-server.exe')) &&
  fs.existsSync(modelsDir);

if (!ready) {
  process.stderr.write(
    'summary catalog real tests skipped: set VOZELLA_LLAMA_BIN_DIR and VOZELLA_LLM_MODELS_DIR.\n',
  );
}

function backendExe(): { exe: string; gpuOffload: boolean } {
  const wanted = process.env.VOZELLA_LLM_BACKEND;
  const order = wanted ? [wanted] : ['cuda12', 'cpu'];
  for (const backend of order) {
    const exe = nodePath.join(binDir!, backend, 'llama-server.exe');
    if (fs.existsSync(exe)) return { exe, gpuOffload: backend !== 'cpu' };
  }
  throw new Error(`no llama-server for ${order.join(', ')} in ${binDir}`);
}

function present(model: SummaryModelInfo): string | null {
  const file = nodePath.join(modelsDir!, model.fileName);
  try {
    return fs.statSync(file).size === model.sizeBytes ? file : null;
  } catch {
    return null;
  }
}

const recordedAt = parseOffsetDate('2026-11-02T14:00:00.0000000-05:00')!;
const NEVER: CancelSignal = new CancelSource().signal;
const TRANSCRIPT = [
  '[00:00.00-00:08.00] Hola a todos, empezamos la reunión semanal del equipo de producto.',
  '[00:08.00-00:20.00] Marta dice que el lanzamiento de la versión dos se mueve al viernes 14 de noviembre.',
  '[00:20.00-00:34.00] Decidimos que Pablo prepara las notas de la versión y Lucía revisa la documentación.',
].join('\n');

describe.skipIf(!ready)('summary catalog on the real llama-server', () => {
  for (const model of SUMMARY_MODELS) {
    it(`${model.displayName}: loads and summarizes in Spanish`, async (context) => {
      const file = present(model);
      if (file === null) {
        process.stderr.write(`[catalog real] ${model.fileName}: file not present, skipped\n`);
        context.skip();
        return;
      }
      const runtime = backendExe();
      const host = new LocalLlmHost({
        createServer: () => new LlamaSidecar({ guard: createProcessGuard(undefined) }),
        resolveRuntime: async () => ({ ...runtime, healthTimeoutMs: 300_000 }),
      });
      const provider = new LocalLlmSummaryProvider({ host, modelPath: () => file });
      const report: string[] = [];
      try {
        const started = Date.now();
        const result = await provider.summarize(
          { transcript: TRANSCRIPT, title: 'Reunión semanal', recordedAt, outputLanguage: 'es' },
          NEVER,
        );
        report.push(`summary ${Date.now() - started} ms (includes load)`);
        const summary = result.summaryMarkdown;
        expect(summary.trim().length).toBeGreaterThan(0);
        expect(summary).not.toMatch(/<\/?think>/);
        // The facts of the transcript come back in Spanish.
        expect(summary).toMatch(/Pablo|Lucía|Marta/);
        report.push(`first line: ${summary.trim().split('\n')[0]?.slice(0, 80) ?? ''}`);

        // No hidden reasoning either: the server counts every generated token, so a model that
        // thought before answering would report far more tokens than its visible answer holds.
        const server = await host.acquire(file, NEVER);
        let content = '';
        let completion = 0;
        for await (const delta of server.chatStream(
          [{ role: 'user', content: 'Responde en una frase corta: ¿qué es una reunión?' }],
          { maxTokens: 400, temperature: 0.2, seed: 1 },
        )) {
          content += delta.content ?? '';
          completion = delta.usage?.completionTokens ?? completion;
        }
        const visible = await server.tokenize(content, NEVER);
        report.push(`answer ${visible} visible / ${completion} generated tokens`);
        expect(content).not.toMatch(/<\/?think>/);
        expect(content.trim().length).toBeGreaterThan(0);
        expect(completion).toBeLessThanOrEqual(visible + 8);
      } finally {
        await host.dispose();
        process.stderr.write(`[catalog real ${model.fileName}] ${report.join(' | ')}\n`);
      }
    }, 900_000);
  }
});
