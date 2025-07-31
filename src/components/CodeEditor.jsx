'use client';
import dynamic from 'next/dynamic';

/* 1️⃣  Load Monaco only on the client to avoid SSR errors :contentReference[oaicite:1]{index=1} */
const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

export default function CodeEditor() {
  return (
    <MonacoEditor
      height="90vh"
      defaultLanguage="javascript"
      defaultValue="// start typing…"
      theme="vs-dark"
      options={{ minimap: { enabled: false } }}
    />
  );
}
