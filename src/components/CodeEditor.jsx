'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

const STARTER_CODE = `// Welcome to the JavaScript IDE
// Press Cmd/Ctrl + Enter to run.

function fib(n) {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

console.log("fib(10) =", fib(10));
`;

const SANDBOX_HTML = `<!doctype html><html><body><script>
  const send = (level, args) => parent.postMessage({
    __js_ide: true, level,
    msg: args.map(a => {
      try { return typeof a === 'string' ? a : JSON.stringify(a); }
      catch { return String(a); }
    }).join(' ')
  }, '*');
  ['log','info','warn','error'].forEach(level => {
    const orig = console[level];
    console[level] = (...args) => { send(level, args); orig.apply(console, args); };
  });
  window.addEventListener('error', e => send('error', [e.message]));
  window.addEventListener('message', e => {
    if (e.data && e.data.__js_ide_run) {
      try { (0, eval)(e.data.code); send('log', ['\\n✔ Done']); }
      catch (err) { send('error', [String(err)]); }
    }
  });
  parent.postMessage({ __js_ide: true, level: 'ready' }, '*');
<\/script></body></html>`;

export default function CodeEditor() {
  const editorRef = useRef(null);
  const iframeRef = useRef(null);
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  const append = useCallback((level, msg) => {
    const prefix = level === 'error' ? '✖ ' : level === 'warn' ? '⚠ ' : '';
    setOutput((o) => o + prefix + msg + '\n');
  }, []);

  useEffect(() => {
    const onMsg = (e) => {
      const data = e.data;
      if (!data || !data.__js_ide) return;
      if (data.level === 'ready') {
        setReady(true);
        return;
      }
      append(data.level, data.msg);
      if (data.msg && data.msg.includes('✔ Done')) setBusy(false);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [append]);

  const runCode = useCallback(() => {
    if (busy || !ready) return;
    const code = editorRef.current?.getValue() ?? '';
    if (!code.trim()) return;
    setOutput('▶ Running…\n\n');
    setBusy(true);
    iframeRef.current?.contentWindow?.postMessage({ __js_ide_run: true, code }, '*');
  }, [busy, ready]);

  const handleEditorMount = (editor, monaco) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runCode());
  };

  const statusLabel = !ready ? 'Initializing…' : busy ? 'Running' : 'Ready';
  const statusColor = !ready ? 'var(--warning)' : busy ? 'var(--accent)' : 'var(--success)';

  return (
    <div className="ide-shell">
      <header className="ide-header">
        <div className="ide-title">
          <span className="ide-logo">⚡</span>
          <h1>JavaScript IDE</h1>
          <span className="ide-subtitle">Monaco</span>
        </div>
        <nav className="ide-nav">
          <a href="/">Home</a>
          <a href="/">Python</a>
        </nav>
      </header>

      <div className="ide-body">
        <section className="ide-pane ide-pane-editor">
          <div className="ide-pane-header">
            <span className="ide-pane-title">main.js</span>
            <span className="ide-hint">
              <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd> to run
            </span>
          </div>
          <div className="ide-editor">
            <MonacoEditor
              height="100%"
              defaultLanguage="javascript"
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
                tabSize: 2,
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
              'Welcome to the JavaScript IDE.\nWrite some code on the left, then press ⌘/Ctrl + Enter to run.'}
          </pre>
          <div className="ide-statusbar">
            <span className="ide-status-dot" style={{ background: statusColor }} />
            <span>{statusLabel}</span>
            <span className="ide-spacer" />
            <span>Sandboxed in iframe</span>
          </div>
        </section>
      </div>

      <iframe
        ref={iframeRef}
        title="js-sandbox"
        sandbox="allow-scripts"
        srcDoc={SANDBOX_HTML}
        style={{ display: 'none' }}
      />

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
