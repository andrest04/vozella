import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    // Renderer component tests opt in with a `// @vitest-environment jsdom` pragma.
    setupFiles: ['./src/renderer/test-setup.ts'],
    // The default (all cores but one) oversubscribes hybrid CPUs and pushes heavy jsdom tests
    // past the 5 s timeout; half the cores runs the suite in the same wall time without that.
    maxWorkers: '50%',
  },
});
