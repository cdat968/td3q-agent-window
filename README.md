# Windows Agent Runtime

Status: Phase 7 calibration MVP.

This is the desktop runtime process for one Windows game machine. It connects to
the Agent Orchestrator over WebSocket, reports readiness, receives commands,
writes local artifacts, and reports command/run results back to the backend DB
through the orchestrator.

It does not yet click inside TD3Q. In Windows mode, `run.start` for
`td3q.attendance` runs a calibration proof: focus/maximize the publisher game
window, capture a screenshot, scan the top menu band for attendance candidates,
and write debug artifacts.

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
   `scenarioId: "td3q.attendance"`. In Windows mode, `run.start` writes:

```text
C:\td3q-agent\artifacts\<run-id>\calibration-screenshot.png
C:\td3q-agent\artifacts\<run-id>\calibration-overlay.png
C:\td3q-agent\artifacts\<run-id>\calibration.json
C:\td3q-agent\artifacts\<run-id>\top-menu-band.png
C:\td3q-agent\artifacts\<run-id>\right-ui-band.png
C:\td3q-agent\artifacts\<run-id>\full-game-band.png
C:\td3q-agent\artifacts\<run-id>\attendance-candidate-sheet.png
C:\td3q-agent\artifacts\<run-id>\attendance-candidate-01.png
C:\td3q-agent\artifacts\<run-id>\attendance-candidate-02.png
C:\td3q-agent\artifacts\<run-id>\attendance-candidate-03.png
C:\td3q-agent\artifacts\<run-id>\attendance-candidate-04.png
C:\td3q-agent\artifacts\<run-id>\attendance-candidate-05.png
C:\td3q-agent\artifacts\<run-id>\attendance-candidate-06.png
C:\td3q-agent\artifacts\<run-id>\attendance-candidate-07.png
C:\td3q-agent\artifacts\<run-id>\attendance-candidate-08.png
C:\td3q-agent\artifacts\<run-id>\attendance-candidate-09.png
C:\td3q-agent\artifacts\<run-id>\attendance-candidate-10.png
C:\td3q-agent\artifacts\<run-id>\attendance-candidate-11.png
C:\td3q-agent\artifacts\<run-id>\attendance-candidate-12.png
C:\td3q-agent\artifacts\<run-id>\attendance-icon-roi.png
C:\td3q-agent\artifacts\<run-id>\attendance-icon-match.png
```

The overlay shows the game canvas, scan bands, candidate boxes, and the selected
attendance match box. The runtime scans full top menu, right-side UI strip, and
full-game coarse bands so right-edge UI is not skipped. If only the legacy
`attendance_icon.png` template exists, the command returns
`needs_template_confirmation` instead of a trusted match. Add
`attendance_icon.windows.png` in `AGENT_TEMPLATE_DIR` after confirming the
correct candidate crop from Windows artifacts.

If `AGENT_BACKEND_HTTP_URL` is configured and the backend has Cloudinary
credentials, the runtime uploads calibration artifacts through:

```text
POST <AGENT_BACKEND_HTTP_URL>/api/agent-artifacts/upload
```

Cloudinary credentials must stay on the backend `.env`, not in the Windows
runtime `.env`.

## Next Runtime Work

- Wrap this CLI as a Windows Service/Desktop Agent Manager process.
- Implement `td3q.attendance` runner against the publisher app.
- Add Lu Bu preflight and noon dispatch policy in the scheduler/orchestrator.
