# Interactive VNC + Terminal Stack

A self-contained environment that exposes an Ubuntu LXDE desktop over noVNC and an interactive Bash shell over WebSocket. The goal is to mirror the "agent computer" experience used in research demos while keeping the deployment simple, reproducible, and free of GHCR dependencies.

## Architecture
- **desk** (Docker) – `dorowu/ubuntu-desktop-lxde-vnc`. Runs the GUI session, serves noVNC on `6080`, and VNC on `5901`.
- **agent** (Node 20) – Express server that exposes:
  - `GET /health` for readiness checks
  - `WS /pty` backed by `node-pty` for interactive shells
  - `POST /tool/open_url` for browser launches inside `desk`
  The container mounts `/var/run/docker.sock`, letting it exec directly inside `desk`.
- **webui** (React + Vite) – Single-page app that embeds the desktop iframe, renders the terminal via Xterm.js, and fronts the tool endpoints.

## Prerequisites
- Docker Desktop (validated on macOS; Linux/Windows should work with minor adjustments)
- Node.js 18+ if you want to run the web UI dev server
- pnpm (Corepack-enabled Node runtimes include it automatically)

## Quick Start
1. **Containers**
   ```bash
   docker compose build --no-cache
   docker compose up -d
   curl http://localhost:3000/health   # => {"ok":true}
   ```
   - Desktop: <http://localhost:6080>
   - Terminal WS: `ws://localhost:3000/pty`
   - Tool endpoint: `POST http://localhost:3000/tool/open_url` with `{ "url": "https://example.com" }`

2. **Web UI (optional dev server)**
   ```bash
   cd webui
   pnpm install
   pnpm run dev
   # open http://localhost:5173
   ```
   - **Desktop tab** – Embedded noVNC session.
   - **Terminal tab** – Live shell via WebSocket + Xterm.js.
   - **Open URL bar** – Calls `/tool/open_url` and focuses the desktop so you can watch the launch.

3. **Shutdown**
   ```bash
   docker compose down
   ```

## Operational Notes
- The default `desk` image is pulled from Docker Hub, avoiding GHCR authentication issues.
- The web UI automatically points at the agent host; override with `VITE_AGENT_URL` when reverse proxying or tunneling.
- CORS is permissive by default so you can access the UI from any LAN host. Set `AGENT_STRICT_CORS=true` and populate `AGENT_ALLOWED_ORIGINS=http://your-host:5173` (comma-separated) to lock it down.

## Request Flow (Open URL)
1. User submits a URL in the web UI.
2. The UI POSTs the value to the agent.
3. The agent locates the `desk` container, auto-detects the active X11 display, selects an installed browser (`firefox`, `chromium`, `google-chrome`, etc.), and launches it via `DISPLAY=<detected> nohup <browser> <url>`.
4. LXDE opens the page and the embedded desktop iframe reflects the change instantly.

## Extending the Stack
The baseline experience is manual but intentionally structured so you can add automation.

### Option A – Screenshot + Local VLM Loop (e.g., Ollama)
1. Install helpers inside `desk`:
   ```bash
   docker compose exec desk apt-get update
   docker compose exec desk apt-get install -y imagemagick xdotool
   ```
2. Add a helper in `agent/server.js` that execs `import -window root`, base64-encodes the PNG, and returns it.
3. Create `POST /tool/vlm_navigate` that collects the screenshot, calls your Ollama model (`http://host.docker.internal:11434/api/generate`, `model: "llava"` or similar), and returns the response.
4. Use `xdotool` exec helpers to press keys or click coordinates based on the model output.

> **Reality check:** Vision-language models still struggle with pixel-perfect desktop control. Treat them as "describe / highlight" tools unless you pair them with other signals.

### Option B – DOM-Driven Automation (Manus-style)
1. Launch Chromium in `desk` with `--remote-debugging-port=9222` or run a headless Playwright sidecar.
2. From the agent, connect via the Chrome DevTools Protocol to retrieve DOM nodes, bounding boxes, and accessible labels.
3. Feed the structured element list into a planner model (local or hosted) to select the next action.
4. Execute the action via CDP (`Runtime.evaluate`, `Input.dispatchMouseEvent`, etc.) and mirror it in LXDE for observability.
5. Iterate until the workflow completes.

This hybrid—DOM introspection plus deterministic actuators—matches how Manus AI, Augment, and similar systems achieve reliability compared to screenshot-only reasoning.

### Suggested API Surface to Add
- `POST /tool/screenshot` – Returns a base64 PNG capture from LXDE.
- `POST /tool/keyboard` / `POST /tool/mouse` – Simple wrappers around `xdotool`/`ydotool` for scripted input.
- `POST /tool/dom_snapshot` – Streams the DOM/element metadata from a debugger connection.
- `POST /tool/automation` – High-level orchestration endpoint that can chain LLM calls and actuators.

The Docker socket mount already gives the agent container the privileges it needs to implement all of the above.
