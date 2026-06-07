import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { RuntimeConfig } from "../config";
import type { AgentArtifactDraft } from "../protocol";
import { resolveGameCanvasRect } from "./canvas-resolver";
import { writeCandidateSheet } from "./candidate-sheet";
import { writePngCrop } from "./image-crop";
import { renderOverlay } from "./overlay-renderer";
import { resolveAttendanceRois, resolveRatioRoi } from "./roi-resolver";
import { capturePrimaryScreenPng } from "./screen-capture";
import { matchTemplateCandidates, readPng } from "./template-match";
import type {
    CalibrationCandidate,
    CalibrationResult,
    CalibrationScanBand,
    CalibrationStatus,
    PixelBox,
    RatioRoi,
    TemplateAnchor,
} from "./types";
import { stabilizeGameWindow } from "./window-controller";

const REQUIRED_ANCHOR = {
    id: "attendanceIcon",
    legacyTemplateFile: "attendance_icon.png",
    windowsTemplateFile: "attendance_icon.windows.png",
    candidateMinScore: 0.45,
    acceptanceThreshold: 0.72,
    candidateLimitPerBand: 4,
    scales: [0.75, 0.85, 0.9, 1, 1.1, 1.2, 1.35],
};

const TOP_MENU_FULL_BAND = {
    xRatio: 0,
    yRatio: 0.02,
    widthRatio: 1,
    heightRatio: 0.42,
} satisfies RatioRoi;

const RIGHT_UI_STRIP_BAND = {
    xRatio: 0.5,
    yRatio: 0,
    widthRatio: 0.5,
    heightRatio: 1,
} satisfies RatioRoi;

const FULL_GAME_COARSE_BAND = {
    xRatio: 0,
    yRatio: 0,
    widthRatio: 1,
    heightRatio: 1,
} satisfies RatioRoi;

const SCAN_BAND_DEFINITIONS = [
    {
        id: "top-menu-full",
        ratio: TOP_MENU_FULL_BAND,
        step: 3,
        artifactRole: "top-menu-band",
        fileName: "top-menu-band.png",
    },
    {
        id: "right-ui-strip",
        ratio: RIGHT_UI_STRIP_BAND,
        step: 3,
        artifactRole: "right-ui-band",
        fileName: "right-ui-band.png",
    },
    {
        id: "full-game-coarse",
        ratio: FULL_GAME_COARSE_BAND,
        step: 9,
        artifactRole: "full-game-band",
        fileName: "full-game-band.png",
    },
] as const;

function artifactPath(config: RuntimeConfig, runId: string, fileName: string) {
    return path.join(config.artifactDir, runId, fileName);
}

async function fileExists(filePath: string) {
    try {
        await access(filePath, constants.R_OK);
        return true;
    } catch {
        return false;
    }
}

async function assertReadableFile(filePath: string, reason: string) {
    try {
        await access(filePath, constants.R_OK);
    } catch {
        throw new Error(`${reason}: ${filePath}`);
    }
}

async function selectAttendanceTemplate(config: RuntimeConfig) {
    const windowsTemplatePath = path.join(
        config.templateDir,
        REQUIRED_ANCHOR.windowsTemplateFile,
    );

    if (await fileExists(windowsTemplatePath)) {
        return {
            fileName: REQUIRED_ANCHOR.windowsTemplateFile,
            path: windowsTemplatePath,
            isWindowsTemplate: true,
        };
    }

    const legacyTemplatePath = path.join(
        config.templateDir,
        REQUIRED_ANCHOR.legacyTemplateFile,
    );
    await assertReadableFile(legacyTemplatePath, "template missing");

    return {
        fileName: REQUIRED_ANCHOR.legacyTemplateFile,
        path: legacyTemplatePath,
        isWindowsTemplate: false,
    };
}

function metadataForCalibration(calibration: CalibrationResult) {
    return {
        screen: calibration.screen,
        windowRect: calibration.windowRect,
        clientRect: calibration.clientRect,
        gameCanvasRect: calibration.gameCanvasRect,
        previousClientRect: calibration.previousClientRect,
        selectedGameCanvasRect: calibration.selectedGameCanvasRect,
        canvasSource: calibration.canvasSource,
        canvasCandidates: calibration.canvasCandidates,
        calibrationStatus: calibration.calibrationStatus,
        scanBands: calibration.scanBands,
        candidates: calibration.candidates,
        selectedAnchor: calibration.selectedAnchor,
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

    for (const scanBand of calibration.scanBands ?? []) {
        shapes.push({ box: scanBand.box, color: scanBand.used ? "yellow" : "red" });
    }

    for (const roi of Object.values(calibration.resolvedRois)) {
        shapes.push({ box: roi, color: "yellow" });
    }

    for (const candidate of calibration.candidates ?? []) {
        shapes.push({ box: candidate.box, color: candidate.accepted ? "green" : "red" });
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

function buildScanBand(
    id: CalibrationScanBand["id"],
    baseRect: PixelBox,
    ratio: RatioRoi,
    used: boolean,
    step: number,
): CalibrationScanBand {
    return {
        id,
        box: resolveRatioRoi(baseRect, ratio),
        used,
        step,
    };
}

function getCalibrationStatus(
    candidates: CalibrationCandidate[],
    selectedCandidate: CalibrationCandidate | undefined,
    isWindowsTemplate: boolean,
): CalibrationStatus {
    if (
        selectedCandidate?.accepted &&
        selectedCandidate.score >= REQUIRED_ANCHOR.acceptanceThreshold
    ) {
        return "matched";
    }

    if (candidates.length === 0) return "not_found";

    return isWindowsTemplate ? "candidate_only" : "needs_template_confirmation";
}

function candidateFileName(rank: number) {
    return `attendance-candidate-${String(rank).padStart(2, "0")}.png`;
}

function chooseBestCandidate(candidates: CalibrationCandidate[]) {
    return candidates.reduce<CalibrationCandidate | undefined>((best, candidate) => {
        if (!best || candidate.score > best.score) return candidate;
        return best;
    }, undefined);
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

    const templateConfig = await selectAttendanceTemplate(config);

    await mkdir(path.join(config.artifactDir, runId), { recursive: true });

    const stabilized = await stabilizeGameWindow(config);
    const screenshotPath = artifactPath(config, runId, "calibration-screenshot.png");
    const overlayPath = artifactPath(config, runId, "calibration-overlay.png");
    const jsonPath = artifactPath(config, runId, "calibration.json");
    const canvasSelectionOverlayPath = artifactPath(config, runId, "canvas-selection-overlay.png");
    const canvasScreenPath = artifactPath(config, runId, "canvas-screen.png");
    const canvasClientPath = artifactPath(config, runId, "canvas-client.png");
    const canvasWindowPath = artifactPath(config, runId, "canvas-window.png");
    const attendanceIconRoiPath = artifactPath(config, runId, "attendance-icon-roi.png");
    const attendanceIconMatchPath = artifactPath(config, runId, "attendance-icon-match.png");
    const scanBandArtifacts = SCAN_BAND_DEFINITIONS.map((definition) => ({
        ...definition,
        path: artifactPath(config, runId, definition.fileName),
    }));
    const candidateSheetPath = artifactPath(config, runId, "attendance-candidate-sheet.png");

    await capturePrimaryScreenPng(screenshotPath);

    const screenshot = await readPng(screenshotPath);
    const template = await readPng(templateConfig.path);
    const canvasResolution = resolveGameCanvasRect(stabilized, screenshot);
    const gameCanvasRect = canvasResolution.gameCanvasRect;
    const resolvedRois = resolveAttendanceRois(gameCanvasRect);
    const scanBands = scanBandArtifacts.map((definition) =>
        buildScanBand(
            definition.id,
            gameCanvasRect,
            definition.ratio,
            true,
            definition.step,
        ),
    );
    const candidates: CalibrationCandidate[] = scanBands.flatMap((scanBand) =>
        matchTemplateCandidates(screenshot, template, {
            roi: scanBand.box,
            limit: REQUIRED_ANCHOR.candidateLimitPerBand,
            minScore: REQUIRED_ANCHOR.candidateMinScore,
            step: scanBand.step,
            scales: REQUIRED_ANCHOR.scales,
        }).map((candidate) => ({
            rank: 0,
            score: candidate.score,
            box: candidate.box,
            scale: candidate.scale,
            templateFile: templateConfig.fileName,
            scanBand: scanBand.id,
            accepted: false,
        })),
    );

    candidates.forEach((candidate, index) => {
        candidate.rank = index + 1;
    });

    const selectedCandidate = chooseBestCandidate(candidates);
    const accepted =
        Boolean(selectedCandidate) &&
        templateConfig.isWindowsTemplate &&
        (selectedCandidate?.score ?? 0) >= REQUIRED_ANCHOR.acceptanceThreshold;

    if (selectedCandidate) {
        selectedCandidate.accepted = accepted;
    }

    const calibrationStatus = getCalibrationStatus(
        candidates,
        selectedCandidate,
        templateConfig.isWindowsTemplate,
    );
    const attendanceIconRoi =
        scanBands.find((scanBand) => scanBand.id === selectedCandidate?.scanBand)
            ?.box ?? scanBands[0].box;
    const attendanceIconMatchBox = selectedCandidate?.box ?? attendanceIconRoi;
    const candidatePaths = candidates.map((candidate) =>
        artifactPath(config, runId, candidateFileName(candidate.rank)),
    );

    await writePngCrop(screenshot, attendanceIconRoi, attendanceIconRoiPath);
    await writePngCrop(screenshot, attendanceIconMatchBox, attendanceIconMatchPath);
    await writePngCrop(screenshot, gameCanvasRect, canvasScreenPath);

    for (const candidate of canvasResolution.canvasCandidates) {
        if (candidate.source === "client") {
            await writePngCrop(screenshot, candidate.box, canvasClientPath);
        }

        if (candidate.source === "window") {
            await writePngCrop(screenshot, candidate.box, canvasWindowPath);
        }
    }

    for (const scanBandArtifact of scanBandArtifacts) {
        const scanBand = scanBands.find((item) => item.id === scanBandArtifact.id);
        if (scanBand) {
            await writePngCrop(screenshot, scanBand.box, scanBandArtifact.path);
        }
    }

    for (const candidate of candidates) {
        await writePngCrop(
            screenshot,
            candidate.box,
            artifactPath(config, runId, candidateFileName(candidate.rank)),
        );
    }

    if (candidates.length > 0) {
        await writeCandidateSheet(screenshot, candidates, candidateSheetPath);
    }

    const anchors: TemplateAnchor[] = [
        {
            id: REQUIRED_ANCHOR.id,
            templateFile: templateConfig.fileName,
            matched: accepted,
            score: selectedCandidate?.score ?? 0,
            threshold: REQUIRED_ANCHOR.acceptanceThreshold,
            box: selectedCandidate?.box,
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
        gameCanvasRect,
        previousClientRect: stabilized.clientRect,
        selectedGameCanvasRect: gameCanvasRect,
        canvasSource: canvasResolution.canvasSource,
        canvasCandidates: canvasResolution.canvasCandidates,
        calibrationStatus,
        scanBands,
        candidates,
        selectedAnchor: selectedCandidate,
        anchors,
        resolvedRois,
    };

    const overlayShapes = buildOverlayShapes(calibrationBody);
    await renderOverlay(screenshotPath, overlayPath, overlayShapes);
    await renderOverlay(
        screenshotPath,
        canvasSelectionOverlayPath,
        canvasResolution.canvasCandidates.map((candidate) => ({
            box: candidate.box,
            color: candidate.selected
                ? "green"
                : candidate.source === "client"
                  ? "yellow"
                  : "red",
        })),
    );

    const calibration: CalibrationResult = {
        ...calibrationBody,
        artifacts: {
            screenshotPath,
            overlayPath,
            jsonPath,
            canvasSelectionOverlayPath,
            canvasScreenPath,
            canvasClientPath: canvasResolution.canvasCandidates.some(
                (candidate) => candidate.source === "client",
            )
                ? canvasClientPath
                : undefined,
            canvasWindowPath: canvasResolution.canvasCandidates.some(
                (candidate) => candidate.source === "window",
            )
                ? canvasWindowPath
                : undefined,
            topMenuBandPath: scanBandArtifacts.find(
                (artifact) => artifact.artifactRole === "top-menu-band",
            )?.path,
            topMenuFallbackBandPath: scanBandArtifacts.find(
                (artifact) => artifact.artifactRole === "full-game-band",
            )?.path,
            candidateSheetPath: candidates.length > 0 ? candidateSheetPath : undefined,
            candidatePaths,
            attendanceIconRoiPath,
            attendanceIconMatchPath,
        },
    };

    await writeFile(jsonPath, JSON.stringify(calibration, null, 2), "utf8");

    const canvasCandidateArtifacts: AgentArtifactDraft[] = [];
    for (const candidate of canvasResolution.canvasCandidates) {
        if (candidate.source === "client") {
            canvasCandidateArtifacts.push({
                kind: "screenshot",
                localPath: canvasClientPath,
                metadata: {
                    source: "windows-calibration",
                    role: "canvas-client",
                    canvasSource: candidate.source,
                    canvasCandidate: candidate,
                },
            });
        }

        if (candidate.source === "window") {
            canvasCandidateArtifacts.push({
                kind: "screenshot",
                localPath: canvasWindowPath,
                metadata: {
                    source: "windows-calibration",
                    role: "canvas-window",
                    canvasSource: candidate.source,
                    canvasCandidate: candidate,
                },
            });
        }
    }
    const scanBandDrafts: AgentArtifactDraft[] = scanBandArtifacts.flatMap(
        (scanBandArtifact) => {
            const scanBand = scanBands.find(
                (item) => item.id === scanBandArtifact.id,
            );

            return scanBand
                ? [
                      {
                          kind: "screenshot",
                          localPath: scanBandArtifact.path,
                          metadata: {
                              source: "windows-calibration",
                              role: scanBandArtifact.artifactRole,
                              scanBand,
                          },
                      },
                  ]
                : [];
        },
    );
    const candidateSheetDrafts: AgentArtifactDraft[] =
        candidates.length > 0
            ? [
                  {
                      kind: "screenshot",
                      localPath: candidateSheetPath,
                      metadata: {
                          source: "windows-calibration",
                          role: "attendance-candidate-sheet",
                          templateFile: templateConfig.fileName,
                          calibrationStatus,
                          candidateCount: candidates.length,
                      },
                  },
              ]
            : [];
    const candidateDrafts: AgentArtifactDraft[] = candidates.map((candidate) => ({
        kind: "screenshot",
        localPath: artifactPath(config, runId, candidateFileName(candidate.rank)),
        metadata: {
            source: "windows-calibration",
            role: candidateFileName(candidate.rank).replace(".png", ""),
            rank: candidate.rank,
            score: candidate.score,
            scale: candidate.scale,
            box: candidate.box,
            scanBand: candidate.scanBand,
            templateFile: candidate.templateFile,
            accepted: candidate.accepted,
            calibrationStatus,
        },
    }));
    const artifacts: AgentArtifactDraft[] = [
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
            kind: "overlay",
            localPath: canvasSelectionOverlayPath,
            metadata: {
                source: "windows-calibration",
                role: "canvas-selection-overlay",
                canvasSource: canvasResolution.canvasSource,
                canvasCandidates: canvasResolution.canvasCandidates,
            },
        },
        {
            kind: "screenshot",
            localPath: canvasScreenPath,
            metadata: {
                source: "windows-calibration",
                role: "canvas-screen",
                canvasSource: canvasResolution.canvasSource,
                canvasCandidates: canvasResolution.canvasCandidates,
            },
        },
        ...canvasCandidateArtifacts,
        ...scanBandDrafts,
        ...candidateSheetDrafts,
        ...candidateDrafts,
        {
            kind: "screenshot",
            localPath: attendanceIconRoiPath,
            metadata: {
                source: "windows-calibration",
                role: "attendance-icon-roi",
                matched: accepted,
                anchorScore: selectedCandidate?.score ?? 0,
                roi: attendanceIconRoi,
                canvasSource: canvasResolution.canvasSource,
                templateFile: templateConfig.fileName,
                calibrationStatus,
            },
        },
        {
            kind: "screenshot",
            localPath: attendanceIconMatchPath,
            metadata: {
                source: "windows-calibration",
                role: "attendance-icon-match",
                matched: accepted,
                anchorScore: selectedCandidate?.score ?? 0,
                scale: selectedCandidate?.scale,
                box: attendanceIconMatchBox,
                canvasSource: canvasResolution.canvasSource,
                templateFile: templateConfig.fileName,
                calibrationStatus,
            },
        },
    ];

    return {
        calibration,
        requiredAnchorMatched: accepted,
        requiredAnchorScore: selectedCandidate?.score ?? 0,
        artifacts,
    };
}
