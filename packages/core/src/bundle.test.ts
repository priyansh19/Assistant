import { describe, expect, it } from 'vitest';
import { brainExitReason, brainRestartDelayMs, brainServerArgs } from './bundle.js';

describe('brainServerArgs', () => {
  it('binds to loopback on the given port with both model files', () => {
    const args = brainServerArgs({ modelPath: 'C:\\m.gguf', mmprojPath: 'C:\\p.gguf', port: 51234 });
    expect(args.slice(0, 4)).toEqual(['--model', 'C:\\m.gguf', '--mmproj', 'C:\\p.gguf']);
    expect(args[args.indexOf('--host') + 1]).toBe('127.0.0.1');
    expect(args[args.indexOf('--port') + 1]).toBe('51234');
    expect(args).not.toContain('--threads');
  });

  it('passes a thread count only when given', () => {
    expect(brainServerArgs({ modelPath: 'm', mmprojPath: 'p', port: 1, threads: 6.7 })).toContain('6');
  });

  it('rejects impossible ports', () => {
    for (const port of [0, -1, 70000, 1.5])
      expect(() => brainServerArgs({ modelPath: 'm', mmprojPath: 'p', port })).toThrow();
  });
});

describe('brainRestartDelayMs', () => {
  it('backs off and caps at 30 s', () => {
    expect([0, 1, 2, 3, 10].map(brainRestartDelayMs)).toEqual([1000, 2000, 4000, 8000, 30_000]);
  });
});

describe('brainExitReason', () => {
  it('explains the common start-up failures', () => {
    expect(brainExitReason(-1073741515, '')).toMatch(/Visual C\+\+/);
    expect(brainExitReason(0xc0000135, '')).toMatch(/Visual C\+\+/);
    expect(brainExitReason(1, 'ggml_vulkan: ErrorOutOfDeviceMemory')).toMatch(/memory/);
    expect(brainExitReason(1, 'llama_model_load: error loading model')).toMatch(/damaged/);
    expect(brainExitReason(1, "couldn't bind HTTP server socket")).toMatch(/port/);
    expect(brainExitReason(3, '')).toBe('it stopped (exit code 3)');
    expect(brainExitReason(null, '')).toBe('it stopped unexpectedly');
  });
});
