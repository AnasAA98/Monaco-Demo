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

function seedIfEmpty(doc, ownClientId) {
  let claimedHost = false;
  doc.transact(() => {
    const meta = doc.getMap('meta');
    if (meta.get('creatorClientId') == null && ownClientId != null) {
      meta.set('creatorClientId', ownClientId);
      meta.set('createdAt', Date.now());
      claimedHost = true;
    }
    for (const lang of ['python', 'javascript']) {
      const tabs = doc.getArray(`tabs:${lang}`);
      if (tabs.length === 0) {
        const id = makeId();
        const tabMeta = new Y.Map();
        tabMeta.set('id', id);
        tabMeta.set('name', STARTERS[lang].name);
        tabs.push([tabMeta]);
        const text = doc.getText(`file:${id}`);
        if (text.length === 0) text.insert(0, STARTERS[lang].content);
      }
    }
  });
  return claimedHost;
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

  const hydrate = () => {
    const doc = docRef.current;
    if (!doc) return;
    doc.transact(() => {
      for (const lang of ['python', 'javascript']) {
        const arr = doc.getArray(`tabs:${lang}`);
        // Drop existing entries (if any) so we can replace them with whatever
        // localStorage now contains. Used both on first mount and after the
        // host's snapshot at end-of-session.
        const ids = arr.toArray().map((m) => m.get('id'));
        if (arr.length) arr.delete(0, arr.length);
        for (const id of ids) {
          const t = doc.getText(`file:${id}`);
          if (t.length) t.delete(0, t.length);
        }
        const stored = readSolo(lang);
        for (const f of stored) {
          const meta = new Y.Map();
          meta.set('id', f.id);
          meta.set('name', f.name);
          arr.push([meta]);
          const text = doc.getText(`file:${f.id}`);
          if (f.content) text.insert(0, f.content);
        }
      }
    });
    setVersion((v) => v + 1);
  };

  // Hydrate from localStorage on first mount (client only).
  useEffect(() => {
    hydrate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  return { doc: docRef.current, version, rehydrate: hydrate };
}

// ----- Yjs-over-WebSocket backend -------------------------------------------

function useYjsStore({ enabled, roomId, userName, userColor }) {
  const docRef = useRef(null);
  const providerRef = useRef(null);
  const [status, setStatus] = useState('disconnected');
  const [version, setVersion] = useState(0);
  const [peers, setPeers] = useState([]);
  const [meta, setMeta] = useState({ creatorClientId: null, terminated: false });

  // Capture identity in a ref so name/color edits don't re-trigger the
  // provider effect (which would tear down the WebSocket on every keystroke
  // in the name input).
  const identityRef = useRef({ userName, userColor });
  identityRef.current = { userName, userColor };

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
      if (synced) {
        seedIfEmpty(doc, provider.awareness.clientID);
        // Refresh meta snapshot after the seed transaction in case we became
        // host.
        const m = doc.getMap('meta');
        setMeta({
          creatorClientId: m.get('creatorClientId') ?? null,
          terminated: m.get('terminated') === true,
        });
      }
    };
    provider.on('sync', onSync);

    const bump = () => setVersion((v) => v + 1);
    const tabsPy = doc.getArray('tabs:python');
    const tabsJs = doc.getArray('tabs:javascript');
    tabsPy.observeDeep(bump);
    tabsJs.observeDeep(bump);

    const metaMap = doc.getMap('meta');
    const onMeta = () => {
      setMeta({
        creatorClientId: metaMap.get('creatorClientId') ?? null,
        terminated: metaMap.get('terminated') === true,
      });
    };
    metaMap.observe(onMeta);

    const awareness = provider.awareness;
    awareness.setLocalStateField('user', {
      name: identityRef.current.userName,
      color: identityRef.current.userColor,
    });

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
      metaMap.unobserve(onMeta);
      awareness.off('change', onAwareness);
      provider.off('status', onStatus);
      provider.off('connection-error', onConnError);
      provider.off('connection-close', onConnError);
      provider.off('sync', onSync);
      provider.destroy();
      providerRef.current = null;
      doc.destroy();
      docRef.current = null;
      setMeta({ creatorClientId: null, terminated: false });
    };
    // identity (userName/userColor) is intentionally NOT a dep — see the
    // separate effect below that pushes identity changes through awareness
    // without rebuilding the provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, roomId]);

  return {
    doc: docRef.current,
    provider: providerRef.current,
    status,
    peers,
    version,
    meta,
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

  const provider = enabled ? yjs.provider : null;
  const awareness = provider?.awareness ?? null;
  const localClientId = awareness?.clientID ?? null;
  const meta = enabled ? yjs.meta : { creatorClientId: null, terminated: false };
  const isHost =
    enabled && meta.creatorClientId != null && meta.creatorClientId === localClientId;

  const endSession = () => {
    if (!enabled || !doc) return;
    if (!isHost) return;
    // Before flipping the terminated flag, snapshot every shared file's
    // current content into the host's solo localStorage and rehydrate the
    // solo Y.Doc so when collab drops the host keeps editing the same files.
    // Non-host peers never run this code, so their solo storage stays
    // whatever it was before they joined the session.
    try {
      for (const lang of ['python', 'javascript']) {
        const arr = doc.getArray(`tabs:${lang}`);
        const out = arr.toArray().map((m) => ({
          id: m.get('id'),
          name: m.get('name'),
          content: doc.getText(`file:${m.get('id')}`).toString(),
        }));
        if (out.length) writeSolo(lang, out);
      }
      solo.rehydrate();
    } catch {}
    doc.transact(() => {
      const m = doc.getMap('meta');
      m.set('terminated', true);
      m.set('terminatedAt', Date.now());
    });
  };

  return {
    enabled,
    doc,
    provider,
    awareness,
    status: enabled ? yjs.status : 'solo',
    peers: enabled ? yjs.peers : [],
    version,
    meta,
    isHost,
    terminated: !!meta.terminated,
    endSession,
    ...api,
  };
}
