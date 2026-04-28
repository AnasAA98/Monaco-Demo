# Monaco Playground

An in-browser IDE built with [Next.js](https://nextjs.org), the [Monaco Editor](https://microsoft.github.io/monaco-editor/), and [Pyodide](https://pyodide.org). Runs **Python** and **JavaScript** fully in the browser, with **real-time collaborative editing** powered by [Yjs](https://yjs.dev) and a tiny y-websocket server.

A segmented language toggle in the header switches runtimes in place; both are kept warm so toggling is instant. Open the same URL in two browsers and you can edit the same files together — every keystroke, every tab open/rename/close, every cursor position syncs.

## Features

- **One page, two runtimes.** Toggle between Python and JavaScript without leaving `/`.
- **Python via Pyodide** in a Web Worker, with a 10 s time-limit enforced by terminating the worker. Stdout / stderr stream live; auto-installs known packages on `import` (`numpy`, `pandas`, …).
- **JavaScript in a sandboxed iframe** (`sandbox="allow-scripts"`, no `allow-same-origin`). `console.log/info/warn/error` is proxied; runtime errors and unhandled promise rejections are captured.
- **Real-time collaboration.** Anyone with the room URL (`?room=<id>`) joins the same shared Yjs document. Tab list, file content, and cursor positions sync live. Each peer has a name and color visible to others.
- **Multi-file tabs** per language. Click to switch, double-click to rename, `+` to add, `×` to close. Files live in the shared Yjs doc, not localStorage.
- **Per-tab Monaco models** bound to per-file `Y.Text` instances; cursor and undo survive tab switches, remote cursors render inline.
- **`⌘`/`Ctrl + Enter`** to run the active file.
- **Live console** with elapsed-time readout, status bar, file count, runtime status dot, and a connection pill (`Connecting…` / `Live · N users` / `Offline`).

## Getting started

```bash
# install front-end deps
npm install

# install the collab server's deps (separate package)
cd server && npm install && cd ..

# run both processes (Next on :3000, collab server on :1234)
npm run dev:all
```

Open [http://localhost:3000](http://localhost:3000). The URL gets a `?room=<id>` appended automatically. To collaborate, share that URL with someone else (or open it in another browser tab).

On first load, Pyodide downloads ~6 MB from the jsdelivr CDN; subsequent loads are cached.

If you only want the local IDE without collaboration, `npm run dev` still works — the editor will show "Offline" in the status pill but everything else runs.

## Project structure

```
src/
  app/
    layout.js              # Root layout, Google Fonts <link>, metadata
    globals.css            # Theme tokens, base styles, scrollbars
    page.jsx               # Dynamically mounts <Playground /> (CSR-only)
  components/
    Playground.jsx         # Unified IDE: language toggle, tabs, both runtimes
    useCollab.js           # Yjs document + WebsocketProvider + awareness
    ide.module.css         # Scoped styles for the IDE chrome
public/
  pyodideWorker.js         # Pyodide bootstrap + run loop (Web Worker)
server/
  package.json             # ws + y-websocket + yjs (separate from front-end)
  index.js                 # ~25 lines: HTTP + WS, delegates to setupWSConnection
```

## Keyboard shortcuts

| Shortcut           | Action               |
|--------------------|----------------------|
| `⌘`/`Ctrl + Enter` | Run the active file  |

## Collaboration model

- **What's shared:** the tab list (per language) and the contents of every file. Awareness publishes each peer's name, color, cursor, and selection.
- **What's not shared:** running code. Pressing Run executes locally in your tab; the console output is private. The active language toggle is also a per-browser preference.
- **Identity:** a random animal name and color are generated on first visit and stored in localStorage; both are editable. They're broadcast through Yjs awareness, not the doc.
- **Rooms:** the room id is the `?room=` query parameter. If absent, a 6-character id is generated and inserted via `history.replaceState`. The Share button copies the current URL to your clipboard.

## Storage

LocalStorage is now used only for personal preferences:

- `monaco-active-lang-v1` — last used language
- `monaco-collab-name-v1` — your display name
- `monaco-collab-color-v1` — your cursor color

File contents and tab lists live in the shared Yjs document. Clear localStorage in DevTools to reset preferences; clear the room (or use a new room id) to reset the files.

## Environment

Override the WebSocket URL at build time if your collab server lives somewhere other than the page origin on port 1234:

```bash
NEXT_PUBLIC_COLLAB_WS=wss://collab.example.com npm run build
```

## Scripts

- `npm run dev` — Next dev server only (port 3000)
- `npm run dev:server` — collab WebSocket server only (port 1234)
- `npm run dev:all` — both, in parallel, with color-coded prefixes
- `npm run build` — production build of the front-end
- `npm run start` — serve the production build
- `npm run lint` — lint with ESLint

## Further reading

For a deep dive on architecture, the collaboration design, every component, every design decision, and the project history commit-by-commit, see [PROJECT.md](PROJECT.md). Section 10 is the full write-up of the Yjs / y-websocket integration.
