import type { AgentArtifactDraft } from "../protocol";
import { writePngCrop } from "./image-crop";
import { renderOverlay } from "./overlay-renderer";
import { readPng, type DecodedPng } from "./template-match";
import type { PixelBox } from "./types";

type CaptureReference = {
    source: string;
    path: string;
    bounds: PixelBox;
};

type WindowRects = {
    clientRect?: PixelBox;
    windowRect?: PixelBox;
};

type ArtifactPaths = {
    cropPath: string;
    overlayPath: string;
    gutterDebugPath: string;
};

type ColumnMetric = {
    x: number;
    variance: number;
    edge: number;
};

type RightGutterResolution = {
    status: "detected" | "no_gutter_detected";
    gutter?: PixelBox;
    debugBox: PixelBox;
    columnsScanned: number;
    lowDetailColumns: number;
    thresholds: {
        columnWidth: number;
        minGutterWidth: number;
        maxVariance: number;
        maxEdge: number;
    };
};

export type GameContentResolution = {
    gameContentRect: PixelBox;
    baseRect: PixelBox;
    excludedRects: {
        rightGutter?: PixelBox;
    };
    rightGutter: RightGutterResolution;
    gameContentResolver: {
        resolverVersion: "windows-game-content-v1";
        resolverStatus: "resolved" | "no_gutter_detected";
        baseSource: "clientRect" | "windowRect" | "capture";
        captureSource: string;
    };
    artifacts: AgentArtifactDraft[];
};

function clipBox(box: PixelBox, bounds: PixelBox): PixelBox {
    const x = Math.max(bounds.x, Math.min(box.x, bounds.x + bounds.width - 1));
    const y = Math.max(bounds.y, Math.min(box.y, bounds.y + bounds.height - 1));
    const right = Math.max(bounds.x, Math.min(box.x + box.width, bounds.x + bounds.width));
    const bottom = Math.max(bounds.y, Math.min(box.y + box.height, bounds.y + bounds.height));

    return {
        x,
        y,
        width: Math.max(1, right - x),
        height: Math.max(1, bottom - y),
    };
}

function toLocalBox(box: PixelBox, captureBounds: PixelBox): PixelBox {
    return {
        x: Math.round(box.x - captureBounds.x),
        y: Math.round(box.y - captureBounds.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
    };
}

function resolveBaseRect(
    image: DecodedPng,
    capture: CaptureReference,
    rects: WindowRects,
) {
    const imageBounds = { x: 0, y: 0, width: image.width, height: image.height };

    if (rects.clientRect) {
        return {
            source: "clientRect" as const,
            box: clipBox(toLocalBox(rects.clientRect, capture.bounds), imageBounds),
        };
    }

    if (rects.windowRect) {
        return {
            source: "windowRect" as const,
            box: clipBox(toLocalBox(rects.windowRect, capture.bounds), imageBounds),
        };
    }

    return {
        source: "capture" as const,
        box: imageBounds,
    };
}

function pixelOffset(image: DecodedPng, x: number, y: number) {
    return (y * image.width + x) * 4;
}

function luminance(image: DecodedPng, x: number, y: number) {
    const offset = pixelOffset(image, x, y);
    return (
        image.data[offset] * 0.299 +
        image.data[offset + 1] * 0.587 +
        image.data[offset + 2] * 0.114
    );
}

function measureColumn(
    image: DecodedPng,
    baseRect: PixelBox,
    x: number,
    columnWidth: number,
): ColumnMetric {
    let count = 0;
    let sum = 0;
    let sumSquared = 0;
    let edge = 0;
    let edgeCount = 0;
    const xEnd = Math.min(baseRect.x + baseRect.width, x + columnWidth);

    for (let cx = x; cx < xEnd; cx += 2) {
        for (let y = baseRect.y; y < baseRect.y + baseRect.height; y += 4) {
            const current = luminance(image, cx, y);
            count += 1;
            sum += current;
            sumSquared += current * current;

            if (cx + 1 < image.width) {
                edge += Math.abs(current - luminance(image, cx + 1, y));
                edgeCount += 1;
            }

            if (y + 1 < image.height) {
                edge += Math.abs(current - luminance(image, cx, y + 1));
                edgeCount += 1;
            }
        }
    }

    const mean = count > 0 ? sum / count : 0;

    return {
        x,
        variance: count > 0 ? Math.max(0, sumSquared / count - mean * mean) : 0,
        edge: edgeCount > 0 ? edge / edgeCount : 0,
    };
}

function isLowDetailColumn(metric: ColumnMetric) {
    return metric.variance <= 700 && metric.edge <= 3.5;
}

function resolveRightGutter(image: DecodedPng, baseRect: PixelBox): RightGutterResolution {
    const columnWidth = 12;
    const minGutterWidth = 120;
    const baseRight = baseRect.x + baseRect.width;
    let lowDetailColumns = 0;
    let columnsScanned = 0;
    let gutterStart = baseRight;

    for (let x = baseRight - columnWidth; x >= baseRect.x; x -= columnWidth) {
        const metric = measureColumn(image, baseRect, x, columnWidth);
        columnsScanned += 1;

        if (!isLowDetailColumn(metric)) break;

        lowDetailColumns += 1;
        gutterStart = x;
    }

    const gutterWidth = baseRight - gutterStart;
    const debugBox = {
        x: Math.max(baseRect.x, baseRight - Math.max(minGutterWidth, gutterWidth, 240)),
        y: baseRect.y,
        width: Math.min(baseRect.width, Math.max(minGutterWidth, gutterWidth, 240)),
        height: baseRect.height,
    };
    const thresholds = {
        columnWidth,
        minGutterWidth,
        maxVariance: 700,
        maxEdge: 3.5,
    };

    if (gutterWidth < minGutterWidth) {
        return {
            status: "no_gutter_detected",
            debugBox,
            columnsScanned,
            lowDetailColumns,
            thresholds,
        };
    }

    return {
        status: "detected",
        gutter: {
            x: gutterStart,
            y: baseRect.y,
            width: gutterWidth,
            height: baseRect.height,
        },
        debugBox,
        columnsScanned,
        lowDetailColumns,
        thresholds,
    };
}

export async function resolveWindowsGameContent(
    capture: CaptureReference,
    rects: WindowRects,
    paths: ArtifactPaths,
): Promise<GameContentResolution> {
    const image = await readPng(capture.path);
    const base = resolveBaseRect(image, capture, rects);
    const rightGutter = resolveRightGutter(image, base.box);
    const gameContentRect = rightGutter.gutter
        ? {
              x: base.box.x,
              y: base.box.y,
              width: Math.max(1, rightGutter.gutter.x - base.box.x),
              height: base.box.height,
          }
        : base.box;
    const resolverStatus = rightGutter.gutter ? "resolved" : "no_gutter_detected";

    await writePngCrop(image, gameContentRect, paths.cropPath);
    await writePngCrop(image, rightGutter.debugBox, paths.gutterDebugPath);
    await renderOverlay(capture.path, paths.overlayPath, [
        { box: base.box, color: "yellow" },
        ...(rightGutter.gutter ? [{ box: rightGutter.gutter, color: "red" as const }] : []),
        { box: gameContentRect, color: "green" },
    ]);

    const metadata = {
        source: "windows-game-content-resolver",
        captureSource: capture.source,
        gameContentRect,
        baseRect: base.box,
        baseSource: base.source,
        rightGutter,
        excludedRects: {
            rightGutter: rightGutter.gutter,
        },
        gameContentResolver: {
            resolverVersion: "windows-game-content-v1",
            resolverStatus,
            baseSource: base.source,
            captureSource: capture.source,
        } as const,
    };

    return {
        gameContentRect,
        baseRect: base.box,
        excludedRects: {
            rightGutter: rightGutter.gutter,
        },
        rightGutter,
        gameContentResolver: metadata.gameContentResolver,
        artifacts: [
            {
                kind: "screenshot",
                localPath: paths.cropPath,
                metadata: {
                    ...metadata,
                    role: "game-content-crop",
                },
            },
            {
                kind: "overlay",
                localPath: paths.overlayPath,
                metadata: {
                    ...metadata,
                    role: "game-content-overlay",
                },
            },
            {
                kind: "screenshot",
                localPath: paths.gutterDebugPath,
                metadata: {
                    ...metadata,
                    role: "game-content-gutter-debug",
                    debugBox: rightGutter.debugBox,
                },
            },
        ],
    };
}
