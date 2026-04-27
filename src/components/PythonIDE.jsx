'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

const TIME_LIMIT_MS = 10000;
const STARTER_CODE = `# Welcome to the Monaco + Pyodide Python IDE
# Press Cmd/Ctrl + Enter to run.

def greet(name):
    return f"Hello, {name}!"

print(greet("Monaco"))
`;

export default function PythonIDE() {
  const editorRef = useRef(null);
  const workerRef = useRef(null);
  const timerRef = useRef(null);
  const busyRef = useRef(false);

  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  const appendOutput = useCallback((text) => {
    setOutput((o) => o + text);
  }, []);

  const cleanupRun = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    busyRef.current = false;
    setBusy(false);
  }, []);

  const spawnWorker = useCallback(() => {
    const worker = new Worker('/pyodideWorker.js');
    worker.onmessage = (e) => {
      const { type, msg, result, error, elapsed } = e.data;
      switch (type) {
        case 'ready':
          setReady(true);
          break;
        case 'stdout':
        case 'stderr':
          appendOutput(msg);
          break;
        case 'done':
          if (result) appendOutput(result + '\n');
          appendOutput(`\n✔ Finished in ${elapsed} ms\n`);
          cleanupRun();
          break;
        case 'error':
          appendOutput('✖ ' + error + '\n');
          cleanupRun();
          break;
        default:
          break;
      }
    };
    workerRef.current = worker;
    return worker;
  }, [appendOutput, cleanupRun]);

  useEffect(() => {
    spawnWorker();
    return () => {
      workerRef.current?.terminate();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [spawnWorker]);

  const runCode = useCallback(() => {
    if (busyRef.current) return;
    const code = editorRef.current?.getValue() ?? '';
    if (!code.trim()) return;

    busyRef.current = true;
    setBusy(true);
    setOutput('▶ Running…\n\n');

    timerRef.current = setTimeout(() => {
      workerRef.current?.terminate();
      setReady(false);
      appendOutput(`\n⏱ Time limit exceeded (${TIME_LIMIT_MS} ms). Worker restarted.\n`);
      cleanupRun();
      spawnWorker();
    }, TIME_LIMIT_MS);

    workerRef.current?.postMessage({ type: 'run', code });
  }, [appendOutput, cleanupRun, spawnWorker]);

  const handleEditorMount = (editor, monaco) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runCode());
  };

  const statusLabel = !ready ? 'Loading Pyodide…' : busy ? 'Running' : 'Ready';
  const statusColor = !ready ? 'var(--warning)' : busy ? 'var(--accent)' : 'var(--success)';

  return (
    <div className="ide-shell">
      <header className="ide-header">
        <div className="ide-title">
          <span className="ide-logo">🐍</span>
          <h1>Python IDE</h1>
          <span className="ide-subtitle">Monaco + Pyodide</span>
        </div>
        <nav className="ide-nav">
          <a href="/">Home</a>
          <a href="/ide">JavaScript</a>
        </nav>
      </header>

      <div className="ide-body">
        <section className="ide-pane ide-pane-editor">
          <div className="ide-pane-header">
            <span className="ide-pane-title">main.py</span>
            <span className="ide-hint">
              <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd> to run
            </span>
          </div>
          <div className="ide-editor">
            <MonacoEditor
              height="100%"
              defaultLanguage="python"
              defaultValue={STARTER_CODE}
              theme="vs-dark"
              onMount={handleEditorMount}
              options={{
                minimap: { enabled: false },
                fontSize: 14,
                fontFamily: 'var(--font-geist-mono), Menlo, monospace',
                scrollBeyondLastLine: false,
                smoothScrolling: true,
                cursorBlinking: 'smooth',
                padding: { top: 12, bottom: 12 },
                tabSize: 4,
              }}
            />
          </div>
        </section>

        <section className="ide-pane ide-pane-console">
          <div className="ide-pane-header">
            <span className="ide-pane-title">Console</span>
            <div className="ide-actions">
              <button
                className="primary"
                disabled={busy || !ready}
                onClick={runCode}
                title="Run (⌘/Ctrl + Enter)"
              >
                {busy ? 'Running…' : !ready ? 'Loading…' : '▶ Run'}
              </button>
              <button onClick={() => setOutput('')} disabled={busy}>
                Clear
              </button>
            </div>
          </div>
          <pre className="ide-console">
            {output ||
              'Welcome to the Python IDE.\nWrite some code on the left, then press ⌘/Ctrl + Enter to run.'}
          </pre>
          <div className="ide-statusbar">
            <span className="ide-status-dot" style={{ background: statusColor }} />
            <span>{statusLabel}</span>
            <span className="ide-spacer" />
            <span>Time limit: {TIME_LIMIT_MS / 1000}s</span>
          </div>
        </section>
      </div>

      <style jsx>{`
        .ide-shell {
          display: flex;
          flex-direction: column;
          height: 100vh;
          background: var(--bg);
        }
        .ide-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0.65rem 1rem;
          border-bottom: 1px solid var(--border);
          background: var(--bg-elev);
        }
        .ide-title {
          display: flex;
          align-items: center;
          gap: 0.6rem;
        }
        .ide-logo {
          font-size: 1.25rem;
        }
        .ide-title h1 {
          font-size: 1rem;
          font-weight: 600;
          letter-spacing: -0.01em;
        }
        .ide-subtitle {
          color: var(--text-muted);
          font-size: 0.8rem;
        }
        .ide-nav {
          display: flex;
          gap: 0.25rem;
        }
        .ide-nav a {
          padding: 0.4rem 0.75rem;
          border-radius: 6px;
          color: var(--text-dim);
          font-size: 0.85rem;
          transition: background 120ms ease, color 120ms ease;
        }
        .ide-nav a:hover {
          background: var(--bg-panel);
          color: var(--text);
        }
        .ide-body {
          flex: 1;
          display: flex;
          min-height: 0;
        }
        .ide-pane {
          display: flex;
          flex-direction: column;
          min-width: 0;
        }
        .ide-pane-editor {
          flex: 1.6;
          border-right: 1px solid var(--border);
        }
        .ide-pane-console {
          flex: 1;
          background: var(--bg-elev);
        }
        .ide-pane-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0.5rem 0.85rem;
          border-bottom: 1px solid var(--border);
          background: var(--bg-elev);
        }
        .ide-pane-title {
          font-family: var(--mono);
          font-size: 0.8rem;
          color: var(--text-dim);
        }
        .ide-hint {
          color: var(--text-muted);
          font-size: 0.75rem;
        }
        .ide-actions {
          display: flex;
          gap: 0.4rem;
        }
        .ide-editor {
          flex: 1;
          min-height: 0;
        }
        .ide-console {
          flex: 1;
          margin: 0;
          padding: 0.85rem 1rem;
          font-family: var(--mono);
          font-size: 0.85rem;
          line-height: 1.55;
          color: var(--text);
          background: var(--bg-panel);
          overflow-y: auto;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .ide-statusbar {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.4rem 0.85rem;
          border-top: 1px solid var(--border);
          background: var(--bg-elev);
          font-size: 0.75rem;
          color: var(--text-dim);
        }
        .ide-status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          display: inline-block;
        }
        .ide-spacer {
          flex: 1;
        }
        @media (max-width: 800px) {
          .ide-body {
            flex-direction: column;
          }
          .ide-pane-editor {
            border-right: none;
            border-bottom: 1px solid var(--border);
          }
        }
      `}</style>
    </div>
  );
}
