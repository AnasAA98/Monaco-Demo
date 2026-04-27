# Monaco Playground

An in-browser IDE built with [Next.js](https://nextjs.org), the [Monaco Editor](https://microsoft.github.io/monaco-editor/), and [Pyodide](https://pyodide.org). Runs **Python** and **JavaScript** fully in the browser — no backend, no server execution.

A segmented language toggle in the header switches runtimes in place; both are kept warm so toggling is instant. Multi-file tabs, persistent storage, keyboard shortcuts, and a hardened execution sandbox for each language.

## Features

- **One page, two runtimes.** Toggle between Python and JavaScript without leaving `/`.
- **Python via Pyodide** in a Web Worker, with a 10 s time-limit enforced by terminating the worker. Stdout / stderr stream live; auto-installs known packages on `import` (`numpy`, `pandas`, …).
- **JavaScript in a sandboxed iframe** (`sandbox="allow-scripts"`, no `allow-same-origin`). `console.log/info/warn/error` is proxied; runtime errors and unhandled promise rejections are captured.
- **Multi-file tabs** per language. Click to switch, double-click to rename, `+` to add, `×` to close. Files persist to `localStorage`.
- **Per-tab Monaco models** so cursor position and undo history survive tab switches.
- **`⌘`/`Ctrl + Enter`** to run the active file.
- **Live console** with elapsed-time readout, status bar, file count, and runtime-aware status dot.
- **Modern UI** — Roboto / Roboto Mono from Google Fonts, layered dark theme, refined typography.

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

On first load, Pyodide downloads ~6 MB from the jsdelivr CDN; subsequent loads are cached.

## Project structure

```
src/
  app/
    layout.js              # Root layout, Google Fonts <link>, metadata
    globals.css            # Theme tokens, base styles, scrollbars
    page.jsx               # Mounts <Playground />
  components/
    Playground.jsx         # Unified IDE: language toggle, tabs, both runtimes
    ide.module.css         # Scoped styles for the IDE chrome
public/
  pyodideWorker.js         # Pyodide bootstrap + run loop (Web Worker)
```

## Keyboard shortcuts

| Shortcut         | Action                       |
|------------------|------------------------------|
| `⌘`/`Ctrl + Enter` | Run the active file        |

## Storage

Files and the active language are persisted to `localStorage`:

- `monaco-py-files-v1` — Python tabs
- `monaco-js-files-v1` — JavaScript tabs
- `monaco-active-lang-v1` — last used language

Clear these in DevTools to reset to the starter files.

## Scripts

- `npm run dev` — start the dev server
- `npm run build` — production build
- `npm run start` — run the production build
- `npm run lint` — lint with ESLint

## Further reading

For a deep dive on architecture, every component, every design decision, and the project history commit-by-commit, see [PROJECT.md](PROJECT.md).
