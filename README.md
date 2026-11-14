# AmdInfer

A local GGUF inference desktop-style app for AMD GPUs, powered by `llama.cpp` with HIP/ROCm. This MVP wraps the inference engine instead of reimplementing ROCm kernels.

## What works

- Browser-based local chat UI with streamed responses
- OpenAI-compatible `POST /v1/chat/completions` (streaming and non-streaming)
- GGUF model selection from a local models directory
- Starts/stops the llama.cpp server process
- Basic health/status and settings API
- CPU fallback supported by the selected llama.cpp server binary

## Desktop app

The project includes a Tauri 2 desktop shell. Install Node.js 20+, Rust, and the platform's Tauri prerequisites (WebView2 on Windows; WebKitGTK development packages on Linux). Then install the frontend dependencies and launch:

```sh
npm install
npm run tauri dev
```

Build a distributable installer, including the Node service compiled into a standalone executable:

```sh
npm run tauri:build
```

The desktop window starts the packaged service automatically, using a writable `models` directory in your application data folder. You still need a HIP-enabled `llama-server` and ROCm runtime on the host; these are platform-specific and are not bundled. The packaged app contains the chat UI and Node service, not model weights.

## Requirements

- Node.js 20+
- A `llama-server` binary built with HIP/ROCm support (`llama-server --help` should list `--device`/GPU options)
- AMD ROCm-compatible Linux installation for the most predictable HIP deployment. Windows AMD GPU compute support depends on the supported ROCm/driver combination; this app does not install ROCm.

Set `LLAMA_SERVER` to the server executable path. GGUF files are read from `models/` by default; override with `MODEL_DIR`.

```sh
npm install
npm start
```

Open http://127.0.0.1:3030. Add `.gguf` files to `models/`, then choose one in the app. The default server port is 8080.

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLAMA_SERVER` | `llama-server` | Path/name of llama.cpp server executable |
| `MODEL_DIR` | `./models` | Folder scanned for GGUF models |
| `HOST` | `127.0.0.1` | App bind address; keep loopback unless you intentionally expose the API |
| `PORT` | `3030` | App UI/API port |
| `LLAMA_PORT` | `8080` | Internal llama.cpp server port |
| `GPU_LAYERS` | `99` | Number of model layers to offload; set 0 for CPU-only |
| `CONTEXT_SIZE` | `8192` | Context length passed to llama.cpp |

## ROCm notes

Build llama.cpp with its HIP backend following the upstream llama.cpp build instructions for your ROCm installation. The app launches the binary and passes `--n-gpu-layers`, `--ctx-size`, and `--host 127.0.0.1`. It intentionally does not guess a device ID or ROCm architecture. Confirm the binary's own device flags and adjust `LLAMA_EXTRA_ARGS` if required.

## Safety

The app binds to loopback by default and only lists `.gguf` files in `MODEL_DIR`. Do not bind to a public interface without adding authentication and network protections. The local OpenAI-compatible endpoint is unauthenticated by design.
