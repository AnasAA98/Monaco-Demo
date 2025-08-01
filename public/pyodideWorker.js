// public/pyodideWorker.js

// 1) load the Pyodide loader into this worker
importScripts('https://cdn.jsdelivr.net/pyodide/v0.28.0/full/pyodide.js');

let pyodideReady = false;
let pyodide = null;

async function initPyodide() {
  pyodide = await loadPyodide({
    stdout: (msg) => postMessage({ type: 'stdout', msg }),
    stderr: (msg) => postMessage({ type: 'stderr', msg }),
  });
  pyodideReady = true;
}

// immediately start loading
initPyodide();

onmessage = async (e) => {
  const code = e.data.code;
  if (!pyodideReady) {
    await initPyodide();
  }
  try {
    // eagerly load imports so large libs download before exec
    await pyodide.loadPackagesFromImports(code);
    const result = await pyodide.runPythonAsync(code);
    postMessage({ type: 'done', result });
  } catch (err) {
    postMessage({ type: 'error', error: err.toString() });
  }
};
