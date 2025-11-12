
# Interactive VNC + Terminal (No GHCR)

Ready-to-run stack that exposes an LXDE desktop over noVNC plus an interactive bash shell over WebSocket. The UI mirrors the reference build that was shared previously and the project now matches those exact run instructions.

## Prereqs
- Docker Desktop (tested on macOS)
- Node 18+ if you want to run the React dev server

## Build + Start the containers
```bash
docker compose build --no-cache
docker compose up -d
curl http://localhost:3000/health   # → {"ok":true}
```

What you get:
- Desktop (noVNC): http://localhost:6080 and embedded inside the UI
- Terminal WebSocket: ws://localhost:3000/pty
- Tool endpoint: POST http://localhost:3000/tool/open_url with `{ "url": "https://example.com" }`

Stop everything with `docker compose down` when you are done.

## Run the Web UI
```bash
cd webui
pnpm install
pnpm run dev
# open http://localhost:5173
```

### Desktop tab
Shows the live LXDE desktop (the same one you can open directly via http://localhost:6080).

### Terminal tab
Connects to bash over WebSocket (`ws://localhost:3000/pty`). Type directly in the embedded terminal.

### Open URL bar
Posts to `/tool/open_url`, launching the requested page inside the LXDE desktop session.

## Notes
- The stack uses `dorowu/ubuntu-desktop-lxde-vnc:latest` from Docker Hub so no GHCR login is required.
- If you serve the UI from anywhere other than localhost you can override the agent URL via `VITE_AGENT_URL` before running `pnpm run dev`/`pnpm run build`.
- Running the UI from a different origin works out of the box. If you need to lock it down, export `AGENT_STRICT_CORS=true` and provide `AGENT_ALLOWED_ORIGINS=http://your-host:5173` (comma separated) before starting the agent container.

## How it works
- **desk** container: LXDE desktop exposed through noVNC on port 6080, plus a VNC server on 5901. All GUI activity happens here.
- **agent** container: Node/Express server that exposes `GET /health`, `WS /pty` (TTY over `node-pty`), and `POST /tool/open_url`. The agent talks to Docker via the mounted socket so it can exec commands inside `desk` without extra services.
- **webui**: React/Vite SPA that embeds the noVNC iframe, streams terminal data with Xterm.js, and wires the Open URL input to the agent.

### Request flow
1. User presses **Open** in the UI.
2. Web UI POSTs `{ url }` to `http://<agent>:3000/tool/open_url`.
3. Agent locates the `desk` container and runs a shell helper that auto-detects the active X11 display, finds an installed browser, and launches it via `DISPLAY=<detected> nohup <browser> <url>`.
4. Browser window shows up inside LXDE; the embedded noVNC iframe reflects the new page immediately.

## Extending with local automation / VLMs
The current build is deterministic and manual, but it was structured so you can bolt on smarter tooling:

### 1. Screenshot + local VLM (Ollama) loop
1. Install helpers inside `desk`: `docker compose exec desk apt-get update && apt-get install -y imagemagick xdotool`.
2. Add a helper in `agent/server.js` that execs `import -window root` (from ImageMagick) and base64-encodes the screenshot.
3. Create a new endpoint, e.g. `POST /tool/vlm_navigate`, that:
   - captures the screenshot
   - POSTs it to your Ollama vision model (`http://host.docker.internal:11434/api/generate`, `model: "llava"` or any other vision-capable model you pulled)
   - returns the model response to the UI or action planner
4. Use `xdotool` exec helpers to press keys/click regions based on the VLM output.

> **Reality check:** pure VLMs still struggle with fine-grained UI control. Treat this as “describe what’s on screen” rather than “fully navigate,” or combine with DOM instrumentation as described below.

### 2. DOM-driven automation (similar to Manus)
1. Launch Chromium inside `desk` with `--remote-debugging-port=9222` or run a headless Playwright sidecar.
2. From the agent, use the Chrome DevTools Protocol (via packages like `chrome-remote-interface` or Playwright’s API) to:
   - capture the DOM tree
   - annotate nodes with bounding boxes/text/ARIA roles under 1–2k tokens
3. Feed that structured list into an LLM (local or remote) that can rank elements and pick the next action.
4. Execute the chosen action through the debugger connection (e.g., `Runtime.evaluate` to click, type, etc.) and mirror it on the LXDE browser for visibility.
5. Repeat until the task completes.

This hybrid approach—DOM introspection + deterministic actuators—matches what tools like Manus AI, Augment, and others do today and is far more reliable than screenshot-only reasoning.

### 3. Suggested endpoints to add
- `POST /tool/screenshot` → returns base64 PNG from LXDE.
- `POST /tool/keyboard` / `/tool/mouse` → wrappers around `xdotool` or `ydotool` inside `desk`.
- `POST /tool/dom_snapshot` → fetches DOM via CDP/Playwright.
- `POST /tool/automation` → orchestrates LLM calls plus actuator invocations.

Feel free to extend the agent with those endpoints; the Docker socket mount already grants the needed access to exec commands in the `desk` container.
