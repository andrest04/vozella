/// <reference types="node" />
// Several specs read files through node:fs; this makes the Node types part of every renderer spec.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  if (typeof document !== 'undefined') cleanup();
});
