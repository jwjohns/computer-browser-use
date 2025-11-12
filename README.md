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
   - **Automation tab** – DOM-aware controls that drive the Chromium instance via the DevTools protocol (details below).
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

## DOM Automation (Option B Implemented)
The stack now ships with a Chromium instance inside the `desk` container that runs with a persistent user profile and exposes the Chrome DevTools Protocol on port `9222`. This instance renders directly inside LXDE so any automated steps are visible via noVNC.

> **Prerequisite:** ensure Chromium (or Google Chrome) is installed inside `desk`. For example:
> ```bash
> docker compose exec desk apt-get update
> docker compose exec desk apt-get install -y chromium-browser xdotool
> ```
> The automation service will start Chromium automatically once these binaries are present.

### Available endpoints
- `POST /automation/navigate { url, mirrorDesktop }` – Navigates Chromium to `url`. When `mirrorDesktop` is true (default) the window is focused inside LXDE.
- `GET /automation/dom` – Returns a trimmed DOM snapshot (up to 200 visible nodes) including selectors, roles, text snippets, and bounding boxes.
- `POST /automation/action { selector, action, text }` – Executes DOM-level actions through CDP. Supported actions today are `click` and `type`.

These APIs are wired into the new Automation tab in the UI, providing a manual front-end for the workflow Manus-style agents use:

1. Navigate to a page.
2. Refresh the DOM snapshot to inspect elements.
3. Fire DOM-level actions (click/type) directly from the UI to validate selectors.

You can also script these endpoints yourself—e.g., pipe the DOM snapshot into a reasoning model that selects the next element, then call `/automation/action` to execute it.

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
✅ **Implemented in this repository.** The automation tab and `automation/*` endpoints already do the heavy lifting:
1. Chromium (visible inside LXDE) runs with `--remote-debugging-port=9222`.
2. The agent connects via CDP to extract DOM metadata and expose it via `/automation/dom`.
3. LLMs or humans can inspect/score the structured list.
4. `/automation/action` executes clicks/typing through CDP, instantly mirroring the interaction in LXDE.
5. Repeat until the workflow completes.

This hybrid—DOM introspection plus deterministic actuators—matches how Manus AI, Augment, and similar systems achieve reliability compared to screenshot-only reasoning.

### Suggested API Surface to Add
- `POST /tool/screenshot` – Returns a base64 PNG capture from LXDE.
- `POST /tool/keyboard` / `POST /tool/mouse` – Simple wrappers around `xdotool`/`ydotool` for scripted input.
- `POST /tool/dom_snapshot` – Streams the DOM/element metadata from a debugger connection.
- `POST /tool/automation` – High-level orchestration endpoint that can chain LLM calls and actuators.

The Docker socket mount already gives the agent container the privileges it needs to implement all of the above.
