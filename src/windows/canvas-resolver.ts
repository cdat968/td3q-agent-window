import type {
    CanvasCandidate,
    CanvasSource,
    PixelBox,
    WindowStabilization,
} from "./types";

export type CanvasResolution = {
    gameCanvasRect: PixelBox;
    canvasSource: CanvasSource;
    canvasCandidates: CanvasCandidate[];
};

function screenBox(width: number, height: number): PixelBox {
    return { x: 0, y: 0, width, height };
}

export function clipBoxToScreen(box: PixelBox, width: number, height: number): PixelBox | undefined {
    const x = Math.max(0, Math.min(box.x, width - 1));
    const y = Math.max(0, Math.min(box.y, height - 1));
    const right = Math.max(0, Math.min(box.x + box.width, width));
    const bottom = Math.max(0, Math.min(box.y + box.height, height));
    const clippedWidth = right - x;
    const clippedHeight = bottom - y;

    if (clippedWidth <= 0 || clippedHeight <= 0) return undefined;

    return {
        x,
        y,
        width: clippedWidth,
        height: clippedHeight,
    };
}

function makeCandidate(
    source: CanvasSource,
    originalBox: PixelBox,
    width: number,
    height: number,
    selected: boolean,
): CanvasCandidate | undefined {
    const box = clipBoxToScreen(originalBox, width, height);

    return box
        ? {
              source,
              box,
              originalBox,
              selected,
          }
        : undefined;
}

export function resolveGameCanvasRect(
    stabilized: WindowStabilization,
    screenshot: { width: number; height: number },
): CanvasResolution {
    const selectedSource: CanvasSource = "screen";
    const screen = screenBox(screenshot.width, screenshot.height);
    const candidates = [
        makeCandidate("screen", screen, screenshot.width, screenshot.height, true),
        stabilized.clientRect
            ? makeCandidate(
                  "client",
                  stabilized.clientRect,
                  screenshot.width,
                  screenshot.height,
                  false,
              )
            : undefined,
        stabilized.windowRect
            ? makeCandidate(
                  "window",
                  stabilized.windowRect,
                  screenshot.width,
                  screenshot.height,
                  false,
              )
            : undefined,
    ].filter((candidate): candidate is CanvasCandidate => Boolean(candidate));
    const selected = candidates.find((candidate) => candidate.source === selectedSource);

    return {
        gameCanvasRect: selected?.box ?? screen,
        canvasSource: selectedSource,
        canvasCandidates: candidates,
    };
}
