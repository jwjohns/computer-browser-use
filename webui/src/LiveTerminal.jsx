import { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import 'xterm/css/xterm.css';
import { agentWsBaseUrl } from './config';

export default function LiveTerminal() {
  const termRef = useRef(null);

  useEffect(() => {
    if (!termRef.current) return () => {};

    const term = new Terminal({
      convertEol: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 14
    });
    term.open(termRef.current);

    const ws = new WebSocket(`${agentWsBaseUrl}/pty`);

    const sendMessage = (payload) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify(payload));
      } catch (err) {
        console.warn('failed to send ws payload', err);
      }
    };

    const writeResize = (cols, rows) => {
      sendMessage({ type: 'resize', cols: cols ?? term.cols ?? 120, rows: rows ?? term.rows ?? 32 });
    };

    ws.onopen = () => {
      term.writeln('\r\n[connected]');
      writeResize();
    };
    ws.onmessage = (e) => term.write(e.data);
    ws.onclose = () => term.writeln('\r\n[disconnected]');
    ws.onerror = (e) => console.error('WS error', e);

    const disposeResize = term.onResize(({ cols, rows }) => writeResize(cols, rows));
    const disposeData = term.onData((data) => sendMessage({ type: 'input', data }));

    return () => {
      try { ws.close(); } catch {}
      disposeResize?.dispose?.();
      disposeData?.dispose?.();
      term.dispose();
    };
  }, []);

  return <div ref={termRef} style={{ height: '40vh', border: '1px solid #ccc', borderRadius: 8 }} />;
}
