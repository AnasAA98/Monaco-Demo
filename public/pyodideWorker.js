// public/pyodideWorker.js

// 1) load the Pyodide loader into this worker
importScripts("https://cdn.jsdelivr.net/pyodide/v0.28.0/full/pyodide.js");

let pyodideReady = false;
let pyodide = null;
const MAX_OUTPUT_CHARS = 100000; // hard cap per run to prevent runaway output
let totalOutputChars = 0;
let outputLimitHit = false;

function sendStream(type, msg) {
  if (outputLimitHit) return;
  totalOutputChars += msg?.length || 0;
  if (totalOutputChars > MAX_OUTPUT_CHARS) {
    outputLimitHit = true;
    try {
      postMessage({ type: "output_limit", msg: "📏 Output limit exceeded" });
    } finally {
      // terminate this worker to stop execution immediately
      // ensures infinite-print loops are halted quickly
      self.close();
    }
    return;
  }
  postMessage({ type, msg });
}

async function initPyodide() {
  pyodide = await loadPyodide({
    stdout: (msg) => sendStream("stdout", msg),
    stderr: (msg) => sendStream("stderr", msg),
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
    // reset output counters per run
    totalOutputChars = 0;
    outputLimitHit = false;
    // eagerly load imports so large libs download before exec
    await pyodide.loadPackagesFromImports(code);
    const result = await pyodide.runPythonAsync(code);
    postMessage({ type: "done", result });
  } catch (err) {
    // If we already hit the output limit, the worker is closing; avoid sending extra noise
    if (!outputLimitHit) {
      postMessage({ type: "error", error: err.toString() });
    }
  }
};
