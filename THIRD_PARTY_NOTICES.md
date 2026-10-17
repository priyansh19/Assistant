# Third-party notices

## Shipped inside the Windows installer

Listed in `apps/desktop/bundle.json`, downloaded unmodified from their publishers by `apps/desktop/scripts/fetch-bundle.mjs`.

| Component | Source | License |
|---|---|---|
| llama.cpp (`llama-server` and its libraries) | https://github.com/ggml-org/llama.cpp | MIT (license file kept next to the server) |
| Qwen3-VL 2B Instruct GGUF (model and vision encoder) | https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF | Apache-2.0 |
| Moonshine Tiny (sherpa-onnx export) | https://github.com/k2-fsa/sherpa-onnx | MIT |
| Piper voices Lessac and Ryan (sherpa-onnx export) | https://github.com/k2-fsa/sherpa-onnx, https://github.com/rhasspy/piper | Per voice; see the model card in each voice folder |
| Microsoft Visual C++ runtime (`msvcp140.dll`, `vcruntime140*.dll`) | Copied from the build PC | Microsoft Visual C++ Redistributable license (app-local deployment) |

## npm dependencies

Licenses of the npm packages bundled in the app are in their own folders under `node_modules`.
