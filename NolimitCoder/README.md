# NolimitCoder V3 — Ultra Modern Electron Chat + NolimitCoder models

Ultra modern Electron app by **NolimitCoder** — **chat at the bottom**, **NolimitCoder model picker at the top**. Everything via the NolimitCoder catalog. After download it runs **100% offline** — nothing else is needed.

![Ultra Modern](https://img.shields.io/badge/UI-Glassmorphism%20%2B%20Neon-7c3aed)
![Models](https://img.shields.io/badge/models-90%2B-06b6d4)
![Offline](https://img.shields.io/badge/offline-ready-22c55e)

## ✨ What it can do

- **Chat at the bottom** — modern input bar with `Enter` to send, `Shift+Enter` for a new line, streaming
- **Model picker** — NolimitCoder models (NolimitCoderV3, NolimitCoderV2):
  - OpenAI: GPT-6 Astra/Sol/Luna, GPT-5.6/5.5/5.4/5.3/5.2/5.1 + Codex variants
  - Anthropic: Claude Opus 5.5/5/4.8/4.7/4.5, Sonnet 5/4.6/4.5, Haiku 4.5, Fable 5.1
  - Google: Gemini 3.8/3.7/3.6/3.5 Flash, Gemini 3.1 Pro
  - xAI Grok 4.7/4.6/4.5, Muse Spark 1.3/1.2
  - Qwen, DeepSeek V4.1/V4, MiniMax M3/M2.7, GLM 5.3/5.2, Kimi K3/K2.7
  - **FREE models** (🎁 no API key needed): **NolimitCoder Pro**, Big Pickle, Ling, Nemotron, Muse Spark Free
  - **LOCAL models** (💻 offline): Ollama, LM Studio, vLLM — auto-detection on `127.0.0.1:11434/1234/8000`
- **Ultra design** — glassmorphism, neon gradients, blur, mesh background, 1440p ready
- **Offline first** — downloaded models (Ollama) run without internet, without a key, without limits
- **Live sync** — `↻ Refresh list` button + auto detection of local models
- **Streaming** via the main-process proxy (bypasses CORS), supports Ollama/LM Studio/NolimitCoder

## 🚀 Quick start

```bash
npm install
npm start        # dev - launches Electron
npm run build:win  # build the .exe installer into dist/
```

### 1) Without a key (right away):
- Pick a model with **🎁 FREE** (e.g. `Big Pickle`, `Muse Spark 1.3 Free`)
- Type and the chat works via the NolimitCoder gateway without a key

### 2) Local models:
- Install Ollama or LM Studio, download a model and select it in the app

### 3) 100% Offline (recommended):
```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh
# download models (once, then offline)
ollama pull llama3.3:70b
ollama pull qwen2.5-coder:32b
ollama pull deepseek-r1:32b
ollama serve
# in the app: LOCAL → pick llama3.3 — runs without internet
```
Or **LM Studio** (GUI): download a model → start the server on `127.0.0.1:1234` → the app auto-detects it.

## 🎨 UI

- **Top**: logo + status pill (90+ models) + settings
- **Left sidebar**: conversations, Ollama/LM Studio/Zen status, stats, offline badge
- **Center - model bar**: search + categories (ALL/OpenAI/Anthropic/.../FREE/LOCAL) + context badge
- **Center - chat**: bubbles, markdown, code blocks, streaming cursor
- **Bottom**: input bar (glass, rounded, shadow) + footer

## 🔧 Architecture

```
src/
  main/main.js       → BrowserWindow (hiddenInset, blur), IPC proxy for streaming, store.json
  preload/preload.js → contextBridge (api.*)
  renderer/
    index.html       → ultra layout
    style.css        → glassmorphism + neon
    models.js        → NolimitCoder model catalog
    renderer.js      → chat, model selector, Ollama/LM Studio discovery, streaming
```

- Streaming: renderer → `ipc: chat:stream-start` → main `https.request` SSE → `chat:stream-chunk` event
- Store: `%APPDATA%/nolimit-coder-v2/config.json` (zenApiKey, ollamaUrl, lmstudioUrl)
- No `electron --require` packers, clean CommonJS + vanilla JS (no build step)

## 📦 Build

```bash
npm run build      # default
npm run build:win  # Windows NSIS installer
# output: dist/NolimitCoder V2 Setup 2.0.0.exe
```

Icon: drop your own into `src/renderer/assets/icon.png` (optional, the build passes without it).

## ❓ Why is "nothing needed"?

After downloading a local model via Ollama/LM Studio you need neither internet nor a key. The app detects the model on localhost and generates locally. For cloud models just pick FREE (no key) or paste a single Zen key for all 90+ models — no per-provider configuration.

---
Made by NolimitCoder — models created by NolimitCoder
