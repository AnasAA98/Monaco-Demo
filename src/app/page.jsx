'use client';
import PythonIDE from '@/components/PythonIDE';

export default function PyIDEPage() {
  return (
    <main style={{ height: '100vh', background: '#111' }}>
      <h1 style={{ margin: 0, padding: '1rem', color: 'white' }}>Monaco Python IDE</h1>
      <PythonIDE />
    </main>
  );
}
