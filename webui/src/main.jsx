import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import LiveTerminal from './LiveTerminal';
import LiveDesktop from './LiveDesktop';
import { agentHttpBaseUrl } from './config';

function Tabs({ tabs, active, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid #ddd', marginBottom: 12 }}>
      {tabs.map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          style={{
            padding: '8px 14px',
            border: 'none',
            borderBottom: active === t ? '3px solid #111' : '3px solid transparent',
            background: 'transparent',
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

function App() {
  const [tab, setTab] = useState('Desktop');
  const [url, setUrl] = useState('https://example.com');
  const [isOpening, setIsOpening] = useState(false);
  const urlInputRef = useRef(null);

  useEffect(() => {
    function onKey(e) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'd') setTab('Desktop');
      if (e.key === 't') setTab('Terminal');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleOpen = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;

    setIsOpening(true);
    try {
      console.debug('Posting /tool/open_url →', agentHttpBaseUrl, trimmed);
      const res = await fetch(`${agentHttpBaseUrl}/tool/open_url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed })
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        const detail = payload?.error ? `: ${payload.error}` : '';
        throw new Error(`HTTP ${res.status}${detail}`);
      }
      setTab('Desktop');
    } catch (err) {
      console.error('openUrl failed:', err);
      alert(`Failed to open URL. ${err?.message || err}`);
    } finally {
      setIsOpening(false);
    }
  };

  return (
    <div style={{ padding: 20, maxWidth: 1280, margin: '0 auto' }}>
      <h1 style={{ marginBottom: 10 }}>Agent Computer</h1>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          ref={urlInputRef}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleOpen(); }}
          placeholder="Enter a URL to open…"
          style={{ flex: 1, padding: 10, borderRadius: 8, border: '1px solid #ccc' }}
        />
        <button
          onClick={handleOpen}
          disabled={isOpening}
          style={{ padding: '10px 16px', border: 'none', borderRadius: 8, background: '#111', color: 'white', fontWeight: 700, cursor: isOpening ? 'wait' : 'pointer', opacity: isOpening ? 0.6 : 1 }}
        >
          {isOpening ? 'Opening…' : 'Open'}
        </button>
      </div>

      <Tabs tabs={['Desktop', 'Terminal']} active={tab} onChange={setTab} />

      <div>
        {tab === 'Desktop' && <LiveDesktop />}
        {tab === 'Terminal' && (
          <div>
            <div style={{ marginBottom: 8, fontWeight: 600 }}>Terminal</div>
            <LiveTerminal />
          </div>
        )}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
