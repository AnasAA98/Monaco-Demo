# Monaco Playground

An in-browser IDE built with [Next.js](https://nextjs.org), the [Monaco Editor](https://microsoft.github.io/monaco-editor/), and [Pyodide](https://pyodide.org). Runs both Python and JavaScript fully in the browser — no backend.

## Features

- **Python IDE** at `/` — runs CPython via Pyodide inside a Web Worker, with a 10s time-limit (TLE) enforced by the main thread.
- **JavaScript IDE** at `/ide` — runs in a sandboxed iframe.
- `Cmd`/`Ctrl` + `Enter` to run.
- Live console capturing stdout/stderr.
- Persistent Pyodide worker (initialized once, reused across runs).

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Project structure

```
src/
  app/
    layout.js         # Root layout, fonts, metadata
    globals.css       # Theme tokens + base styles
    page.jsx          # Python IDE route (/)
    ide/page.jsx      # JavaScript IDE route (/ide)
  components/
    PythonIDE.jsx     # Monaco + Pyodide worker UI
    CodeEditor.jsx    # Monaco + sandboxed JS runner UI
public/
  pyodideWorker.js    # Pyodide bootstrapping + run loop
```

## Scripts

- `npm run dev` — start the dev server
- `npm run build` — production build
- `npm run start` — run the production build
- `npm run lint` — lint with ESLint
