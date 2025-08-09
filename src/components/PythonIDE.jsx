"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";

/* -------------------------------------------------
 *  Monaco loads only on the client (avoids SSR issues)
 * ------------------------------------------------- */
const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
});

export default function PythonIDE() {
  const editorRef = useRef(null);
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);

  // Limit how much output we keep in the UI to avoid slow renders
  const DISPLAY_MAX_CHARS = 50000;
  const appendOutput = (text) => {
    setOutput((prev) => {
      const combined = prev + (text ?? "");
      if (combined.length <= DISPLAY_MAX_CHARS) return combined;
      return combined.slice(-DISPLAY_MAX_CHARS);
    });
  };

  /* -------------------------------------------------
   *  Load Pyodide into Worker (preload)
   * ------------------------------------------------- */
  useEffect(() => {
    // Pre-fetch the worker script so it’s cached by the browser.
    fetch("/pyodideWorker.js");
  }, []);

  /* -------------------------------------------------
   *  Run button handler with true TLE via Worker
   * ------------------------------------------------- */
  const runCode = () => {
    const code = editorRef.current?.getValue() ?? "";
    setBusy(true);
    appendOutput("▶️ Running Python code…\n");

    // 1️⃣  Spawn a new worker per run
    const worker = new Worker("/pyodideWorker.js");

    // 2️⃣  Enforce a 10 000 ms limit
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      worker.terminate();
      appendOutput("⏱ Time limit exceeded\n");
      setBusy(false);
    }, 10000);

    // 3️⃣  Handle messages from worker
    worker.onmessage = (e) => {
      if (timedOut) return; // ignore late messages after timeout
      const { type, msg, result, error } = e.data;

      if (type === "stdout" || type === "stderr") {
        appendOutput(msg);
      } else if (type === "done") {
        clearTimeout(timer);
        appendOutput(String(result ?? "") + "\n");
        setBusy(false);
        worker.terminate();
      } else if (type === "output_limit") {
        clearTimeout(timer);
        appendOutput("\n📏 Output limit exceeded\n");
        setBusy(false);
        worker.terminate();
      } else if (type === "error") {
        clearTimeout(timer);
        appendOutput("❌ " + error + "\n");
        setBusy(false);
        worker.terminate();
      }
    };

    // 4️⃣  Kick off execution
    worker.postMessage({ code });
  };

  /* -------------------------------------------------
   *  Layout
   * ------------------------------------------------- */
  return (
    <div style={{ display: "flex", height: "calc(100vh - 4rem)" }}>
      {/* Editor pane */}
      <div style={{ flex: 1 }}>
        <MonacoEditor
          height="100%"
          defaultLanguage="python"
          defaultValue={`print("Hello, Monaco + Pyodide!")`}
          theme="vs-dark"
          onMount={(editor) => {
            editorRef.current = editor;
          }}
          options={{ minimap: { enabled: false } }}
        />
      </div>

      {/* Console pane */}
      <div
        style={{
          width: "32%",
          background: "#1e1e1e",
          color: "#c7c7c7",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ padding: "0.5rem", borderBottom: "1px solid #333" }}>
          <button
            disabled={busy}
            onClick={runCode}
            style={{
              padding: "0.4rem 0.8rem",
              borderRadius: 4,
              background: "#0d6efd",
              color: "#fff",
              border: "none",
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? "Running…" : "Run Python"}
          </button>{" "}
          <button
            onClick={() => setOutput("")}
            style={{
              padding: "0.4rem 0.8rem",
              borderRadius: 4,
              background: "#6c757d",
              color: "#fff",
              border: "none",
              cursor: "pointer",
            }}
          >
            Clear
          </button>
        </div>
        <pre
          style={{
            flex: 1,
            margin: 0,
            padding: "0.75rem",
            fontFamily: "Menlo, monospace",
            overflowY: "auto",
            whiteSpace: "pre-wrap",
          }}
        >
          {output ||
            "Welcome to Monaco Python IDE 🐍\nClick “Run Python” to execute your code."}
        </pre>
      </div>
    </div>
  );
}
