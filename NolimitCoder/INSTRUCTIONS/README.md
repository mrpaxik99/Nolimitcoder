# INSTRUCTIONS — instructions for the AI, by project type

Each project type has its own folder with a full instruction file.
The app loads these files at startup and uses them as the system prompt.
If a file is missing, the app falls back to the built-in defaults in the code.

- `commercial/` — 🎬 AI Commercial Video: HTML video ads ONLY, full access (write etc.)
- `website/` — 🌐 Website Project: normal websites, full access
- `universal/` — 📁 Universal Project: anything, full access

File format: sections starting with `## NAME` (BUILD, CHAT, PLAN, VIDEO, TOOLS, FORBIDDEN).
Edit the text freely — no rebuild needed for prompt changes, just restart the app.
