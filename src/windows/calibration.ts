import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { RuntimeConfig } from "../config";
import type { AgentArtifactDraft } from "../protocol";
import { writePngCrop } from "./image-crop";
import { renderOverlay } from "./overlay-renderer";
import { resolveAttendanceRois } from "./roi-resolver";
import { capturePrimaryScreenPng } from "./screen-capture";
import { matchTemplate, readPng } from "./template-match";
import type { CalibrationResult, PixelBox, TemplateAnchor } from "./types";
import { stabilizeGameWindow } from "./window-controller";

const REQUIRED_ANCHOR = {
    id: "attendanceIcon",
    templateFile: "attendance_icon.png",
    threshold: 0.68,
};

function artifactPath(config: RuntimeConfig, runId: string, fileName: string) {
    return path.join(config.artifactDir, runId, fileName);
}

async function assertReadableFile(filePath: string, reason: string) {
    try {
        await access(filePath, constants.R_OK);
    } catch {
        throw new Error(`${reason}: ${filePath}`);
    }
}

function metadataForCalibration(calibration: CalibrationResult) {
    return {
        screen: calibration.screen,
        windowRect: calibration.windowRect,
        clientRect: calibration.clientRect,
        gameCanvasRect: calibration.gameCanvasRect,
        anchors: calibration.anchors.map((anchor) => ({
            id: anchor.id,
            matched: anchor.matched,
            score: anchor.score,
            threshold: anchor.threshold,
            box: anchor.box,
            roi: anchor.roi,
        })),
    };
}

function buildOverlayShapes(calibration: Omit<CalibrationResult, "artifacts">) {
    const shapes: Array<{ box: PixelBox; color: "blue" | "green" | "red" | "yellow" }> = [
        { box: calibration.gameCanvasRect, color: "blue" },
    ];

    for (const roi of Object.values(calibration.resolvedRois)) {
        shapes.push({ box: roi, color: "yellow" });
    }

    for (const anchor of calibration.anchors) {
        if (anchor.box) {
            shapes.push({ box: anchor.box, color: anchor.matched ? "green" : "red" });
        } else if (anchor.roi) {
            shapes.push({ box: anchor.roi, color: "red" });
        }
    }

    return shapes;
}

export async function runWindowsAttendanceCalibration(
    config: RuntimeConfig,
    runId: string,
): Promise<{
    calibration: CalibrationResult;
    requiredAnchorMatched: boolean;
    requiredAnchorScore: number;
    artifacts: AgentArtifactDraft[];
}> {
    if (config.mode !== "windows") {
        throw new Error("windows calibration requires AGENT_MODE=windows");
    }

    const templatePath = path.join(config.templateDir, REQUIRED_ANCHOR.templateFile);
    await assertReadableFile(templatePath, "template missing");

    await mkdir(path.join(config.artifactDir, runId), { recursive: true });

    const stabilized = await stabilizeGameWindow(config);
    const screenshotPath = artifactPath(config, runId, "calibration-screenshot.png");
    const overlayPath = artifactPath(config, runId, "calibration-overlay.png");
    const jsonPath = artifactPath(config, runId, "calibration.json");
    const attendanceIconRoiPath = artifactPath(config, runId, "attendance-icon-roi.png");
    const attendanceIconMatchPath = artifactPath(config, runId, "attendance-icon-match.png");

    await capturePrimaryScreenPng(screenshotPath);

    const screenshot = await readPng(screenshotPath);
    const template = await readPng(templatePath);
    const resolvedRois = resolveAttendanceRois(stabilized.gameCanvasRect);
    const attendanceIconRoi = resolvedRois.attendanceIcon;

    const match = matchTemplate(screenshot, template, {
        roi: attendanceIconRoi,
        threshold: REQUIRED_ANCHOR.threshold,
        step: 3,
    });
    const attendanceIconMatchBox = match.box ?? attendanceIconRoi;

    await writePngCrop(screenshot, attendanceIconRoi, attendanceIconRoiPath);
    await writePngCrop(screenshot, attendanceIconMatchBox, attendanceIconMatchPath);

    const anchors: TemplateAnchor[] = [
        {
            id: REQUIRED_ANCHOR.id,
            templateFile: REQUIRED_ANCHOR.templateFile,
            matched: match.matched,
            score: match.score,
            threshold: REQUIRED_ANCHOR.threshold,
            box: match.box,
            roi: attendanceIconRoi,
        },
    ];

    const calibrationBody = {
        screen: {
            width: screenshot.width,
            height: screenshot.height,
            dpiScale: stabilized.screen.dpiScale,
        },
        windowRect: stabilized.windowRect,
        clientRect: stabilized.clientRect,
        gameCanvasRect: stabilized.gameCanvasRect,
        anchors,
        resolvedRois,
    };

    const overlayShapes = buildOverlayShapes(calibrationBody);
    await renderOverlay(screenshotPath, overlayPath, overlayShapes);

    const calibration: CalibrationResult = {
        ...calibrationBody,
        artifacts: {
            screenshotPath,
            overlayPath,
            jsonPath,
            attendanceIconRoiPath,
            attendanceIconMatchPath,
        },
    };

    await writeFile(jsonPath, JSON.stringify(calibration, null, 2), "utf8");

    return {
        calibration,
        requiredAnchorMatched: match.matched,
        requiredAnchorScore: match.score,
        artifacts: [
            {
                kind: "screenshot",
                localPath: screenshotPath,
                metadata: { source: "windows-calibration", role: "calibration-screenshot" },
            },
            {
                kind: "overlay",
                localPath: overlayPath,
                metadata: { source: "windows-calibration", role: "calibration-overlay" },
            },
            {
                kind: "trace",
                localPath: jsonPath,
                metadata: {
                    source: "windows-calibration",
                    role: "calibration-json",
                    calibration: metadataForCalibration(calibration),
                },
            },
            {
                kind: "screenshot",
                localPath: attendanceIconRoiPath,
                metadata: {
                    source: "windows-calibration",
                    role: "attendance-icon-roi",
                    matched: match.matched,
                    anchorScore: match.score,
                    roi: attendanceIconRoi,
                },
            },
            {
                kind: "screenshot",
                localPath: attendanceIconMatchPath,
                metadata: {
                    source: "windows-calibration",
                    role: "attendance-icon-match",
                    matched: match.matched,
                    anchorScore: match.score,
                    box: attendanceIconMatchBox,
                },
            },
        ],
    };
}
