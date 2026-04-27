'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import s from './ide.module.css';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

const TIME_LIMIT_MS = 10000;

const STORAGE_KEYS = {
  python: 'monaco-py-files-v1',
  javascript: 'monaco-js-files-v1',
  lang: 'monaco-active-lang-v1',
};

const STARTERS = {
  python: [
    {
      name: 'main.py',
      content: `# Welcome to the Python IDE
# Press Cmd/Ctrl + Enter to run.

def greet(name):
    return f"Hello, {name}!"

print(greet("Monaco"))
`,
    },
  ],
  javascript: [
    {
      name: 'main.js',
      content: `// Welcome to the JavaScript IDE
// Press Cmd/Ctrl + Enter to run.

function fib(n) {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

console.log("fib(10) =", fib(10));
`,
    },
  ],
};

const LANG_META = {
  python: { label: 'Python', short: 'Py', monacoLang: 'python', tabSize: 4, ext: '.py' },
  javascript: { label: 'JavaScript', short: 'JS', monacoLang: 'javascript', tabSize: 2, ext: '.js' },
};

const SANDBOX_HTML = `<!doctype html>
<html><head><meta charset="utf-8" /></head><body>
<script>
(function () {
  function format(a) {
    if (a instanceof Error) return a.stack || a.message || String(a);
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch (_) { return String(a); }
  }
  function send(level, args) {
    parent.postMessage({
      __js_ide: true, level: level,
      msg: Array.prototype.map.call(args, format).join(' ')
    }, '*');
  }
  ['log','info','warn','error','debug'].forEach(function (level) {
    var orig = console[level] ? console[level].bind(console) : function () {};
    console[level] = function () {
      send(level === 'debug' ? 'log' : level, arguments);
      try { orig.apply(null, arguments); } catch (_) {}
    };
  });
  window.addEventListener('error', function (e) {
    send('error', [e.message + (e.filename ? ' (' + e.filename + ':' + e.lineno + ')' : '')]);
  });
  window.addEventListener('unhandledrejection', function (e) {
    send('error', ['Unhandled rejection: ' + format(e.reason)]);
  });
  window.addEventListener('message', function (e) {
    var data = e.data;
    if (!data || data.__js_ide_run !== true) return;
    var runId = data.runId;
    function done() { parent.postMessage({ __js_ide: true, level: 'done', runId: runId }, '*'); }
    try {
      var result = (0, eval)(data.code);
      if (result && typeof result.then === 'function') {
        result.then(done, function (err) { send('error', [format(err)]); done(); });
      } else { done(); }
    } catch (err) {
      send('error', [format(err)]);
      done();
    }
  });
  // Tell the parent we're alive. Send once immediately, then again on
  // window 'load' in case the parent listener wasn't attached yet.
  function ping() { parent.postMessage({ __js_ide: true, level: 'ready' }, '*'); }
  ping();
  window.addEventListener('load', ping);
})();
</script>
</body></html>`;

function loadFiles(lang) {
  if (typeof window === 'undefined') return STARTERS[lang];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS[lang]);
    if (!raw) return STARTERS[lang];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {}
  return STARTERS[lang];
}

function loadLang() {
  if (typeof window === 'undefined') return 'python';
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.lang);
    if (raw === 'python' || raw === 'javascript') return raw;
  } catch {}
  return 'python';
}

export default function Playground() {
  // Per-language file state
  const [pyFiles, setPyFiles] = useState(STARTERS.python);
  const [jsFiles, setJsFiles] = useState(STARTERS.javascript);
  const [pyActive, setPyActive] = useState(STARTERS.python[0].name);
  const [jsActive, setJsActive] = useState(STARTERS.javascript[0].name);
  const [lang, setLang] = useState('python');
  const [hydrated, setHydrated] = useState(false);

  // UI state
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pyReady, setPyReady] = useState(false);
  const [jsReady, setJsReady] = useState(false);

  // Refs
  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const modelsRef = useRef(new Map()); // key: `${lang}:${name}` -> ITextModel
  const workerRef = useRef(null);
  const timerRef = useRef(null);
  const busyRef = useRef(false);
  const iframeRef = useRef(null);
  const runIdRef = useRef(0);

  // Hydrate from localStorage on mount
  useEffect(() => {
    const py = loadFiles('python');
    const js = loadFiles('javascript');
    const initialLang = loadLang();
    setPyFiles(py);
    setJsFiles(js);
    setPyActive(py[0].name);
    setJsActive(js[0].name);
    setLang(initialLang);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try { window.localStorage.setItem(STORAGE_KEYS.python, JSON.stringify(pyFiles)); } catch {}
  }, [pyFiles, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try { window.localStorage.setItem(STORAGE_KEYS.javascript, JSON.stringify(jsFiles)); } catch {}
  }, [jsFiles, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try { window.localStorage.setItem(STORAGE_KEYS.lang, lang); } catch {}
  }, [lang, hydrated]);

  // Helpers to read/write the active language's files
  const files = lang === 'python' ? pyFiles : jsFiles;
  const setFiles = lang === 'python' ? setPyFiles : setJsFiles;
  const activeFile = lang === 'python' ? pyActive : jsActive;
  const setActiveFile = lang === 'python' ? setPyActive : setJsActive;

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

  // ---------- Pyodide worker ----------
  const spawnWorker = useCallback(() => {
    const worker = new Worker('/pyodideWorker.js');
    worker.onmessage = (e) => {
      const { type, msg, result, error, elapsed } = e.data;
      switch (type) {
        case 'ready':
          setPyReady(true);
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

  // ---------- JS sandbox listener ----------
  useEffect(() => {
    const onMsg = (e) => {
      const data = e.data;
      if (!data || data.__js_ide !== true) return;
      if (data.level === 'ready') {
        setJsReady(true);
        return;
      }
      if (data.level === 'done') {
        appendOutput('\n✔ Done\n');
        cleanupRun();
        return;
      }
      const prefix = data.level === 'error' ? '✖ ' : data.level === 'warn' ? '⚠ ' : '';
      appendOutput(prefix + data.msg + '\n');
    };
    window.addEventListener('message', onMsg);
    // Fallback: if no ready signal arrives within 2s, assume the sandbox is up.
    // (Hidden iframes with srcDoc occasionally swallow the load event.)
    const fallback = setTimeout(() => setJsReady(true), 2000);
    return () => {
      window.removeEventListener('message', onMsg);
      clearTimeout(fallback);
    };
  }, [appendOutput, cleanupRun]);

  // ---------- Monaco models ----------
  const getModel = useCallback((langKey, name, content) => {
    const monaco = monacoRef.current;
    if (!monaco) return null;
    const key = `${langKey}:${name}`;
    const existing = modelsRef.current.get(key);
    if (existing) return existing;
    const uri = monaco.Uri.parse(`inmemory://${langKey}/${encodeURIComponent(name)}`);
    const model = monaco.editor.createModel(content, LANG_META[langKey].monacoLang, uri);
    model.onDidChangeContent(() => {
      const value = model.getValue();
      const setter = langKey === 'python' ? setPyFiles : setJsFiles;
      setter((prev) => prev.map((f) => (f.name === name ? { ...f, content: value } : f)));
    });
    modelsRef.current.set(key, model);
    return model;
  }, []);

  // Switch model when active file or language changes
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !monacoRef.current) return;
    const file = files.find((f) => f.name === activeFile);
    if (!file) return;
    const model = getModel(lang, file.name, file.content);
    if (model && editor.getModel() !== model) {
      editor.setModel(model);
      editor.focus();
    }
  }, [lang, activeFile, files, getModel]);

  // ---------- Run dispatch ----------
  const runCode = useCallback(() => {
    if (busyRef.current) return;
    const file = files.find((f) => f.name === activeFile);
    const code = file?.content ?? '';
    if (!code.trim()) return;

    if (lang === 'python') {
      if (!pyReady) return;
      busyRef.current = true;
      setBusy(true);
      setOutput(`▶ Running ${activeFile}…\n\n`);
      timerRef.current = setTimeout(() => {
        workerRef.current?.terminate();
        setPyReady(false);
        appendOutput(`\n⏱ Time limit exceeded (${TIME_LIMIT_MS} ms). Worker restarted.\n`);
        cleanupRun();
        spawnWorker();
      }, TIME_LIMIT_MS);
      workerRef.current?.postMessage({ type: 'run', code });
    } else {
      if (!jsReady) return;
      busyRef.current = true;
      setBusy(true);
      setOutput(`▶ Running ${activeFile}…\n\n`);
      const runId = ++runIdRef.current;
      iframeRef.current?.contentWindow?.postMessage(
        { __js_ide_run: true, code, runId },
        '*'
      );
    }
  }, [files, activeFile, lang, pyReady, jsReady, appendOutput, cleanupRun, spawnWorker]);

  const runCodeRef = useRef(runCode);
  useEffect(() => {
    runCodeRef.current = runCode;
  }, [runCode]);

  const handleEditorMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    const file = files.find((f) => f.name === activeFile) ?? files[0];
    const model = getModel(lang, file.name, file.content);
    if (model) editor.setModel(model);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runCodeRef.current());
  };

  // ---------- Tab actions (operate on active language) ----------
  const addFile = () => {
    const ext = LANG_META[lang].ext;
    const base = 'untitled';
    let n = 1;
    let name = `${base}${ext}`;
    const taken = new Set(files.map((f) => f.name));
    while (taken.has(name)) {
      n += 1;
      name = `${base}${n}${ext}`;
    }
    setFiles((prev) => [...prev, { name, content: '' }]);
    setActiveFile(name);
  };

  const closeFile = (name) => {
    if (files.length === 1) return;
    const key = `${lang}:${name}`;
    const model = modelsRef.current.get(key);
    if (model) {
      model.dispose();
      modelsRef.current.delete(key);
    }
    const idx = files.findIndex((f) => f.name === name);
    const next = files.filter((f) => f.name !== name);
    setFiles(next);
    if (activeFile === name) {
      const fallback = next[Math.max(0, idx - 1)];
      setActiveFile(fallback.name);
    }
  };

  const renameFile = (oldName) => {
    const input = window.prompt('Rename file', oldName);
    if (!input) return;
    const newName = input.trim();
    if (!newName || newName === oldName) return;
    if (files.some((f) => f.name === newName)) {
      window.alert(`A file named "${newName}" already exists.`);
      return;
    }
    const key = `${lang}:${oldName}`;
    const oldModel = modelsRef.current.get(key);
    const content = oldModel
      ? oldModel.getValue()
      : files.find((f) => f.name === oldName)?.content ?? '';
    if (oldModel) {
      oldModel.dispose();
      modelsRef.current.delete(key);
    }
    setFiles((prev) =>
      prev.map((f) => (f.name === oldName ? { ...f, name: newName, content } : f))
    );
    if (activeFile === oldName) setActiveFile(newName);
  };

  // ---------- Status ----------
  const ready = lang === 'python' ? pyReady : jsReady;
  const statusLabel = !ready
    ? lang === 'python' ? 'Loading Pyodide' : 'Initializing'
    : busy ? 'Running' : 'Ready';
  const statusColor = !ready ? 'var(--warning)' : busy ? 'var(--accent)' : 'var(--success)';

  return (
    <div className={s.shell}>
      <header className={s.header}>
        <div className={s.title}>
          <span className={s.logo}>{LANG_META[lang].short}</span>
          <h1>Monaco Playground</h1>
          <span className={s.subtitle}>
            {lang === 'python' ? 'Pyodide · Web Worker' : 'Sandboxed iframe'}
          </span>
        </div>
        <div className={s.langToggle} role="tablist" aria-label="Language">
          <button
            role="tab"
            aria-selected={lang === 'python'}
            className={`${s.langOption} ${lang === 'python' ? s.langOptionActive : ''}`}
            onClick={() => !busy && setLang('python')}
            disabled={busy}
          >
            Python
          </button>
          <button
            role="tab"
            aria-selected={lang === 'javascript'}
            className={`${s.langOption} ${lang === 'javascript' ? s.langOptionActive : ''}`}
            onClick={() => !busy && setLang('javascript')}
            disabled={busy}
          >
            JavaScript
          </button>
        </div>
      </header>

      <div className={s.body}>
        <section className={`${s.pane} ${s.paneEditor}`}>
          <div className={s.tabs}>
            <div className={s.tablist} role="tablist">
              {files.map((f) => (
                <div
                  key={f.name}
                  role="tab"
                  aria-selected={f.name === activeFile}
                  className={`${s.tab} ${f.name === activeFile ? s.tabActive : ''}`}
                  onClick={() => setActiveFile(f.name)}
                  onDoubleClick={() => renameFile(f.name)}
                  title="Click to switch · Double-click to rename"
                >
                  <span>{f.name}</span>
                  {files.length > 1 && (
                    <span
                      className={s.tabClose}
                      onClick={(e) => {
                        e.stopPropagation();
                        closeFile(f.name);
                      }}
                      title="Close file"
                    >
                      ×
                    </span>
                  )}
                </div>
              ))}
              <button className={s.tabAdd} onClick={addFile} title="New file">
                +
              </button>
            </div>
            <span className={s.hint}>
              <kbd>⌘</kbd> <kbd>↵</kbd> run
            </span>
          </div>
          <div className={s.editor}>
            <MonacoEditor
              height="100%"
              defaultLanguage={LANG_META[lang].monacoLang}
              theme="vs-dark"
              onMount={handleEditorMount}
              options={{
                minimap: { enabled: false },
                fontSize: 16,
                fontFamily: '"Roboto Mono", Menlo, monospace',
                lineHeight: 1.6,
                scrollBeyondLastLine: false,
                smoothScrolling: true,
                cursorBlinking: 'smooth',
                cursorSmoothCaretAnimation: 'on',
                padding: { top: 14, bottom: 14 },
                tabSize: LANG_META[lang].tabSize,
                renderLineHighlight: 'all',
                lineNumbersMinChars: 3,
                scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
              }}
            />
          </div>
        </section>

        <section className={`${s.pane} ${s.paneConsole}`}>
          <div className={s.paneHeader}>
            <span className={s.paneTitle}>Console</span>
            <div className={s.actions}>
              <button
                className="primary"
                disabled={busy || !ready}
                onClick={runCode}
                title="Run active file (⌘/Ctrl + Enter)"
              >
                {busy ? 'Running…' : !ready ? 'Loading…' : `▶ Run ${activeFile}`}
              </button>
              <button onClick={() => setOutput('')} disabled={busy}>
                Clear
              </button>
            </div>
          </div>
          <pre className={`${s.console} ${output ? '' : s.consoleEmpty}`}>
            {output ||
              `Welcome. Toggle languages above, write code, and press ⌘/Ctrl + Enter to run.`}
          </pre>
          <div className={s.statusbar}>
            <span className={s.statusDot} style={{ background: statusColor }} />
            <span>{statusLabel}</span>
            <span className={s.spacer} />
            <span>{LANG_META[lang].label}</span>
            <span className={s.dot}>·</span>
            <span>{files.length} file{files.length === 1 ? '' : 's'}</span>
            {lang === 'python' && (
              <>
                <span className={s.dot}>·</span>
                <span>TLE {TIME_LIMIT_MS / 1000}s</span>
              </>
            )}
          </div>
        </section>
      </div>

      {/* Always-mounted JS sandbox; reused across runs */}
      <iframe
        ref={iframeRef}
        title="js-sandbox"
        sandbox="allow-scripts"
        srcDoc={SANDBOX_HTML}
        onLoad={() => setJsReady(true)}
        style={{ display: 'none' }}
      />
    </div>
  );
}
