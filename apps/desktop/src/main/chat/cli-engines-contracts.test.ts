import {
  chatEngineSchema,
  settingsSetCliOption,
  summaryCliKindSchema,
  summarySetupKindSchema,
} from '@vozella/contracts';
import { CLI_ENGINE_LIST } from '@vozella/core';
import { describe, expect, it } from 'vitest';

/**
 * The wire enums keep their own literals (contracts does not import core), so this pins them to
 * the core CLI engine table: a new or renamed engine fails here instead of at runtime.
 */
describe('CLI engine ids on the wire', () => {
  it('summary CLI kinds match the engine kinds', () => {
    expect([...summaryCliKindSchema.options].sort()).toEqual(
      CLI_ENGINE_LIST.map((e) => e.kind).sort(),
    );
    for (const engine of CLI_ENGINE_LIST) {
      expect(summarySetupKindSchema.safeParse(engine.kind).success).toBe(true);
    }
  });

  it('chat engines include every CLI provider id', () => {
    for (const engine of CLI_ENGINE_LIST) {
      expect(chatEngineSchema.safeParse(engine.providerId).success).toBe(true);
    }
  });

  it('the CLI option picker accepts every executable', () => {
    for (const engine of CLI_ENGINE_LIST) {
      const parsed = settingsSetCliOption.input.safeParse({
        provider: engine.executable,
        field: 'model',
        value: 'x',
      });
      expect(parsed.success).toBe(true);
    }
  });
});
