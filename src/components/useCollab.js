'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

const STARTERS = {
  python: {
    name: 'main.py',
    content: `# Welcome to the Python IDE
# Press Cmd/Ctrl + Enter to run.

def greet(name):
    return f"Hello, {name}!"

print(greet("Monaco"))
`,
  },
  javascript: {
    name: 'main.js',
    content: `// Welcome to the JavaScript IDE
// Press Cmd/Ctrl + Enter to run.

function fib(n) {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

console.log("fib(10) =", fib(10));
`,
  },
};

const LOCAL_KEYS = {
  python: 'monaco-py-files-v2',
  javascript: 'monaco-js-files-v2',
};

function makeId() {
  return (
    Date.now().toString(36) +
    '-' +
    Math.random().toString(36).slice(2, 8)
  );
}

function getServerUrl() {
  if (typeof window === 'undefined') return 'ws://localhost:1234';
  const env = process.env.NEXT_PUBLIC_COLLAB_WS;
  if (env) return env;
  const { protocol, hostname } = window.location;
  const wsProto = protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProto}//${hostname}:1234`;
}

function seedIfEmpty(doc) {
  for (const lang of ['python', 'javascript']) {
    const tabs = doc.getArray(`tabs:${lang}`);
    if (tabs.length === 0) {
      const id = makeId();
      const meta = new Y.Map();
      meta.set('id', id);
      meta.set('name', STARTERS[lang].name);
      tabs.push([meta]);
      const text = doc.getText(`file:${id}`);
      if (text.length === 0) text.insert(0, STARTERS[lang].content);
    }
  }
}

// ----- Solo (localStorage) backend ------------------------------------------

function readSolo(lang) {
  if (typeof window === 'undefined') {
    const id = makeId();
    return [{ id, name: STARTERS[lang].name, content: STARTERS[lang].content }];
  }
  try {
    const raw = window.localStorage.getItem(LOCAL_KEYS[lang]);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((f) => ({
          id: f.id || makeId(),
          name: f.name,
          content: f.content ?? '',
        }));
      }
    }
  } catch {}
  const id = makeId();
  return [{ id, name: STARTERS[lang].name, content: STARTERS[lang].content }];
}

function writeSolo(lang, files) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LOCAL_KEYS[lang], JSON.stringify(files));
  } catch {}
}

// y-monaco's MonacoBinding only knows how to talk to a Y.Text. In solo mode we
// build a standalone Y.Doc on the client (no provider) and hand its Y.Text to
// the binding. This keeps the editor wiring identical between modes.
function useSoloStore() {
  const docRef = useRef(null);
  if (!docRef.current) docRef.current = new Y.Doc();
  const [version, setVersion] = useState(0);

  // Hydrate from localStorage on first mount (client only).
  useEffect(() => {
    const doc = docRef.current;
    let dirty = false;
    for (const lang of ['python', 'javascript']) {
      const arr = doc.getArray(`tabs:${lang}`);
      if (arr.length > 0) continue;
      const stored = readSolo(lang);
      doc.transact(() => {
        for (const f of stored) {
          const meta = new Y.Map();
          meta.set('id', f.id);
          meta.set('name', f.name);
          arr.push([meta]);
          const text = doc.getText(`file:${f.id}`);
          if (text.length === 0 && f.content) text.insert(0, f.content);
        }
      });
      dirty = true;
    }
    if (dirty) setVersion((v) => v + 1);
  }, []);

  // Persist to localStorage on any change.
  useEffect(() => {
    const doc = docRef.current;
    const persist = (lang) => {
      const arr = doc.getArray(`tabs:${lang}`);
      const out = arr.toArray().map((m) => ({
        id: m.get('id'),
        name: m.get('name'),
        content: doc.getText(`file:${m.get('id')}`).toString(),
      }));
      writeSolo(lang, out);
    };
    const bump = (lang) => () => {
      setVersion((v) => v + 1);
      persist(lang);
    };
    const onPy = bump('python');
    const onJs = bump('javascript');
    const tabsPy = doc.getArray('tabs:python');
    const tabsJs = doc.getArray('tabs:javascript');
    tabsPy.observeDeep(onPy);
    tabsJs.observeDeep(onJs);
    // Also persist on any text change.
    const textHandler = () => {
      persist('python');
      persist('javascript');
    };
    doc.on('update', textHandler);
    return () => {
      tabsPy.unobserveDeep(onPy);
      tabsJs.unobserveDeep(onJs);
      doc.off('update', textHandler);
    };
  }, []);

  return { doc: docRef.current, version };
}

// ----- Yjs-over-WebSocket backend -------------------------------------------

function useYjsStore({ enabled, roomId, userName, userColor }) {
  const docRef = useRef(null);
  const providerRef = useRef(null);
  const [status, setStatus] = useState('disconnected');
  const [version, setVersion] = useState(0);
  const [peers, setPeers] = useState([]);

  // Always make sure we have a Y.Doc when enabled, and tear it down when not.
  useEffect(() => {
    if (!enabled) {
      providerRef.current?.destroy();
      providerRef.current = null;
      docRef.current?.destroy();
      docRef.current = null;
      setStatus('disconnected');
      setPeers([]);
      return;
    }

    const doc = new Y.Doc();
    docRef.current = doc;

    const url = getServerUrl();
    let provider;
    try {
      provider = new WebsocketProvider(url, `monaco-playground:${roomId}`, doc, {
        connect: true,
      });
    } catch (err) {
      console.warn('[collab] failed to connect:', err);
      setStatus('error');
      return () => {
        doc.destroy();
        docRef.current = null;
      };
    }
    providerRef.current = provider;
    setStatus('connecting');

    const onStatus = ({ status }) => setStatus(status);
    provider.on('status', onStatus);

    const onConnError = () => setStatus('error');
    provider.on('connection-error', onConnError);
    provider.on('connection-close', onConnError);

    const onSync = (synced) => {
      if (synced) seedIfEmpty(doc);
    };
    provider.on('sync', onSync);

    const bump = () => setVersion((v) => v + 1);
    const tabsPy = doc.getArray('tabs:python');
    const tabsJs = doc.getArray('tabs:javascript');
    tabsPy.observeDeep(bump);
    tabsJs.observeDeep(bump);

    const awareness = provider.awareness;
    awareness.setLocalStateField('user', { name: userName, color: userColor });

    const onAwareness = () => {
      const states = Array.from(awareness.getStates().entries()).map(
        ([clientId, state]) => ({
          clientId,
          name: state?.user?.name || 'anon',
          color: state?.user?.color || '#888',
          isLocal: clientId === awareness.clientID,
        })
      );
      setPeers(states);
    };
    awareness.on('change', onAwareness);
    onAwareness();

    return () => {
      tabsPy.unobserveDeep(bump);
      tabsJs.unobserveDeep(bump);
      awareness.off('change', onAwareness);
      provider.off('status', onStatus);
      provider.off('connection-error', onConnError);
      provider.off('connection-close', onConnError);
      provider.off('sync', onSync);
      provider.destroy();
      providerRef.current = null;
      doc.destroy();
      docRef.current = null;
    };
  }, [enabled, roomId, userName, userColor]);

  return {
    doc: docRef.current,
    provider: providerRef.current,
    status,
    peers,
    version,
  };
}

// ----- Public hook ----------------------------------------------------------

export function useCollab({ enabled, roomId, userName, userColor }) {
  const solo = useSoloStore();
  const yjs = useYjsStore({ enabled, roomId, userName, userColor });

  // The active Y.Doc depends on mode.
  const doc = enabled ? yjs.doc : solo.doc;
  const version = enabled ? yjs.version : solo.version;

  const api = useMemo(() => {
    return {
      getTabs: (lang) => {
        if (!doc) return [];
        const arr = doc.getArray(`tabs:${lang}`);
        return arr.toArray().map((m) => ({ id: m.get('id'), name: m.get('name') }));
      },
      addTab: (lang, name) => {
        if (!doc) return null;
        const id = makeId();
        doc.transact(() => {
          const meta = new Y.Map();
          meta.set('id', id);
          meta.set('name', name);
          doc.getArray(`tabs:${lang}`).push([meta]);
          doc.getText(`file:${id}`);
        });
        return id;
      },
      renameTab: (lang, id, newName) => {
        if (!doc) return;
        const arr = doc.getArray(`tabs:${lang}`);
        doc.transact(() => {
          for (let i = 0; i < arr.length; i++) {
            const m = arr.get(i);
            if (m.get('id') === id) {
              m.set('name', newName);
              break;
            }
          }
        });
      },
      closeTab: (lang, id) => {
        if (!doc) return;
        const arr = doc.getArray(`tabs:${lang}`);
        doc.transact(() => {
          for (let i = 0; i < arr.length; i++) {
            if (arr.get(i).get('id') === id) {
              arr.delete(i, 1);
              break;
            }
          }
          const text = doc.getText(`file:${id}`);
          if (text.length > 0) text.delete(0, text.length);
        });
      },
      getText: (id) => (doc ? doc.getText(`file:${id}`) : null),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, version]);

  // Update awareness identity when name/color change in collab mode.
  useEffect(() => {
    if (!enabled) return;
    const provider = yjs.provider;
    if (!provider) return;
    provider.awareness.setLocalStateField('user', { name: userName, color: userColor });
  }, [enabled, yjs.provider, userName, userColor]);

  return {
    enabled,
    doc,
    provider: enabled ? yjs.provider : null,
    awareness: enabled ? yjs.provider?.awareness ?? null : null,
    status: enabled ? yjs.status : 'solo',
    peers: enabled ? yjs.peers : [],
    version,
    ...api,
  };
}
