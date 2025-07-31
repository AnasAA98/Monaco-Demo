'use client';

import CodeEditor from '@/components/CodeEditor';  // ⬅️ alias “@/” points to /src

export default function IDEPage() {
  return (
    <main style={{ minHeight: '100vh', background: '#1e1e1e', color: 'white' }}>
      <h1 style={{ padding: '1rem', fontSize: '1.5rem' }}>Monaco IDE</h1>
      <CodeEditor />
    </main>
  );
}
