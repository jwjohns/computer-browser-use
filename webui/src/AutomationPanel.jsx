import { useState } from 'react';
import { agentHttpBaseUrl } from './config';

async function postJson(path, body) {
  const res = await fetch(`${agentHttpBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    const detail = data?.error || `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return data;
}

export default function AutomationPanel() {
  const [targetUrl, setTargetUrl] = useState('https://example.com');
  const [mirrorDesktop, setMirrorDesktop] = useState(true);
  const [domNodes, setDomNodes] = useState([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const navigate = async () => {
    setBusy(true);
    setStatus('Navigating…');
    try {
      await postJson('/automation/navigate', { url: targetUrl, mirrorDesktop });
      setStatus('Navigation complete');
    } catch (err) {
      console.error('automation navigate failed', err);
      setStatus(`Navigate failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const refreshDom = async () => {
    setBusy(true);
    setStatus('Refreshing DOM…');
    try {
      const res = await fetch(`${agentHttpBaseUrl}/automation/dom`);
      const data = await res.json();
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      setDomNodes(data.nodes || []);
      setStatus(`Loaded ${data.nodes?.length || 0} elements`);
    } catch (err) {
      console.error('automation dom failed', err);
      setStatus(`DOM fetch failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const sendAction = async (node, action, text) => {
    setBusy(true);
    setStatus(`Running ${action} on ${node.selector}`);
    try {
      await postJson('/automation/action', { selector: node.selector, action, text });
      setStatus(`${action} succeeded`);
    } catch (err) {
      console.error('automation action failed', err);
      setStatus(`${action} failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          value={targetUrl}
          onChange={(e) => setTargetUrl(e.target.value)}
          placeholder="https://example.com"
          style={{ flex: 1, minWidth: 240, padding: 10, borderRadius: 8, border: '1px solid #ccc' }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={mirrorDesktop} onChange={(e) => setMirrorDesktop(e.target.checked)} />
          Mirror desktop
        </label>
        <button onClick={navigate} disabled={busy} style={{ padding: '10px 16px' }}>
          {busy ? 'Working…' : 'Navigate'}
        </button>
        <button onClick={refreshDom} disabled={busy} style={{ padding: '10px 16px' }}>
          Refresh DOM
        </button>
      </div>
      {status && <div style={{ fontSize: 14, color: '#333' }}>{status}</div>}
      <div style={{ maxHeight: '50vh', overflowY: 'auto', border: '1px solid #ddd', borderRadius: 8, padding: 12 }}>
        {domNodes.length === 0 && <div style={{ color: '#777' }}>No DOM snapshot loaded yet.</div>}
        {domNodes.map((node) => (
          <AutomationNode key={node.id} node={node} busy={busy} onAction={sendAction} />
        ))}
      </div>
    </div>
  );
}

function AutomationNode({ node, busy, onAction }) {
  const [text, setText] = useState('');
  const label = node.ariaLabel || node.role || node.tag;
  return (
    <div style={{ borderBottom: '1px solid #eee', padding: '8px 0' }}>
      <div style={{ fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 13, color: '#555' }}>{node.text || '<no text>'}</div>
      <div style={{ fontSize: 12, color: '#777' }}>Selector: {node.selector || 'n/a'}</div>
      <div style={{ fontSize: 12, color: '#777' }}>Rect: {`${node.rect?.width.toFixed?.(0) || '?'}×${node.rect?.height.toFixed?.(0) || '?'}`}</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <button disabled={!node.selector || busy} onClick={() => onAction(node, 'click')}>
          Click
        </button>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Text to type"
          style={{ flex: 1, minWidth: 120, padding: '4px 8px' }}
        />
        <button disabled={!node.selector || busy} onClick={() => onAction(node, 'type', text)}>
          Type
        </button>
      </div>
    </div>
  );
}
