import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import Docker from "dockerode";
import CDP from "chrome-remote-interface";
import { finished } from "stream/promises";
import net from "net";

const app = express();
const PORT = 3000;

const automationConfig = {
  host: process.env.AUTOMATION_CHROME_HOST || "desk",
  port: Number(process.env.AUTOMATION_CHROME_PORT || "9222"),
  profileDir: process.env.AUTOMATION_CHROME_PROFILE || "/tmp/automation-profile",
  procLabel: process.env.AUTOMATION_CHROME_PROC || "automation-chrome"
};

const detectDisplayFn = `
detect_display() {
  if [ -n "\${DISPLAY:-}" ]; then
    printf '%s' "$DISPLAY"
    return 0
  fi

  for socket in /tmp/.X11-unix/X*; do
    [ -S "$socket" ] || continue
    suffix="\${socket##*/X}"
    if [ -n "$suffix" ]; then
      printf ':%s' "$suffix"
      return 0
    fi
  done
  printf ':0'
}
`;

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const deskFilter = { filters: { label: ["com.docker.compose.service=desk"] } };
let cachedDeskContainer = null;
let automationTargetId = null;
let automationInitPromise = null;

async function getDeskContainer(forceRefresh = false) {
  if (!forceRefresh && cachedDeskContainer) return cachedDeskContainer;
  const list = await docker.listContainers(deskFilter);
  if (!list.length) throw new Error("desk container not found");
  cachedDeskContainer = docker.getContainer(list[0].Id);
  return cachedDeskContainer;
}

async function execInDesk(cmd, { env = [], cwd } = {}) {
  const desk = await getDeskContainer();
  const exec = await desk.exec({
    Cmd: cmd,
    Env: env,
    WorkingDir: cwd,
    AttachStdout: true,
    AttachStderr: true
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  let output = "";
  stream.on("data", (chunk) => {
    output += chunk.toString();
  });
  await finished(stream);
  const inspect = await exec.inspect();
  if (inspect.ExitCode !== 0) {
    throw new Error(`desk exec failed with code ${inspect.ExitCode}: ${output.trim()}`);
  }
  return output;
}

async function runDeskScript(script) {
  return execInDesk(["bash", "-lc", script]);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPort(host, port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port }, () => {
          socket.end();
          resolve();
        });
        socket.once("error", (err) => {
          socket.destroy();
          reject(err);
        });
      });
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`Timed out waiting for ${host}:${port}`);
}

async function tailAutomationLog(lines = 80) {
  try {
    const log = await runDeskScript(`tail -n ${lines} /tmp/${automationConfig.procLabel}.log 2>/dev/null || true`);
    return log.trim();
  } catch {
    return "";
  }
}

async function ensureAutomationChrome() {
  if (automationInitPromise) return automationInitPromise;

  automationInitPromise = (async () => {
    const launchScript = `
set -euo pipefail
${detectDisplayFn}
if pgrep -f '${automationConfig.procLabel}' >/dev/null 2>&1; then
  exit 0
fi

DISPLAY=$(detect_display)
for candidate in chromium-browser google-chrome google-chrome-stable; do
  if command -v "$candidate" >/dev/null 2>&1; then
    mkdir -p ${automationConfig.profileDir}
    DISPLAY=$DISPLAY nohup "$candidate" \\
      --remote-debugging-address=0.0.0.0 \\
      --remote-debugging-port=${automationConfig.port} \\
      --user-data-dir=${automationConfig.profileDir} \\
      --no-sandbox --disable-dev-shm-usage --disable-gpu --start-maximized about:blank \\
      >/tmp/${automationConfig.procLabel}.log 2>&1 &
    exit 0
  fi
done
echo "No Chromium-based browser available inside desk" >&2
exit 1
`;
    await runDeskScript(launchScript);
    await waitForPort(automationConfig.host, automationConfig.port, 20000).catch(async (err) => {
      const log = await tailAutomationLog();
      const detail = log ? `\nRecent automation log:\n${log}` : "";
      throw new Error(`Chrome DevTools not reachable (${err.message}).${detail}`);
    });
  })();

  try {
    await automationInitPromise;
  } finally {
    automationInitPromise = null;
  }
}

async function withAutomationSession(fn) {
  await ensureAutomationChrome();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let client;
    try {
      client = await CDP({ host: automationConfig.host, port: automationConfig.port });
      const { Target } = client;
      if (!automationTargetId) {
        const { targetId } = await Target.createTarget({ url: "about:blank" });
        automationTargetId = targetId;
      }
      const { sessionId } = await Target.attachToTarget({ targetId: automationTargetId, flatten: true });
      const session = client.session(sessionId);
      await session.Page.enable();
      await session.Runtime.enable();
      const result = await fn(session);
      await Target.detachFromTarget({ sessionId });
      return result;
    } catch (err) {
      automationTargetId = null;
      if (attempt === 2) throw err;
      await sleep(500);
    } finally {
      if (client) await client.close();
    }
  }
}

function waitForEvent(session, eventName, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const handler = () => {
      clearTimeout(timer);
      session.off(eventName, handler);
      resolve();
    };
    const timer = setTimeout(() => {
      session.off(eventName, handler);
      reject(new Error(`${eventName} timed out`));
    }, timeoutMs);
    session.on(eventName, handler);
  });
}

async function navigateAutomationChrome(url) {
  return withAutomationSession(async (session) => {
    const loadEvent = waitForEvent(session, "Page.loadEventFired", 20000).catch(() => {});
    await session.Page.navigate({ url });
    await loadEvent;
  });
}

const DOM_EXTRACTION_EXPR = `(() => {
  const buildSelector = (el) => {
    if (!el) return '';
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      if (node.id) {
        parts.unshift(node.tagName.toLowerCase() + '#' + node.id);
        break;
      }
      let index = 1;
      let sibling = node;
      while (sibling.previousElementSibling) {
        sibling = sibling.previousElementSibling;
        if (sibling.tagName === node.tagName) index += 1;
      }
      parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + index + ')');
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  const nodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null);
  while (walker.nextNode() && nodes.length < 200) {
    const el = walker.currentNode;
    const rect = el.getBoundingClientRect();
    if (!rect || (rect.width < 1 && rect.height < 1)) continue;
    nodes.push({
      id: nodes.length,
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
      role: el.getAttribute('role') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      href: el.getAttribute('href') || '',
      selector: buildSelector(el),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    });
  }
  return nodes;
})()`;

async function automationDomSnapshot() {
  return withAutomationSession(async (session) => {
    const { result } = await session.Runtime.evaluate({
      expression: DOM_EXTRACTION_EXPR,
      returnByValue: true,
      awaitPromise: true
    });
    return result.value || [];
  });
}

async function automationDomAction({ action, selector, text }) {
  return withAutomationSession(async (session) => {
    const expression = `(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      if (!target) {
        return { ok: false, error: 'selector not found' };
      }
      target.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      const type = ${JSON.stringify(action)};
      if (type === 'click') {
        target.click();
        return { ok: true };
      }
      if (type === 'type') {
        const value = ${JSON.stringify(text ?? '')};
        if (typeof target.value === 'string') {
          target.focus();
          target.value = value;
          target.dispatchEvent(new Event('input', { bubbles: true }));
          target.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true };
        }
        return { ok: false, error: 'element is not input-like' };
      }
      return { ok: false, error: 'unsupported action' };
    })()`;
    const { result } = await session.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
    return result.value || { ok: false, error: 'unknown automation response' };
  });
}

const defaultAllowedOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173"
];
const parseOrigins = (value = "") =>
  value
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
const strictOrigins = new Set([...defaultAllowedOrigins, ...parseOrigins(process.env.AGENT_ALLOWED_ORIGINS)]);
const useStrictCors = process.env.AGENT_STRICT_CORS === "true";

const hostnamesMatch = (req, origin) => {
  try {
    const originHost = new URL(origin).hostname;
    const reqHost = (req.headers.host || "").split(":")[0];
    return Boolean(originHost && reqHost && originHost === reqHost);
  } catch {
    return false;
  }
};

const corsOptionsDelegate = (req, callback) => {
  if (!useStrictCors) return callback(null, { origin: true });

  const origin = req.headers.origin;
  if (!origin || strictOrigins.has(origin) || hostnamesMatch(req, origin)) {
    return callback(null, { origin: true });
  }
  const err = new Error(`Origin ${origin} not allowed by CORS`);
  err.status = 403;
  console.warn(err.message);
  return callback(err);
};

app.use(cors(corsOptionsDelegate));
app.use(express.json());

app.use((err, _req, res, next) => {
  if (err?.message?.includes("CORS")) {
    return res.status(403).json({ ok: false, error: err.message });
  }
  return next(err);
});

// Health
app.get("/health", (_req, res) => res.json({ ok: true }));

// Start HTTP
const server = app.listen(PORT, () => console.log(`Agent listening on ${PORT}`));

// PTY over WebSocket
const wss = new WebSocketServer({ server, path: "/pty" });
wss.on("connection", (ws) => {
  const shell = process.env.SHELL || "bash";
  const p = pty.spawn(shell, ["-l"], {
    name: "xterm-color",
    cols: 120,
    rows: 32,
    cwd: process.env.HOME,
    env: process.env
  });

  p.onData((d) => ws.send(d));
  ws.on("message", (msg) => {
    try {
      const m = JSON.parse(msg.toString());
      if (m.type === "input") p.write(m.data);
      if (m.type === "resize") p.resize(m.cols, m.rows);
    } catch {
      p.write(msg.toString());
    }
  });
  ws.on("close", () => p.kill());
});

app.post("/tool/open_url", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: "missing url" });

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ ok: false, error: "invalid url" });
  }

  try {
    let mirrored = false;
    try {
      await navigateAutomationChrome(parsedUrl.toString());
      mirrored = true;
    } catch (automationErr) {
      console.warn("automation navigate failed, falling back", automationErr);
    }

    if (mirrored) {
      return res.json({ ok: true, via: "automation" });
    }

    console.log(`open_url fallback launch -> ${parsedUrl.toString()}`);
    const fallbackScript = `
set -euo pipefail
${detectDisplayFn}

launch_browser() {
  local disp="$(detect_display)"
  for candidate in firefox chromium-browser google-chrome chromium google-chrome-stable brave-browser xdg-open x-www-browser sensible-browser; do
    if command -v "$candidate" >/dev/null 2>&1; then
      DISPLAY="$disp" nohup "$candidate" "$URL" >/dev/null 2>&1 &
      return 0
    fi
  done
  return 1
}

launch_browser
`;

    await execInDesk(["bash", "-lc", fallbackScript], { env: [`URL=${parsedUrl.toString()}`] });
    res.json({ ok: true, via: "fallback" });
  } catch (e) {
    console.error("open_url error:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/automation/navigate", async (req, res) => {
  const { url, mirrorDesktop = true } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: "missing url" });

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ ok: false, error: "invalid url" });
  }

  try {
    await navigateAutomationChrome(parsedUrl.toString());
    if (mirrorDesktop) {
      await runDeskScript(`
${detectDisplayFn}
if command -v xdotool >/dev/null 2>&1; then
  DISPLAY=$(detect_display) xdotool search --onlyvisible --class chromium windowactivate >/dev/null 2>&1 || true
fi
`);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("automation navigate error", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get("/automation/dom", async (_req, res) => {
  try {
    const nodes = await automationDomSnapshot();
    res.json({ ok: true, nodes });
  } catch (err) {
    console.error("automation dom error", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/automation/action", async (req, res) => {
  const { selector, action, text } = req.body || {};
  if (!selector || !action) {
    return res.status(400).json({ ok: false, error: "selector and action required" });
  }

  try {
    const result = await automationDomAction({ selector, action, text });
    if (!result?.ok) {
      return res.status(400).json({ ok: false, error: result?.error || "action failed" });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("automation action error", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});
