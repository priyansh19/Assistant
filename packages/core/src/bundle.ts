/**
 * The built-in answer model that ships inside the installer, so a new user can ask a first question
 * without an account or a key: an open-source vision model run by llama.cpp's llama-server on
 * 127.0.0.1. apps/desktop/bundle.json lists every file that ships (this model, the server, the
 * speech model and voices); scripts/fetch-bundle.mjs downloads them before packaging.
 */

/** The built-in answer model: Qwen3-VL 2B Instruct (Apache-2.0), 4-bit, with its vision encoder. */
export const BUILTIN_BRAIN = {
  name: 'Qwen3-VL 2B',
  /** Shown as the model in use (llama-server ignores the name; it serves one model). */
  id: 'qwen3-vl-2b-instruct',
  model: 'Qwen3VL-2B-Instruct-Q4_K_M.gguf',
  mmproj: 'mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf',
  /** Folder under resources/. */
  dir: 'brain',
  /** llama.cpp build folder under resources/. */
  serverDir: 'llama',
} as const;

export interface BrainServerOptions {
  modelPath: string;
  mmprojPath: string;
  port: number;
  /** CPU threads; omitted lets llama.cpp choose. */
  threads?: number;
}

/**
 * llama-server arguments for the built-in model. Only flags that every recent llama.cpp build
 * accepts: an unknown flag makes the server exit at once.
 */
export function brainServerArgs(o: BrainServerOptions): string[] {
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new Error(`bad port ${o.port}`);
  return [
    '--model',
    o.modelPath,
    '--mmproj',
    o.mmprojPath,
    // Loopback only: nothing else on the network can reach the model.
    '--host',
    '127.0.0.1',
    '--port',
    String(o.port),
    // One conversation at a time keeps the whole context for the question in front of the user.
    '--parallel',
    '1',
    // Room for the screenshot (~1,000 image tokens at 1280 px), the prompt and the answer.
    '--ctx-size',
    '8192',
    // Offload every layer to the GPU when there is one (Vulkan); ignored on CPU-only PCs.
    '--n-gpu-layers',
    '99',
    ...(o.threads && o.threads > 0 ? ['--threads', String(Math.floor(o.threads))] : []),
  ];
}

/** How long to wait before restarting a server that exited: 1 s, 2 s, 4 s … capped at 30 s. */
export function brainRestartDelayMs(failures: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, failures));
}

/** Windows exit code when a DLL the server needs is missing (STATUS_DLL_NOT_FOUND). */
const DLL_NOT_FOUND = [0xc0000135, -1073741515];

/** A readable reason for a server that exited during start-up. */
export function brainExitReason(code: number | null, stderrTail: string): string {
  if (code !== null && DLL_NOT_FOUND.includes(code))
    return 'a system library it needs is missing (Microsoft Visual C++ runtime)';
  if (/out of memory|failed to allocate|ErrorOutOfDeviceMemory/i.test(stderrTail))
    return 'this PC ran out of memory loading it';
  if (/failed to load model|error loading model|gguf/i.test(stderrTail)) return 'its model files are damaged';
  if (/bind|address already in use/i.test(stderrTail)) return 'its port was taken';
  return code === null ? 'it stopped unexpectedly' : `it stopped (exit code ${code})`;
}
