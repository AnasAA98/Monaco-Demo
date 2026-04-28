'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { MonacoBinding } from 'y-monaco';
import s from './ide.module.css';
import { useCollab } from './useCollab';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

const TIME_LIMIT_MS = 10000;

const STORAGE_KEYS = {
  lang: 'monaco-active-lang-v1',
  name: 'monaco-collab-name-v1',
  color: 'monaco-collab-color-v1',
  collabEnabled: 'monaco-collab-enabled-v1',
};

const LANG_META = {
  python: { label: 'Python', short: 'Py', monacoLang: 'python', tabSize: 4, ext: '.py' },
  javascript: { label: 'JavaScript', short: 'JS', monacoLang: 'javascript', tabSize: 2, ext: '.js' },
};

const PEER_COLORS = [
  '#6366f1', '#10b981', '#f59e0b', '#f43f5e', '#3b82f6',
  '#a855f7', '#ec4899', '#14b8a6', '#eab308', '#84cc16',
];

const ANIMAL_NAMES = [
  'Otter', 'Falcon', 'Panda', 'Koala', 'Heron',
  'Lynx', 'Badger', 'Sparrow', 'Newt', 'Wombat',
];

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
  function ping() { parent.postMessage({ __js_ide: true, level: 'ready' }, '*'); }
  ping();
  window.addEventListener('load', ping);
})();
</script>
</body></html>`;

function readLangPref() {
  if (typeof window === 'undefined') return 'python';
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.lang);
    if (raw === 'python' || raw === 'javascript') return raw;
  } catch {}
  return 'python';
}

function readIdentity() {
  if (typeof window === 'undefined') {
    return { name: 'Guest', color: PEER_COLORS[0] };
  }
  let name = '';
  let color = '';
  try {
    name = window.localStorage.getItem(STORAGE_KEYS.name) || '';
    color = window.localStorage.getItem(STORAGE_KEYS.color) || '';
  } catch {}
  if (!name) {
    name = ANIMAL_NAMES[Math.floor(Math.random() * ANIMAL_NAMES.length)];
  }
  if (!color) {
    color = PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)];
  }
  return { name, color };
}

function getOrCreateRoomId({ updateUrl }) {
  if (typeof window === 'undefined') return 'default';
  const params = new URLSearchParams(window.location.search);
  let room = params.get('room');
  if (!room) {
    room = Math.random().toString(36).slice(2, 8);
    if (updateUrl) {
      params.set('room', room);
      const next = `${window.location.pathname}?${params.toString()}`;
      window.history.replaceState({}, '', next);
    }
  }
  return room;
}

function readCollabEnabled() {
  if (typeof window === 'undefined') return false;
  try {
    if (window.localStorage.getItem(STORAGE_KEYS.collabEnabled) === '1') return true;
  } catch {}
  // If the URL already has ?room=... treat the user as opting in to collab
  // (e.g. they followed someone else's share link).
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('room')) return true;
  } catch {}
  return false;
}

export default function Playground() {
  // Identity / room
  const [roomId, setRoomId] = useState('default');
  const [userName, setUserName] = useState('Guest');
  const [userColor, setUserColor] = useState(PEER_COLORS[0]);
  const [lang, setLang] = useState('python');
  const [hydrated, setHydrated] = useState(false);
  const [shareToast, setShareToast] = useState('');
  const [collabEnabled, setCollabEnabled] = useState(false);

  // UI state
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pyReady, setPyReady] = useState(false);
  const [jsReady, setJsReady] = useState(false);

  // Per-language active file id
  const [pyActive, setPyActive] = useState(null);
  const [jsActive, setJsActive] = useState(null);

  // Refs
  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const modelsRef = useRef(new Map());   // id -> ITextModel
  const bindingsRef = useRef(new Map()); // id -> MonacoBinding
  const workerRef = useRef(null);
  const timerRef = useRef(null);
  const busyRef = useRef(false);
  const iframeRef = useRef(null);
  const runIdRef = useRef(0);

  // Hydrate identity / room on mount (client only)
  useEffect(() => {
    const collabOn = readCollabEnabled();
    setCollabEnabled(collabOn);
    setRoomId(getOrCreateRoomId({ updateUrl: collabOn }));
    const id = readIdentity();
    setUserName(id.name);
    setUserColor(id.color);
    setLang(readLangPref());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEYS.collabEnabled, collabEnabled ? '1' : '0');
    } catch {}
    if (collabEnabled) {
      // Now that collab is on, make sure the URL reflects the room id so the
      // user can copy it.
      const params = new URLSearchParams(window.location.search);
      if (params.get('room') !== roomId) {
        params.set('room', roomId);
        const next = `${window.location.pathname}?${params.toString()}`;
        window.history.replaceState({}, '', next);
      }
    } else {
      // Drop ?room=... from the URL when collab is off.
      const params = new URLSearchParams(window.location.search);
      if (params.has('room')) {
        params.delete('room');
        const search = params.toString();
        const next = `${window.location.pathname}${search ? '?' + search : ''}`;
        window.history.replaceState({}, '', next);
      }
    }
  }, [collabEnabled, roomId, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try { window.localStorage.setItem(STORAGE_KEYS.lang, lang); } catch {}
  }, [lang, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try { window.localStorage.setItem(STORAGE_KEYS.name, userName); } catch {}
  }, [userName, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try { window.localStorage.setItem(STORAGE_KEYS.color, userColor); } catch {}
  }, [userColor, hydrated]);

  const collab = useCollab({ enabled: collabEnabled, roomId, userName, userColor });
  const { status, peers, version, getTabs, addTab, renameTab, closeTab, getText } = collab;

  // Snapshot tabs for the current language; recomputed when the underlying
  // store (Yjs in collab mode, local Y.Doc in solo mode) notifies us.
  const pyTabs = useMemo(() => getTabs('python'), [getTabs, version]);
  const jsTabs = useMemo(() => getTabs('javascript'), [getTabs, version]);
  const tabs = lang === 'python' ? pyTabs : jsTabs;
  const activeId = lang === 'python' ? pyActive : jsActive;
  const setActiveId = lang === 'python' ? setPyActive : setJsActive;

  // Keep the active id valid as the tab list shifts (other peers add/close).
  useEffect(() => {
    if (!tabs.length) {
      if (activeId !== null) setActiveId(null);
      return;
    }
    if (!tabs.find((t) => t.id === activeId)) {
      setActiveId(tabs[0].id);
    }
  }, [tabs, activeId, setActiveId]);

  const appendOutput = useCallback((text) => setOutput((o) => o + text), []);
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
        case 'ready': setPyReady(true); break;
        case 'stdout':
        case 'stderr': appendOutput(msg); break;
        case 'done':
          if (result) appendOutput(result + '\n');
          appendOutput(`\n✔ Finished in ${elapsed} ms\n`);
          cleanupRun();
          break;
        case 'error':
          appendOutput('✖ ' + error + '\n');
          cleanupRun();
          break;
        default: break;
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
      if (data.level === 'ready') { setJsReady(true); return; }
      if (data.level === 'done') {
        appendOutput('\n✔ Done\n');
        cleanupRun();
        return;
      }
      const prefix = data.level === 'error' ? '✖ ' : data.level === 'warn' ? '⚠ ' : '';
      appendOutput(prefix + data.msg + '\n');
    };
    window.addEventListener('message', onMsg);
    const fallback = setTimeout(() => setJsReady(true), 2000);
    return () => {
      window.removeEventListener('message', onMsg);
      clearTimeout(fallback);
    };
  }, [appendOutput, cleanupRun]);

  // ---------- Monaco models bound to Y.Text ----------
  const docKey = collab.doc; // identity changes when we switch modes
  const ensureModelAndBinding = useCallback(
    (id, monacoLang) => {
      const monaco = monacoRef.current;
      if (!monaco) return null;
      const ytext = getText(id);
      if (!ytext) return null;

      let model = modelsRef.current.get(id);
      if (!model) {
        const uri = monaco.Uri.parse(`inmemory://collab/${id}`);
        model = monaco.editor.createModel('', monacoLang, uri);
        modelsRef.current.set(id, model);
      }
      const existing = bindingsRef.current.get(id);
      if (existing && existing.__doc !== docKey) {
        existing.destroy();
        bindingsRef.current.delete(id);
      }
      if (!bindingsRef.current.has(id)) {
        const binding = new MonacoBinding(
          ytext,
          model,
          new Set(),
          collab.awareness ?? null
        );
        binding.__doc = docKey;
        bindingsRef.current.set(id, binding);
      } else {
        const binding = bindingsRef.current.get(id);
        if (editorRef.current) binding.editors.add(editorRef.current);
      }
      return model;
    },
    [getText, collab.awareness, docKey]
  );

  // Switch the editor to the active file's model + binding.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !monacoRef.current || !activeId) return;
    const monacoLang = LANG_META[lang].monacoLang;
    const model = ensureModelAndBinding(activeId, monacoLang);
    if (!model) return;
    if (editor.getModel() !== model) {
      // Detach the editor from any previously bound model so its remote-cursor
      // decorations stop targeting the old buffer.
      bindingsRef.current.forEach((b, id) => {
        if (id !== activeId) b.editors.delete(editor);
      });
      editor.setModel(model);
      bindingsRef.current.get(activeId)?.editors.add(editor);
      editor.focus();
    }
  }, [lang, activeId, ensureModelAndBinding]);

  // Dispose models + bindings for files that were removed by any peer.
  useEffect(() => {
    const liveIds = new Set([...pyTabs, ...jsTabs].map((t) => t.id));
    for (const [id, binding] of bindingsRef.current.entries()) {
      if (!liveIds.has(id)) {
        binding.destroy();
        bindingsRef.current.delete(id);
      }
    }
    for (const [id, model] of modelsRef.current.entries()) {
      if (!liveIds.has(id)) {
        model.dispose();
        modelsRef.current.delete(id);
      }
    }
  }, [pyTabs, jsTabs]);

  // When the underlying doc swaps (collab toggled on/off), tear down every
  // binding so the next render re-binds against the new doc's Y.Text.
  useEffect(() => {
    for (const binding of bindingsRef.current.values()) binding.destroy();
    bindingsRef.current.clear();
    for (const model of modelsRef.current.values()) model.dispose();
    modelsRef.current.clear();
    // Force the active-id effect to re-run by nudging both ids; the sanity
    // effect will reconcile to the first available tab.
    setPyActive(null);
    setJsActive(null);
  }, [docKey]);

  // ---------- Run dispatch ----------
  const runCode = useCallback(() => {
    if (busyRef.current) return;
    if (!activeId) return;
    const tab = tabs.find((t) => t.id === activeId);
    if (!tab) return;
    const code = getText(activeId).toString();
    if (!code.trim()) return;

    if (lang === 'python') {
      if (!pyReady) return;
      busyRef.current = true;
      setBusy(true);
      setOutput(`▶ Running ${tab.name}…\n\n`);
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
      setOutput(`▶ Running ${tab.name}…\n\n`);
      const runId = ++runIdRef.current;
      iframeRef.current?.contentWindow?.postMessage(
        { __js_ide_run: true, code, runId },
        '*'
      );
    }
  }, [activeId, tabs, lang, pyReady, jsReady, getText, appendOutput, cleanupRun, spawnWorker]);

  const runCodeRef = useRef(runCode);
  useEffect(() => { runCodeRef.current = runCode; }, [runCode]);

  const handleEditorMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    if (activeId) {
      const model = ensureModelAndBinding(activeId, LANG_META[lang].monacoLang);
      if (model) editor.setModel(model);
    }
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runCodeRef.current());
  };

  // ---------- Tab actions (write through Yjs) ----------
  const onAddFile = () => {
    const ext = LANG_META[lang].ext;
    const taken = new Set(tabs.map((t) => t.name));
    let n = 1;
    let name = `untitled${ext}`;
    while (taken.has(name)) {
      n += 1;
      name = `untitled${n}${ext}`;
    }
    const id = addTab(lang, name);
    setActiveId(id);
  };

  const onCloseFile = (id) => {
    if (tabs.length === 1) return;
    closeTab(lang, id);
    if (activeId === id) {
      const idx = tabs.findIndex((t) => t.id === id);
      const next = tabs.filter((t) => t.id !== id);
      const fallback = next[Math.max(0, idx - 1)];
      if (fallback) setActiveId(fallback.id);
    }
  };

  const onRenameFile = (id, oldName) => {
    const input = window.prompt('Rename file', oldName);
    if (!input) return;
    const newName = input.trim();
    if (!newName || newName === oldName) return;
    if (tabs.some((t) => t.name === newName)) {
      window.alert(`A file named "${newName}" already exists.`);
      return;
    }
    renameTab(lang, id, newName);
  };

  // ---------- Share ----------
  const onShare = async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      setShareToast('Link copied');
    } catch {
      setShareToast(url);
    }
    setTimeout(() => setShareToast(''), 1800);
  };

  const onNameChange = (e) => {
    const next = e.target.value.slice(0, 24);
    setUserName(next);
  };

  // ---------- Status ----------
  const ready = lang === 'python' ? pyReady : jsReady;
  const runtimeLabel = !ready
    ? lang === 'python' ? 'Loading Pyodide' : 'Initializing'
    : busy ? 'Running' : 'Ready';
  const runtimeColor = !ready ? 'var(--warning)' : busy ? 'var(--accent)' : 'var(--success)';

  const collabColor = !collabEnabled
    ? 'var(--text-faint)'
    : status === 'connected' ? 'var(--success)'
    : status === 'connecting' ? 'var(--warning)'
    : 'var(--danger)';
  const collabLabel = !collabEnabled
    ? 'Solo'
    : status === 'connected' ? `Live · ${peers.length} ${peers.length === 1 ? 'user' : 'users'}`
    : status === 'connecting' ? 'Connecting…'
    : 'Offline';

  const activeTab = tabs.find((t) => t.id === activeId);
  const activeName = activeTab?.name ?? '';

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

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
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

          <button
            onClick={() => setCollabEnabled((v) => !v)}
            title={collabEnabled ? 'Stop collaborating' : 'Start collaborating'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.45rem',
              padding: '0.4rem 0.75rem',
              background: collabEnabled ? 'var(--bg-active)' : 'var(--bg)',
              border: `1px solid ${collabEnabled ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 'var(--r-md)',
              color: 'var(--text)',
              fontSize: '0.85rem',
              fontWeight: 500,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 26, height: 14, borderRadius: 8, padding: 2,
                background: collabEnabled ? 'var(--accent)' : 'var(--border-strong)',
                display: 'inline-flex',
                justifyContent: collabEnabled ? 'flex-end' : 'flex-start',
                transition: 'background 140ms ease, justify-content 140ms ease',
              }}
            >
              <span style={{
                width: 10, height: 10, borderRadius: '50%',
                background: '#fff',
              }} />
            </span>
            <span>Collaborate</span>
          </button>

          {collabEnabled && (
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.25rem 0.6rem',
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-md)',
                fontSize: '0.85rem',
              }}
              title="Other people in this room"
            >
              <span style={{
                width: 7, height: 7, borderRadius: '50%',
                background: collabColor, display: 'inline-block',
              }} />
              <span style={{ color: 'var(--text-muted)' }}>{collabLabel}</span>
              <div style={{ display: 'inline-flex', gap: 2, marginLeft: 4 }}>
                {peers.slice(0, 6).map((p) => (
                  <span
                    key={p.clientId}
                    title={p.name + (p.isLocal ? ' (you)' : '')}
                    style={{
                      width: 18, height: 18, borderRadius: '50%',
                      background: p.color,
                      color: '#fff',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 10, fontWeight: 700,
                      border: p.isLocal ? '2px solid var(--text)' : '2px solid var(--bg)',
                    }}
                  >
                    {(p.name || '?').slice(0, 1).toUpperCase()}
                  </span>
                ))}
              </div>
            </div>
          )}

          {collabEnabled && (
            <input
              value={userName}
              onChange={onNameChange}
              placeholder="Your name"
              style={{
                width: 110,
                padding: '0.35rem 0.6rem',
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-sm)',
                color: 'var(--text)',
                fontSize: '0.85rem',
              }}
            />
          )}

          {collabEnabled && (
            <button onClick={onShare} title="Copy room link">
              {shareToast || 'Share'}
            </button>
          )}
        </div>
      </header>

      <div className={s.body}>
        <section className={`${s.pane} ${s.paneEditor}`}>
          <div className={s.tabs}>
            <div className={s.tablist} role="tablist">
              {tabs.map((t) => (
                <div
                  key={t.id}
                  role="tab"
                  aria-selected={t.id === activeId}
                  className={`${s.tab} ${t.id === activeId ? s.tabActive : ''}`}
                  onClick={() => setActiveId(t.id)}
                  onDoubleClick={() => onRenameFile(t.id, t.name)}
                  title="Click to switch · Double-click to rename"
                >
                  <span>{t.name}</span>
                  {tabs.length > 1 && (
                    <span
                      className={s.tabClose}
                      onClick={(e) => { e.stopPropagation(); onCloseFile(t.id); }}
                      title="Close file"
                    >
                      ×
                    </span>
                  )}
                </div>
              ))}
              <button className={s.tabAdd} onClick={onAddFile} title="New file">+</button>
            </div>
            <span className={s.hint}><kbd>⌘</kbd> <kbd>↵</kbd> run</span>
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
                disabled={busy || !ready || !activeId}
                onClick={runCode}
                title="Run active file (⌘/Ctrl + Enter)"
              >
                {busy ? 'Running…' : !ready ? 'Loading…' : `▶ Run ${activeName || ''}`}
              </button>
              <button onClick={() => setOutput('')} disabled={busy}>Clear</button>
            </div>
          </div>
          <pre className={`${s.console} ${output ? '' : s.consoleEmpty}`}>
            {output ||
              (collabEnabled
                ? `Welcome. Toggle languages above, write code, and press ⌘/Ctrl + Enter to run.\nCollaboration is on — share the URL and every keystroke syncs through the Yjs server.`
                : `Welcome. Toggle languages above, write code, and press ⌘/Ctrl + Enter to run.\nClick "Collaborate" in the header to enable real-time sharing.`)}
          </pre>
          <div className={s.statusbar}>
            <span className={s.statusDot} style={{ background: runtimeColor }} />
            <span>{runtimeLabel}</span>
            <span className={s.dot}>·</span>
            <span style={{ color: collabColor }}>●</span>
            <span>{collabLabel}</span>
            <span className={s.spacer} />
            <span>{LANG_META[lang].label}</span>
            <span className={s.dot}>·</span>
            <span>{tabs.length} file{tabs.length === 1 ? '' : 's'}</span>
            {collabEnabled && (
              <>
                <span className={s.dot}>·</span>
                <span>room {roomId}</span>
              </>
            )}
            {lang === 'python' && (
              <>
                <span className={s.dot}>·</span>
                <span>TLE {TIME_LIMIT_MS / 1000}s</span>
              </>
            )}
          </div>
        </section>
      </div>

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
