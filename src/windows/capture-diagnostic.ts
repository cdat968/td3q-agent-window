import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfig } from "../config";
import type { AgentArtifactDraft, AgentToServerMessage } from "../protocol";
import { renderOverlay } from "./overlay-renderer";
import {
    captureScreenBoundsPng,
    getPrimaryAndVirtualScreenBounds,
    type CaptureDpiResult,
} from "./screen-capture";
import type { PixelBox, WindowStabilization } from "./types";
import { stabilizeGameWindow } from "./window-controller";

type SendProgress = (message: AgentToServerMessage) => void;

type CaptureSource =
    | "primary-logical"
    | "virtual-screen"
    | "window-rect"
    | "client-rect";

type CaptureCandidate = {
    source: CaptureSource;
    role: string;
    path: string;
    bounds: PixelBox;
    ok: boolean;
    selected: boolean;
    dpi?: CaptureDpiResult;
    error?: string;
};

type CaptureDiagnosticResult = {
    mode: "capture-diagnostic";
    captureSource: CaptureSource;
    selectedCapture: CaptureCandidate;
    captureCandidates: CaptureCandidate[];
    stabilized: WindowStabilization;
    artifacts: AgentArtifactDraft[];
};

function artifactPath(config: RuntimeConfig, runId: string, fileName: string) {
    return path.join(config.artifactDir, runId, fileName);
}

function progress(
    send: SendProgress,
    runId: string,
    percent: number,
    message: string,
    metadata?: Record<string, unknown>,
) {
    send({
        type: "run_event",
        runId,
        eventType: "run_progress",
        message: `${percent}% ${message}`,
        metadata: {
            percent,
            phase: "capture-diagnostic",
            ...(metadata ?? {}),
        },
    });
}

function area(box: PixelBox) {
    return box.width * box.height;
}

function chooseCaptureCandidate(candidates: CaptureCandidate[]) {
    const ok = candidates.filter((candidate) => candidate.ok);
    const windowRect = ok.find((candidate) => candidate.source === "window-rect");
    const primary = ok.find((candidate) => candidate.source === "primary-logical");

    if (windowRect && (!primary || area(windowRect.bounds) >= area(primary.bounds))) {
        return windowRect;
    }

    const virtual = ok.find((candidate) => candidate.source === "virtual-screen");
    if (virtual) return virtual;

    if (primary) return primary;

    return ok[0];
}

async function captureCandidate(candidate: CaptureCandidate) {
    try {
        const dpi = await captureScreenBoundsPng(candidate.path, candidate.bounds);
        return {
            ...candidate,
            ok: true,
            dpi,
        };
    } catch (error) {
        return {
            ...candidate,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

function relativeBox(box: PixelBox, base: PixelBox): PixelBox {
    return {
        x: box.x - base.x,
        y: box.y - base.y,
        width: box.width,
        height: box.height,
    };
}

function captureArtifact(candidate: CaptureCandidate): AgentArtifactDraft | undefined {
    if (!candidate.ok) return undefined;

    return {
        kind: "screenshot",
        localPath: candidate.path,
        metadata: {
            source: "windows-capture-diagnostic",
            role: candidate.role,
            captureSource: candidate.source,
            bounds: candidate.bounds,
            selected: candidate.selected,
            dpiAwarenessAttempted: candidate.dpi?.dpiAwarenessAttempted,
            dpiAwarenessOk: candidate.dpi?.dpiAwarenessOk,
            dpiAwarenessError: candidate.dpi?.dpiAwarenessError,
        },
    };
}

export async function runWindowsCaptureDiagnostic(
    config: RuntimeConfig,
    runId: string,
    send: SendProgress,
): Promise<CaptureDiagnosticResult> {
    if (config.mode !== "windows") {
        throw new Error("capture diagnostic requires AGENT_MODE=windows");
    }

    await mkdir(path.join(config.artifactDir, runId), { recursive: true });

    progress(send, runId, 10, "command accepted");
    const stabilized = await stabilizeGameWindow(config);
    progress(send, runId, 20, "game process/window found", {
        processName: stabilized.processName,
        processId: stabilized.processId,
        hwnd: stabilized.hwnd,
    });
    progress(send, runId, 30, "window maximized/focused", {
        windowRect: stabilized.windowRect,
        clientRect: stabilized.clientRect,
    });

    const screenBounds = await getPrimaryAndVirtualScreenBounds();
    const planned: CaptureCandidate[] = [
        {
            source: "primary-logical",
            role: "capture-primary-logical",
            path: artifactPath(config, runId, "capture-primary-logical.png"),
            bounds: screenBounds.primary,
            ok: false,
            selected: false,
        },
        {
            source: "virtual-screen",
            role: "capture-virtual-screen",
            path: artifactPath(config, runId, "capture-virtual-screen.png"),
            bounds: screenBounds.virtual,
            ok: false,
            selected: false,
        },
        ...(stabilized.windowRect
            ? [
                  {
                      source: "window-rect" as const,
                      role: "capture-window-rect",
                      path: artifactPath(config, runId, "capture-window-rect.png"),
                      bounds: stabilized.windowRect,
                      ok: false,
                      selected: false,
                  },
              ]
            : []),
        ...(stabilized.clientRect
            ? [
                  {
                      source: "client-rect" as const,
                      role: "capture-client-rect",
                      path: artifactPath(config, runId, "capture-client-rect.png"),
                      bounds: stabilized.clientRect,
                      ok: false,
                      selected: false,
                  },
              ]
            : []),
    ];

    const captured: CaptureCandidate[] = [];
    for (const candidate of planned) {
        captured.push(await captureCandidate(candidate));

        if (candidate.source === "primary-logical") {
            progress(send, runId, 40, "primary capture done", {
                bounds: candidate.bounds,
            });
        }
    }

    progress(send, runId, 55, "virtual/window/client capture done", {
        captureCandidates: captured.map((candidate) => ({
            source: candidate.source,
            bounds: candidate.bounds,
            ok: candidate.ok,
            error: candidate.error,
        })),
    });

    const selected = chooseCaptureCandidate(captured);
    if (!selected) {
        throw new Error("capture diagnostic failed: no usable capture source");
    }

    const selectedPath = artifactPath(config, runId, "capture-selected.png");
    await copyFile(selected.path, selectedPath);

    const captureCandidates = captured.map((candidate) => ({
        ...candidate,
        selected: candidate.source === selected.source,
    }));
    const selectedCapture =
        captureCandidates.find((candidate) => candidate.source === selected.source) ??
        selected;
    const overlayBase =
        captureCandidates.find((candidate) => candidate.source === "virtual-screen" && candidate.ok) ??
        captureCandidates.find((candidate) => candidate.source === "primary-logical" && candidate.ok) ??
        selectedCapture;
    const overlayPath = artifactPath(config, runId, "capture-selection-overlay.png");
    await renderOverlay(overlayBase.path, overlayPath, [
        ...captureCandidates
            .filter((candidate) => candidate.ok)
            .map((candidate) => ({
                box: relativeBox(candidate.bounds, overlayBase.bounds),
                color: candidate.selected ? ("green" as const) : ("yellow" as const),
            })),
    ]);

    progress(send, runId, 70, "capture source selected", {
        captureSource: selected.source,
        bounds: selected.bounds,
    });

    const jsonPath = artifactPath(config, runId, "calibration.json");
    const body = {
        mode: "capture-diagnostic",
        captureSource: selected.source,
        selectedCapture,
        captureCandidates,
        screen: stabilized.screen,
        windowRect: stabilized.windowRect,
        clientRect: stabilized.clientRect,
        generatedAt: new Date().toISOString(),
    };
    await writeFile(jsonPath, JSON.stringify(body, null, 2), "utf8");

    const artifacts: AgentArtifactDraft[] = [
        ...captureCandidates
            .map(captureArtifact)
            .filter((artifact): artifact is AgentArtifactDraft => Boolean(artifact)),
        {
            kind: "screenshot",
            localPath: selectedPath,
            metadata: {
                source: "windows-capture-diagnostic",
                role: "capture-selected",
                captureSource: selected.source,
                bounds: selected.bounds,
                selected: true,
            },
        },
        {
            kind: "overlay",
            localPath: overlayPath,
            metadata: {
                source: "windows-capture-diagnostic",
                role: "capture-selection-overlay",
                captureSource: selected.source,
                overlayBaseSource: overlayBase.source,
                captureCandidates,
            },
        },
        {
            kind: "trace",
            localPath: jsonPath,
            metadata: {
                source: "windows-capture-diagnostic",
                role: "calibration-json",
                captureSource: selected.source,
                captureCandidates,
            },
        },
    ];

    return {
        mode: "capture-diagnostic",
        captureSource: selected.source,
        selectedCapture,
        captureCandidates,
        stabilized,
        artifacts,
    };
}
