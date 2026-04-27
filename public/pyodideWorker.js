// Pyodide worker: persistent across runs, terminated by main thread on TLE.

importScripts('https://cdn.jsdelivr.net/pyodide/v0.28.0/full/pyodide.js');

let pyodide = null;
let initPromise = null;

function ensurePyodide() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    pyodide = await loadPyodide({
      stdout: (msg) => postMessage({ type: 'stdout', msg: msg + '\n' }),
      stderr: (msg) => postMessage({ type: 'stderr', msg: msg + '\n' }),
    });
    postMessage({ type: 'ready' });
  })();
  return initPromise;
}

// Begin loading immediately so first run is fast.
ensurePyodide().catch((err) =>
  postMessage({ type: 'error', error: 'Pyodide init failed: ' + err.toString() })
);

onmessage = async (e) => {
  const { type, code } = e.data || {};

  if (type === 'init') {
    await ensurePyodide();
    return;
  }

  if (type === 'run') {
    const start = performance.now();
    try {
      await ensurePyodide();
      await pyodide.loadPackagesFromImports(code);
      const result = await pyodide.runPythonAsync(code);
      const elapsed = Math.round(performance.now() - start);
      const resultStr = result === undefined || result === null ? '' : String(result);
      postMessage({ type: 'done', result: resultStr, elapsed });
    } catch (err) {
      postMessage({ type: 'error', error: err.toString() });
    }
  }
};
