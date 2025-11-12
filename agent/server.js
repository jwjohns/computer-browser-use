import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import Docker from "dockerode";

const app = express();
const PORT = 3000;

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

// Open URL inside the 'desk' container via docker exec
const docker = new Docker({ socketPath: "/var/run/docker.sock" });

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
    const list = await docker.listContainers({ filters: { label: ["com.docker.compose.service=desk"] } });
    if (!list.length) return res.status(404).json({ ok: false, error: "desk container not found" });

    const desk = docker.getContainer(list[0].Id);
    console.log(`open_url launching in desk -> ${parsedUrl.toString()}`);
    const browserLauncher = `
set -euo pipefail

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

    const exec = await desk.exec({
      Cmd: ["bash", "-lc", browserLauncher],
      Env: [`URL=${parsedUrl.toString()}`],
      AttachStdout: true,
      AttachStderr: true
    });

    const stream = await exec.start({ hijack: true, stdin: false });
    await new Promise((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
    });

    const inspect = await exec.inspect();
    if (inspect.ExitCode !== 0) {
      throw new Error(`browser launch failed with exit code ${inspect.ExitCode}`);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("open_url error:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});
