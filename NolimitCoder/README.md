# NolimitCoder V3 — Ultra Modern Electron Chat + modely NolimitCoder

Ultra moderní Electron aplikace od **NolimitCoder** — **chat dole**, **výběr modelů NolimitCoder nahoře**. Vše přes katalog NolimitCoder. Po stažení běží **100% offline** — není nic potřeba.

![Ultra Modern](https://img.shields.io/badge/UI-Glassmorphism%20%2B%20Neon-7c3aed)
![Models](https://img.shields.io/badge/models-90%2B-06b6d4)
![Offline](https://img.shields.io/badge/offline-ready-22c55e)

## ✨ Co to umí

- **Chat dole** — moderní input bar s `Enter` odeslat, `Shift+Enter` nový řádek, streaming
- **Výběr modelů** — modely NolimitCoder (NolimitCoderV3, NolimitCoderV2):
  - OpenAI: GPT-6 Astra/Sol/Luna, GPT-5.6/5.5/5.4/5.3/5.2/5.1 + Codex varianty
  - Anthropic: Claude Opus 5.5/5/4.8/4.7/4.5, Sonnet 5/4.6/4.5, Haiku 4.5, Fable 5.1
  - Google: Gemini 3.8/3.7/3.6/3.5 Flash, Gemini 3.1 Pro
  - xAI Grok 4.7/4.6/4.5, Muse Spark 1.3/1.2
  - Qwen, DeepSeek V4.1/V4, MiniMax M3/M2.7, GLM 5.3/5.2, Kimi K3/K2.7
  - **FREE modely** (🎁 bez API klíče): Big Pickle, Space Bunny, MiMo, Ling, Nemotron, Muse Spark Free
  - **LOCAL modely** (💻 offline): Ollama, LM Studio, vLLM — auto-detekce na `127.0.0.1:11434/1234/8000`
- **Ultra design** — glassmorphism, neon gradienty, blur, mesh background, 1440p ready
- **Offline first** — stažené modely (Ollama) běží bez internetu, bez klíče, bez limitu
- **Live sync** — tlačítko `↻ Obnovit seznam` + auto detekce lokálních
- **Streaming** přes main-process proxy (obchází CORS), podpora Ollama/LM Studio/NolimitCoder

## 🚀 Rychlý start

```bash
npm install
npm start        # dev - spustí Electron
npm run build:win  # build .exe instalátor do dist/
```

### 1) Bez klíče (ihned):
- Vyber model s **🎁 FREE** (např. `Big Pickle`, `Muse Spark 1.3 Free`)
- Piš a chat funguje přes bránu NolimitCoder bez klíče

### 2) Lokální modely:
- Nainstaluj Ollama nebo LM Studio, stáhni model a vyber ho v aplikaci

### 3) 100% Offline (doporučeno):
```bash
# Nainstaluj Ollama
curl -fsSL https://ollama.com/install.sh | sh
# stáhni modely (jednou, pak offline)
ollama pull llama3.3:70b
ollama pull qwen2.5-coder:32b
ollama pull deepseek-r1:32b
ollama serve
# v app: LOCAL → vyber llama3.3 — jede bez internetu
```
Nebo **LM Studio** (GUI): stáhni model → start server na `127.0.0.1:1234` → app auto-detekuje.

## 🎨 UI

- **Nahoře**: logo + status pill (90+ modelů) + nastavení
- **Sidebar vlevo**: konverzace, stav Ollama/LM Studio/Zen, stats, offline badge
- **Střed - model bar**: vyhledávání + kategorie (VŠE/OpenAI/Anthropic/.../FREE/LOCAL) + context badge
- **Střed - chat**: bubliny, markdown, code blocks, streaming kurzor
- **Dole**: input bar (glass, rounded, shadow) + footer

## 🔧 Architektura

```
src/
  main/main.js       → BrowserWindow (hiddenInset, blur), IPC proxy pro streaming, store.json
  preload/preload.js → contextBridge (api.*)
  renderer/
    index.html       → ultra layout
    style.css        → glassmorphism + neon
    models.js        → katalog modelů NolimitCoder
    renderer.js      → chat, model selector, Ollama/LM Studio discovery, streaming
```

- Streaming: renderer → `ipc: chat:stream-start` → main `https.request` SSE → `chat:stream-chunk` event
- Store: `%APPDATA%/nolimit-coder-v2/config.json` (zenApiKey, ollamaUrl, lmstudioUrl)
- Žádné `electron --require` packery, čistý CommonJS + vanilla JS (žádný build step)

## 📦 Build

```bash
npm run build      # default
npm run build:win  # Windows NSIS installer
# výstup: dist/NolimitCoder V2 Setup 2.0.0.exe
```

Ikona: vlož vlastní do `src/renderer/assets/icon.png` (volitelné, build projde i bez).

## ❓ Proč "není nic potřeba"?

Po stažení lokálního modelu přes Ollama/LM Studio **nepotřebuješ** internet ani klíč. App detekuje model na localhost a generuje lokálně. Pro cloud modely stačí vybrat FREE (bez klíče) nebo vložit jeden Zen klíč pro všech 90+ modelů — žádná konfigurace providerů zvlášť.

---
Made by NolimitCoder — modely vytvořilo NolimitCoder
