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

function hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return `rgba(99,102,241,${alpha})`;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Deterministic color from clientId so two peers can never collide on color.
function colorForClientId(clientId) {
  const palette = PEER_COLORS;
  let hash = 0;
  const s = String(clientId);
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

// Pick a label text color (white vs near-black) for legibility against the
// peer color. Uses relative luminance per WCAG.
function readableTextColor(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return '#fff';
  const toLin = (v) => {
    const c = parseInt(v, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const L = 0.2126 * toLin(m[1]) + 0.7152 * toLin(m[2]) + 0.0722 * toLin(m[3]);
  return L > 0.55 ? '#0a0c10' : '#fff';
}

// Inject (or refresh) a per-peer style block exposing CSS custom properties
// that scope to that peer's classes (.peer-sel/.peer-caret/.peer-flash with
// the peer's clientId as a suffix).
function applyPeerColorVars(clientId, color, fg) {
  const id = `peer-vars-${clientId}`;
  let tag = document.getElementById(id);
  if (!tag) {
    tag = document.createElement('style');
    tag.id = id;
    document.head.appendChild(tag);
  }
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color);
  const r = m ? parseInt(m[1], 16) : 99;
  const g = m ? parseInt(m[2], 16) : 102;
  const b = m ? parseInt(m[3], 16) : 241;
  // Slight tweaks per state. Selection uses 22% alpha; flash uses 30%.
  const tag_css =
    `.peer-sel-${clientId} { background-color: rgba(${r},${g},${b},0.22) !important; }\n` +
    `.peer-caret-${clientId} { background: ${color} !important; }\n` +
    `.peer-flash-${clientId} { background-color: rgba(${r},${g},${b},0.30) !important; transition: background-color 1.4s ease-out; }\n` +
    `.peer-flash-line-${clientId} { background-color: rgba(${r},${g},${b},0.08) !important; }`;
  tag.textContent = tag_css;
}

// Build a Monaco content widget that anchors above (or below) the peer's
// caret. Monaco handles viewport-edge positioning via the preference array.
function createLabelWidget(clientId) {
  const dom = document.createElement('div');
  dom.className = 'peer-label';
  dom.dataset.peer = String(clientId);
  // The widget object we store its position on; .__pos is read from the
  // closure in renderPresence.
  const widget = {
    __pos: { line: 1, col: 1, below: false },
    getId: () => `peer-label-${clientId}`,
    getDomNode: () => dom,
    getPosition: () => {
      // Use the local Monaco we passed in (referenced via window.monaco at
      // dispatch time isn't available; fall back to numeric constants for
      // ContentWidgetPositionPreference: ABOVE=1, BELOW=2, EXACT=0).
      return {
        position: { lineNumber: widget.__pos.line, column: widget.__pos.col },
        preference: widget.__pos.below ? [2, 1] : [1, 2],
      };
    },
  };
  return widget;
}

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
  const [editorReady, setEditorReady] = useState(false);

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

  // Remote-presence refs — declared up here because the doc-swap effect needs
  // to tear them down BEFORE disposing models, and the presence renderer
  // effect (further down) populates them.
  const peerWidgetsRef = useRef(new Map());
  const peerDecosRef = useRef(new Map());
  const peerLastSeenRef = useRef(new Map());
  const peerLeavingRef = useRef(new Map());
  const idleTickRef = useRef(null);
  const flashHandlesRef = useRef(new Map());

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
  const {
    status, peers, version, getTabs, addTab, renameTab, closeTab, getText,
    isHost, terminated, endSession,
  } = collab;

  // When the host ends the session, every peer drops collab. The host keeps
  // the work (snapshot already written to localStorage by endSession()) and
  // lands on / in solo mode. Non-host peers also land on / in solo mode but
  // see only their own pre-collab files (their solo storage was untouched).
  const wasHostRef = useRef(false);
  useEffect(() => { wasHostRef.current = isHost; }, [isHost]);
  useEffect(() => {
    if (terminated && collabEnabled) {
      const wasHost = wasHostRef.current;
      setCollabEnabled(false);
      // Generate a fresh room id so re-enabling collab doesn't drop us right
      // back into the terminated room.
      setRoomId(Math.random().toString(36).slice(2, 8));
      setShareToast(wasHost ? 'Session ended' : 'Session was ended by host');
      setTimeout(() => setShareToast(''), 2400);
    }
  }, [terminated, collabEnabled]);

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
  const docKey = collab.doc;            // changes when we switch modes
  const awarenessKey = collab.awareness; // changes when collab connects/disconnects
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
      // Recreate the binding whenever the underlying doc OR the awareness ref
      // changes. The binding caches both at construction time, so a stale ref
      // means cursors and edits stop syncing for that file.
      const existing = bindingsRef.current.get(id);
      if (
        existing &&
        (existing.__doc !== docKey || existing.__awareness !== awarenessKey)
      ) {
        existing.destroy();
        bindingsRef.current.delete(id);
      }
      if (!bindingsRef.current.has(id)) {
        // Pass null for awareness — we render remote presence ourselves
        // (carets as decorations, name labels as content widgets) so we get
        // viewport-aware positioning, idle fades, and stack-avoidance.
        const binding = new MonacoBinding(ytext, model, new Set(), null);
        binding.__doc = docKey;
        binding.__awareness = awarenessKey;
        bindingsRef.current.set(id, binding);
      }
      return model;
    },
    [getText, awarenessKey, docKey]
  );

  // Switch the editor to the active file's model + binding.
  // Runs whenever the active id, language, or doc identity changes — and on
  // first editor mount once tabs have arrived.
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco || !activeId) return;
    const monacoLang = LANG_META[lang].monacoLang;
    const model = ensureModelAndBinding(activeId, monacoLang);
    if (!model) return;

    // Make sure the model's language matches the current pane (a model created
    // via the JS pane that is later viewed under Python — or after a Yjs
    // doc swap — would otherwise keep its old language).
    if (model.getLanguageId && model.getLanguageId() !== monacoLang) {
      monaco.editor.setModelLanguage(model, monacoLang);
    }

    bindingsRef.current.forEach((b, id) => {
      if (id !== activeId) b.editors.delete(editor);
    });
    if (editor.getModel() !== model) {
      editor.setModel(model);
      editor.focus();
    }
    bindingsRef.current.get(activeId)?.editors.add(editor);
  }, [lang, activeId, ensureModelAndBinding, editorReady]);

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
  // Order matters here — Monaco throws "Canceled" if a decoration update is
  // queued against a model we're about to dispose. So we must:
  //   1. clear all decoration collections + remove all widgets,
  //   2. detach the editor from any model,
  //   3. destroy the y-monaco bindings,
  //   4. dispose the models.
  useEffect(() => {
    const editor = editorRef.current;
    // 1. Decorations and widgets first.
    for (const c of peerDecosRef.current.values()) c.clear();
    peerDecosRef.current.clear();
    for (const widget of peerWidgetsRef.current.values()) {
      try { editor?.removeContentWidget?.(widget); } catch {}
    }
    peerWidgetsRef.current.clear();
    for (const { collection, timer } of flashHandlesRef.current.values()) {
      clearTimeout(timer);
      try { collection.clear(); } catch {}
    }
    flashHandlesRef.current.clear();
    for (const { timer } of peerLeavingRef.current.values()) clearTimeout(timer);
    peerLeavingRef.current.clear();

    // 2. Detach the editor from any model so its in-flight events don't
    //    target a freshly disposed buffer.
    try { editor?.setModel?.(null); } catch {}

    // 3. Destroy bindings (these unsubscribe from the Y.Text + the model).
    for (const binding of bindingsRef.current.values()) {
      try { binding.destroy(); } catch {}
    }
    bindingsRef.current.clear();

    // 4. Finally dispose the models.
    for (const model of modelsRef.current.values()) {
      try { model.dispose(); } catch {}
    }
    modelsRef.current.clear();

    setPyActive(null);
    setJsActive(null);
  }, [docKey]);

  // ---------- Remote presence: caret + selection + label widgets ----------
  // We render remote presence ourselves (we passed null to MonacoBinding's
  // awareness arg) so we can:
  //  • position labels with viewport-edge awareness (Monaco content widgets)
  //  • fade idle labels independently of carets
  //  • stack labels when peers share a line
  //  • per-peer color comes from a CSS variable so styling lives in one place

  // Publish our own cursor/selection into awareness on every editor change.
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const awareness = collab.awareness;
    if (!editor || !monaco || !awareness || !editorReady) return;

    const writeSelection = () => {
      const model = editor.getModel();
      if (!model || !activeId) return;
      const sel = editor.getSelection();
      if (!sel) return;
      awareness.setLocalStateField('presence', {
        fileId: activeId,
        anchorLine: sel.startLineNumber,
        anchorCol: sel.startColumn,
        headLine: sel.endLineNumber,
        headCol: sel.endColumn,
        // Reverse the head/anchor when the user selects backwards so we draw
        // the caret on the correct end of the selection.
        reversed: sel.getDirection() === monaco.SelectionDirection.RTL,
        ts: Date.now(),
      });
    };

    const d1 = editor.onDidChangeCursorSelection(writeSelection);
    const d2 = editor.onDidChangeCursorPosition(writeSelection);
    writeSelection();

    return () => {
      d1.dispose();
      d2.dispose();
      // Clear our presence from awareness so peers see us "leave" this file.
      awareness.setLocalStateField('presence', null);
    };
  }, [collab.awareness, activeId, editorReady]);

  // Render every other peer's presence as decorations + content widgets.
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const awareness = collab.awareness;
    if (!editor || !monaco || !awareness || !editorReady) return;

    const localClientId = awareness.clientID;

    // Rebuild presence on every awareness change. Cheap because we diff and
    // only touch widgets/decos for peers whose state actually changed.
    const renderPresence = () => {
      const states = awareness.getStates();
      const present = new Set();

      // Group by line so we know which labels need stacking offsets.
      const byLine = new Map();
      const peersOnFile = [];
      for (const [cid, state] of states.entries()) {
        if (cid === localClientId) continue;
        const p = state?.presence;
        if (!p || p.fileId !== activeId) continue;
        peersOnFile.push({ cid, p });
        const arr = byLine.get(p.headLine) || [];
        arr.push(cid);
        byLine.set(p.headLine, arr);
      }

      const model = editor.getModel();
      if (!model) return;
      const lineCount = model.getLineCount();

      for (const { cid, p } of peersOnFile) {
        present.add(cid);
        peerLastSeenRef.current.set(cid, p.ts || Date.now());
        // Cancel any pending leave-fade if the peer reappeared.
        const leaving = peerLeavingRef.current.get(cid);
        if (leaving) {
          clearTimeout(leaving.timer);
          peerLeavingRef.current.delete(cid);
        }

        const peerName =
          (states.get(cid)?.user?.name || 'peer').slice(0, 24);
        const color = colorForClientId(cid);
        const fg = readableTextColor(color);

        // Clamp the position to a real model location.
        const safeLine = Math.max(1, Math.min(lineCount, p.headLine || 1));
        const maxCol = model.getLineMaxColumn(safeLine);
        const safeCol = Math.max(1, Math.min(maxCol, p.headCol || 1));
        const aLine = Math.max(1, Math.min(lineCount, p.anchorLine || safeLine));
        const aMaxCol = model.getLineMaxColumn(aLine);
        const aCol = Math.max(1, Math.min(aMaxCol, p.anchorCol || safeCol));

        // Build decorations: selection range + caret zero-width range.
        const selRange = new monaco.Range(
          Math.min(aLine, safeLine),
          Math.min(aLine === safeLine ? aCol : aCol, aLine < safeLine ? aCol : safeCol),
          Math.max(aLine, safeLine),
          Math.max(aLine === safeLine ? safeCol : safeCol, aLine > safeLine ? aCol : safeCol),
        );
        const caretRange = new monaco.Range(safeLine, safeCol, safeLine, safeCol);

        const decos = [];
        if (!selRange.isEmpty()) {
          decos.push({
            range: selRange,
            options: { className: `peer-sel peer-sel-${cid}`, stickiness: 1 },
          });
        }
        decos.push({
          range: caretRange,
          options: {
            className: `peer-caret peer-caret-${cid}`,
            beforeContentClassName: `peer-caret peer-caret-${cid}`,
            stickiness: 1,
          },
        });

        let collection = peerDecosRef.current.get(cid);
        if (!collection) {
          collection = editor.createDecorationsCollection([]);
          peerDecosRef.current.set(cid, collection);
        }
        collection.set(decos);

        // Apply per-peer color via inline CSS variable on the editor's
        // overlay container. Decorations don't take inline style directly,
        // so we use a dedicated <style> tag keyed by clientId scoped to
        // .peer-* classes carrying that peer's id via attribute selector...
        // Simplest reliable path: set a per-peer style block.
        applyPeerColorVars(cid, color, fg);

        // Build / update the name label widget.
        let widget = peerWidgetsRef.current.get(cid);
        if (!widget) {
          widget = createLabelWidget(cid);
          editor.addContentWidget(widget);
          peerWidgetsRef.current.set(cid, widget);
        }
        const stackIndex = (byLine.get(safeLine) || []).indexOf(cid);
        const labelDom = widget.getDomNode();
        labelDom.textContent = peerName;
        labelDom.style.setProperty('--peer-color', color);
        labelDom.style.setProperty('--peer-fg', fg);
        labelDom.classList.toggle('peer-label-below', safeLine <= 1);
        labelDom.classList.toggle('peer-label-stack-1', stackIndex === 1);
        labelDom.classList.toggle('peer-label-stack-2', stackIndex >= 2);
        labelDom.classList.remove('peer-label-leaving');
        // Idle detection toggles peer-label-idle in the tick below.
        widget.__pos = {
          line: safeLine,
          col: safeCol,
          below: safeLine <= 1,
        };
        editor.layoutContentWidget(widget);
      }

      // Fade out peers who left the file or disconnected.
      for (const [cid, widget] of peerWidgetsRef.current.entries()) {
        if (present.has(cid)) continue;
        if (peerLeavingRef.current.has(cid)) continue;
        const dom = widget.getDomNode();
        dom.classList.add('peer-label-leaving');
        const timer = setTimeout(() => {
          editor.removeContentWidget(widget);
          peerWidgetsRef.current.delete(cid);
          const c = peerDecosRef.current.get(cid);
          if (c) {
            c.clear();
            peerDecosRef.current.delete(cid);
          }
          peerLeavingRef.current.delete(cid);
        }, 220);
        peerLeavingRef.current.set(cid, { timer });
      }
    };

    const onChange = () => renderPresence();
    awareness.on('change', onChange);
    renderPresence();

    // Idle tick: fade labels that haven't moved in 3s.
    const tick = () => {
      const now = Date.now();
      for (const [cid, widget] of peerWidgetsRef.current.entries()) {
        const last = peerLastSeenRef.current.get(cid) || 0;
        const idle = now - last > 3000;
        const dom = widget.getDomNode();
        dom.classList.toggle('peer-label-idle', idle);
      }
    };
    idleTickRef.current = setInterval(tick, 500);

    return () => {
      awareness.off('change', onChange);
      clearInterval(idleTickRef.current);
      idleTickRef.current = null;
      // Tear down all widgets + decorations on unmount.
      for (const widget of peerWidgetsRef.current.values()) {
        editor.removeContentWidget(widget);
      }
      peerWidgetsRef.current.clear();
      for (const c of peerDecosRef.current.values()) c.clear();
      peerDecosRef.current.clear();
      for (const { timer } of peerLeavingRef.current.values()) clearTimeout(timer);
      peerLeavingRef.current.clear();
    };
  }, [collab.awareness, activeId, editorReady]);

  // Replit-style edit flashes: brief colored highlight on remote insertions
  // into the file we're currently viewing.
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const ytext = activeId ? getText(activeId) : null;
    const awareness = collab.awareness;
    if (!editor || !monaco || !ytext || !awareness || !editorReady) return;

    const localClientId = awareness.clientID;

    const onTextChange = (event, transaction) => {
      if (transaction?.local) return;

      // Attribute the change to whichever non-local peer's awareness cursor
      // is on or near the affected line.
      const model = editor.getModel?.();
      if (!model) return;
      let cursor = 0;
      const ranges = [];
      for (const delta of event.changes.delta || []) {
        if (delta.retain != null) {
          cursor += delta.retain;
        } else if (typeof delta.insert === 'string') {
          const start = model.getPositionAt(cursor);
          const end = model.getPositionAt(cursor + delta.insert.length);
          ranges.push(new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column));
          cursor += delta.insert.length;
        } else if (delta.delete != null) {
          const pos = model.getPositionAt(cursor);
          ranges.push(new monaco.Range(pos.lineNumber, 1, pos.lineNumber, model.getLineMaxColumn(pos.lineNumber)));
        }
      }
      if (!ranges.length) return;

      const states = Array.from(awareness.getStates().entries())
        .filter(([cid]) => cid !== localClientId);
      let peerId = states[0]?.[0];
      const firstLine = ranges[0].startLineNumber;
      for (const [cid, state] of states) {
        const p = state?.presence;
        if (p && p.fileId === activeId && Math.abs(p.headLine - firstLine) <= 1) {
          peerId = cid;
          break;
        }
      }
      if (peerId == null) return;

      const color = colorForClientId(peerId);
      applyPeerColorVars(peerId, color, readableTextColor(color));

      const decos = ranges.flatMap((r) => ([
        { range: r, options: { inlineClassName: `peer-flash peer-flash-${peerId}` } },
        {
          range: new monaco.Range(r.startLineNumber, 1, r.endLineNumber, 1),
          options: { isWholeLine: true, className: `peer-flash-line peer-flash-line-${peerId}` },
        },
      ]));

      const collection = editor.createDecorationsCollection(decos);
      const prev = flashHandlesRef.current.get(peerId);
      if (prev?.timer) clearTimeout(prev.timer);
      if (prev?.collection) prev.collection.clear();
      const timer = setTimeout(() => collection.clear(), 1400);
      flashHandlesRef.current.set(peerId, { collection, timer });
    };

    ytext.observe(onTextChange);
    return () => {
      ytext.unobserve(onTextChange);
      for (const { collection, timer } of flashHandlesRef.current.values()) {
        clearTimeout(timer);
        collection.clear();
      }
      flashHandlesRef.current.clear();
    };
  }, [activeId, getText, collab.awareness, editorReady]);

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
      if (model) {
        editor.setModel(model);
        bindingsRef.current.get(activeId)?.editors.add(editor);
      }
    }
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runCodeRef.current());
    // Tell the rest of the component that Monaco has arrived. Effects keyed
    // on this re-run, which is what guarantees the active file's model gets
    // attached even when Monaco mounts after Yjs sync.
    setEditorReady(true);
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
    let copied = false;
    // Modern path: only works in secure contexts (https or localhost).
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(url);
        copied = true;
      } catch {}
    }
    // Fallback for http://<lan-ip> dev servers and older browsers.
    if (!copied) {
      try {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        copied = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {}
    }
    setShareToast(copied ? 'Link copied' : 'Copy failed — copy manually');
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
                {peers.slice(0, 6).map((p) => {
                  const peerColor = p.isLocal ? p.color : colorForClientId(p.clientId);
                  return (
                    <span
                      key={p.clientId}
                      title={p.name + (p.isLocal ? ' (you)' : '')}
                      style={{
                        width: 18, height: 18, borderRadius: '50%',
                        background: peerColor,
                        color: '#fff',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 10, fontWeight: 700,
                        border: p.isLocal ? '2px solid var(--text)' : '2px solid var(--bg)',
                      }}
                    >
                      {(p.name || '?').slice(0, 1).toUpperCase()}
                    </span>
                  );
                })}
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

          {collabEnabled && isHost && (
            <button
              onClick={() => {
                if (window.confirm('End the session for everyone?')) endSession();
              }}
              title="End session for all peers"
              style={{
                background: 'transparent',
                borderColor: 'var(--danger)',
                color: 'var(--danger)',
              }}
            >
              End session
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
