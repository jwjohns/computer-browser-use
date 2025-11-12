# Web UI

React/Vite front-end for the interactive desktop + terminal demo. It mirrors the reference UI from the `llm_computer_use_full` package.

## Commands
```bash
pnpm install        # once
pnpm run dev        # start Vite on http://localhost:5173
pnpm run build      # optional production build
```

## Tabs
- **Desktop** - wraps the LXDE noVNC session served from http://localhost:6080.
- **Terminal** - connects to `ws://<host>:3000/pty` with Xterm.js.
- **Open URL bar** - POSTs to `/tool/open_url` and focuses the Desktop tab so you can watch the browser launch.

Override the backend origin with `VITE_AGENT_URL` if you are not running everything on localhost.
