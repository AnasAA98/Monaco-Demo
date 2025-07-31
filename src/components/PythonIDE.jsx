'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';

/* -------------------------------------------------
 *  Monaco loads only on the client (avoids SSR issues)
 * ------------------------------------------------- */
const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

export default function PythonIDE() {
  /* refs & state */
  const editorRef        = useRef(null);
  const [pyodide, setPyodide] = useState(null);
  const [output,  setOutput]  = useState('');
  const [busy,    setBusy]    = useState(false);

  /* -------------------------------------------------
   *  Load Pyodide once via <script> tag (works with Webpack & Turbopack)
   * ------------------------------------------------- */
  useEffect(() => {
    let cancelled = false;

    async function bootPyodide() {
      /* if the script is already present (hot-reload) just reuse it */
      if (window.loadPyodide) {
        const py = await window.loadPyodide({
          stdout: (msg) => setOutput((o) => o + msg),
          stderr: (msg) => setOutput((o) => o + msg),
        });
        if (!cancelled) setPyodide(py);
        return;
      }

      /* inject the script */
      const script = document.createElement('script');
      script.src   = 'https://cdn.jsdelivr.net/pyodide/v0.28.0/full/pyodide.js';
      script.onload = async () => {
        const py = await window.loadPyodide({
          stdout: (msg) => setOutput((o) => o + msg),
          stderr: (msg) => setOutput((o) => o + msg),
        });
        if (!cancelled) setPyodide(py);
      };
      document.body.appendChild(script);
    }

    bootPyodide();
    return () => { cancelled = true; };
  }, []);

  /* -------------------------------------------------
   *  Run button handler
   * ------------------------------------------------- */
  const runCode = async () => {
    if (!pyodide) return;
    setBusy(true);
    setOutput('▶️ Running Python code…\n');
    const code = editorRef.current?.getValue() ?? '';
    try {
      await pyodide.loadPackagesFromImports(code);
      await pyodide.runPythonAsync(code);
    } catch (err) {
      setOutput((o) => o + `❌ ${err}\n`);
    } finally {
      setBusy(false);
    }
  };

  /* -------------------------------------------------
   *  Layout
   * ------------------------------------------------- */
  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 4rem)' }}>
      {/* editor pane */}
      <div style={{ flex: 1 }}>
        <MonacoEditor
          height="100%"
          defaultLanguage="python"
          defaultValue={`print("Hello, Monaco + Pyodide!")`}
          theme="vs-dark"
          onMount={(editor) => { editorRef.current = editor; }}
          options={{ minimap: { enabled: false } }}
        />
      </div>

      {/* console pane */}
      <div
        style={{
          width: '32%',
          background: '#1e1e1e',
          color: '#c7c7c7',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ padding: '0.5rem', borderBottom: '1px solid #333' }}>
          <button
            disabled={!pyodide || busy}
            onClick={runCode}
            style={{
              padding: '0.4rem 0.8rem',
              borderRadius: 4,
              background: '#0d6efd',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? 'Running…' : 'Run Python'}
          </button>{' '}
          <button
            onClick={() => setOutput('')}
            style={{
              padding: '0.4rem 0.8rem',
              borderRadius: 4,
              background: '#6c757d',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Clear
          </button>
        </div>

        <pre
          style={{
            flex: 1,
            margin: 0,
            padding: '0.75rem',
            fontFamily: 'Menlo, monospace',
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
          }}
        >
          {output || 'Welcome to Monaco Python IDE 🐍\nClick “Run Python” to execute your code.'}
        </pre>
      </div>
    </div>
  );
}
