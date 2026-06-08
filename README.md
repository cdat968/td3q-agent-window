# Windows Agent Runtime

Status: Phase 8A game launch and window/canvas ready MVP.

This is the desktop runtime process for one Windows game machine. It connects to
the Agent Orchestrator over WebSocket, reports readiness, receives commands,
writes local artifacts, and reports command/run results back to the backend DB
through the orchestrator.

It does not yet log in, select a server, or click inside TD3Q. In Windows mode,
`run.start` for `td3q.attendance` currently runs launch + ready probe mode:
start the publisher game if needed, focus/maximize its window, capture several
Windows screen sources, select the best source, resolve the real game content
rect, classify the current screen state, upload review artifacts, and report
progress.

## Modes

- `AGENT_MODE=protocol`: validates package, WebSocket protocol, command
  delivery, command results, and local artifact writes on macOS/Linux/Docker.
- `AGENT_MODE=windows`: enables Windows desktop checks for session, game
  process, screen capture, input control, artifact directory, and template
  assets.

Docker is useful only for `protocol` mode. It cannot control the real Windows
desktop session or publisher game window.

## Docker Protocol Test

Build:

```bash
docker build -t td3q-windows-agent-runtime agents/windows-runtime
```

Run:

```bash
docker run --rm \
  -e AGENT_ID=agt-002 \
  -e AGENT_TOKEN=dev-token \
  -e AGENT_WS_URL=ws://host.docker.internal:3010/agents/ws \
  -e AGENT_MODE=protocol \
  td3q-windows-agent-runtime
```

## Local Protocol Test From Repo Root

Terminal 1:

```bash
npm run agents:seed-dev
AGENT_SHARED_TOKEN=dev-token npm run agents:orchestrator
```

Terminal 2:

```bash
AGENT_ID=agt-002 \
AGENT_TOKEN=dev-token \
AGENT_WS_URL=ws://localhost:3010/agents/ws \
AGENT_MODE=protocol \
AGENT_ARTIFACT_DIR=.runtime/agents/agt-002/artifacts \
npm run agents:runtime
```

Terminal 3:

```bash
npm run agents:smoke-live
```

## Windows Laptop Test

1. Install Node.js LTS on the Windows laptop.
2. Copy this repo or at least this runtime folder to the laptop.
3. From the repo root, run `npm install`. If copying only this folder, run
   `npm install` inside `agents/windows-runtime`.
4. Start the backend/orchestrator on the machine that has PostgreSQL access:

```bash
AGENT_SHARED_TOKEN=dev-token npm run agents:orchestrator
```

5. On Windows, create `.env` from `.env.example` and set:

```bash
AGENT_ID=agt-002
AGENT_TOKEN=dev-token
AGENT_WS_URL=ws://<backend-ip>:3010/agents/ws
AGENT_BACKEND_HTTP_URL=http://<backend-ip>:3000
AGENT_MODE=windows
AGENT_ARTIFACT_DIR=C:\td3q-agent\artifacts
AGENT_TEMPLATE_DIR=C:\td3q-agent\templates
GAME_PROCESS_NAME=<publisher-game-process-name>.exe
GAME_LAUNCH_PATH=C:\Users\cdat7\Desktop\ThapPhong\Tháp Phòng Đại Chiến.exe
GAME_LAUNCH_TIMEOUT_MS=60000
GAME_READY_TIMEOUT_MS=90000
GAME_READY_RETRY_MS=1500
WINDOW_STABILIZE_MODE=api-first
WINDOW_STABILIZE_TIMEOUT_MS=10000
```

6. Run doctor first:

```bash
npm run doctor
```

7. Start the runtime:

```bash
npm run start
```

8. From the dashboard/API, queue `agent.doctor` or `run.start` with
   `scenarioId: "td3q.attendance"`. In Windows mode, Phase 8A `run.start`
   launches the game if it is not already running and writes up to ten images
   and two JSON files:

```text
C:\td3q-agent\artifacts\<run-id>\capture-primary-logical.png
C:\td3q-agent\artifacts\<run-id>\capture-virtual-screen.png
C:\td3q-agent\artifacts\<run-id>\capture-window-rect.png
C:\td3q-agent\artifacts\<run-id>\capture-client-rect.png
C:\td3q-agent\artifacts\<run-id>\capture-selected.png
C:\td3q-agent\artifacts\<run-id>\capture-selection-overlay.png
C:\td3q-agent\artifacts\<run-id>\game-content-crop.png
C:\td3q-agent\artifacts\<run-id>\game-content-overlay.png
C:\td3q-agent\artifacts\<run-id>\game-content-gutter-debug.png
C:\td3q-agent\artifacts\<run-id>\game-ready-probe-overlay.png
C:\td3q-agent\artifacts\<run-id>\game-ready-state.json
C:\td3q-agent\artifacts\<run-id>\calibration.json
```

The capture artifacts compare the current primary screen capture, virtual screen
capture, game window rect capture, and game client rect capture. The selected
source is copied to `capture-selected.png`. `capture-selection-overlay.png`
marks all usable bounds and highlights the selected source. Phase 8A does not
create `attendance-candidate-*`, `attendance-icon-roi`, or
`attendance-icon-match` artifacts.

Phase 8A resolves `gameContentRect` from `capture-selected.png`. It uses the
DPI-aware `clientRect` as the base crop, then detects and excludes a low-detail
right gutter. `game-content-overlay.png` marks the base rect, excluded gutter,
and selected game content rect. `game-ready-probe-overlay.png` marks the content
rect used for state classification. `game-ready-state.json` and
`calibration.json` include `launchStatus`, `gameState`, `gameContentRect`,
`baseRect`, `excludedRects`, and `rightGutter` metadata.

`gameState` can be `MAIN_CANVAS_READY`, `AUTH_CHOICE_SCREEN`, `LOGIN_SCREEN`,
`GAME_LOADING`, `UNKNOWN_BLOCKER`, or `POPUP_OPEN`. Phase 8A only classifies
state; login handling, popup close rules, server selection, and attendance
clicks are deferred.

During a run, the agent sends progress events for command accepted, process
checked, launch attempted/already running, window ready, capture done, game
content resolved, game state classified, upload started, upload completed, and
finished. The orchestrator logs these progress messages and persists them in
`automation_run_events`.

If `AGENT_BACKEND_HTTP_URL` is configured and the backend has Cloudinary
credentials, the runtime uploads calibration artifacts through:

```text
POST <AGENT_BACKEND_HTTP_URL>/api/agent-artifacts/upload
```

Cloudinary credentials must stay on the backend `.env`, not in the Windows
runtime `.env`.

## Next Runtime Work

- Wrap this CLI as a Windows Service/Desktop Agent Manager process.
- Implement Phase 8A.1 auth choice/login/server selection.
- Implement Phase 8B `td3q.attendance` runner against the publisher app.
- Add Lu Bu preflight and noon dispatch policy in the scheduler/orchestrator.
