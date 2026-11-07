import { describe, expect, it } from 'vitest';
import {
  LLAMA_BACKENDS,
  backendFallbackChain,
  chooseBackend,
  gpuOffloadFor,
  isGpuBackend,
  usesGpuOffload,
} from './llama-backend';

const hw = (gpuName: string | null, gpuVramGb: number | null) => ({
  totalRamGb: 16,
  gpuName,
  gpuVramGb,
});

describe('llama backend choice', () => {
  it('lists the four Windows backends', () => {
    expect([...LLAMA_BACKENDS]).toEqual(['cuda12', 'cuda13', 'vulkan', 'cpu']);
  });

  it('NVIDIA picks cuda12 by default, then vulkan, then cpu', () => {
    const nvidia = hw('NVIDIA GeForce RTX 3060', 12);
    expect(backendFallbackChain(nvidia)).toEqual(['cuda12', 'vulkan', 'cpu']);
    expect(chooseBackend(nvidia, LLAMA_BACKENDS)).toBe('cuda12');
  });

  it('NVIDIA picks cuda13 only when the driver probe says so, keeping cuda12 as the next step', () => {
    const nvidia = hw('NVIDIA GeForce RTX 5080', 16);
    expect(backendFallbackChain(nvidia, 'cuda13')).toEqual(['cuda13', 'cuda12', 'vulkan', 'cpu']);
    expect(chooseBackend(nvidia, LLAMA_BACKENDS, 'cuda13')).toBe('cuda13');
  });

  it('AMD and Intel discrete GPUs with VRAM pick vulkan', () => {
    expect(chooseBackend(hw('AMD Radeon RX 7800 XT', 16), LLAMA_BACKENDS)).toBe('vulkan');
    expect(chooseBackend(hw('Intel Arc A770', 8), LLAMA_BACKENDS)).toBe('vulkan');
    expect(backendFallbackChain(hw('AMD Radeon RX 7800 XT', 16))).toEqual(['vulkan', 'cpu']);
  });

  it('no GPU, no VRAM or an unnamed adapter pick cpu', () => {
    expect(chooseBackend(hw(null, null), LLAMA_BACKENDS)).toBe('cpu');
    expect(chooseBackend(hw('AMD Radeon Graphics', 0), LLAMA_BACKENDS)).toBe('cpu');
    expect(chooseBackend(hw('Intel UHD', null), LLAMA_BACKENDS)).toBe('cpu');
  });

  it('skips backends that are not available (failed self-test): cuda -> vulkan -> cpu', () => {
    const nvidia = hw('NVIDIA GeForce RTX 3060', 12);
    expect(chooseBackend(nvidia, ['vulkan', 'cpu'])).toBe('vulkan');
    expect(chooseBackend(nvidia, ['cpu'])).toBe('cpu');
    expect(chooseBackend(nvidia, [])).toBeNull();
  });

  it('GPU backends offload layers, cpu does not', () => {
    expect(isGpuBackend('cuda12')).toBe(true);
    expect(isGpuBackend('cuda13')).toBe(true);
    expect(isGpuBackend('vulkan')).toBe(true);
    expect(isGpuBackend('cpu')).toBe(false);
    expect(usesGpuOffload('vulkan')).toBe(true);
    expect(usesGpuOffload('cpu')).toBe(false);
  });
});

describe('gpuOffloadFor: can the llama runtime use the GPU, for the fit rating', () => {
  it('the runtime in use decides once it is known', () => {
    expect(gpuOffloadFor(hw('NVIDIA GeForce RTX 3070', 8), false)).toBe(false);
    expect(gpuOffloadFor(hw(null, null), true)).toBe(true);
  });

  it('before any runtime is picked, the first backend the chain would try decides', () => {
    expect(gpuOffloadFor(hw('NVIDIA GeForce RTX 3070', 8), undefined)).toBe(true);
    expect(gpuOffloadFor(hw('AMD Radeon RX 7600', 8), undefined)).toBe(true);
    // VRAM without a name: no GPU build can be chosen for it, so only the CPU build runs.
    expect(gpuOffloadFor(hw('  ', 8), undefined)).toBe(false);
    expect(gpuOffloadFor(hw(null, null), undefined)).toBe(false);
  });
});
