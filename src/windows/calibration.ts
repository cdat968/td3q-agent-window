import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { RuntimeConfig } from "../config";
import type { AgentArtifactDraft } from "../protocol";
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
    reviewThreshold: 0.6,
    acceptanceThreshold: 0.72,
    candidateLimit: 5,
};

const TOP_MENU_PRIMARY_BAND = {
    xRatio: 0.2,
    yRatio: 0.04,
    widthRatio: 0.76,
    heightRatio: 0.3,
} satisfies RatioRoi;

const TOP_MENU_FALLBACK_BAND = {
    xRatio: 0,
    yRatio: 0.04,
    widthRatio: 1,
    heightRatio: 0.32,
} satisfies RatioRoi;

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
): CalibrationScanBand {
    return {
        id,
        box: resolveRatioRoi(baseRect, ratio),
        used,
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
    const attendanceIconRoiPath = artifactPath(config, runId, "attendance-icon-roi.png");
    const attendanceIconMatchPath = artifactPath(config, runId, "attendance-icon-match.png");
    const topMenuBandPath = artifactPath(config, runId, "top-menu-band.png");
    const topMenuFallbackBandPath = artifactPath(config, runId, "top-menu-fallback-band.png");
    const candidateSheetPath = artifactPath(config, runId, "attendance-candidate-sheet.png");

    await capturePrimaryScreenPng(screenshotPath);

    const screenshot = await readPng(screenshotPath);
    const template = await readPng(templateConfig.path);
    const resolvedRois = resolveAttendanceRois(stabilized.gameCanvasRect);
    const primaryBand = buildScanBand(
        "top-menu-primary",
        stabilized.gameCanvasRect,
        TOP_MENU_PRIMARY_BAND,
        true,
    );
    const fallbackBand = buildScanBand(
        "top-menu-fallback",
        stabilized.gameCanvasRect,
        TOP_MENU_FALLBACK_BAND,
        false,
    );

    const primaryCandidates = matchTemplateCandidates(screenshot, template, {
        roi: primaryBand.box,
        limit: REQUIRED_ANCHOR.candidateLimit,
        minScore: REQUIRED_ANCHOR.candidateMinScore,
        step: 3,
    });
    const primaryBestScore = primaryCandidates[0]?.score ?? 0;
    const shouldUseFallback = primaryBestScore < REQUIRED_ANCHOR.reviewThreshold;
    const fallbackCandidates = shouldUseFallback
        ? matchTemplateCandidates(screenshot, template, {
              roi: fallbackBand.box,
              limit: REQUIRED_ANCHOR.candidateLimit,
              minScore: REQUIRED_ANCHOR.candidateMinScore,
              step: 3,
          })
        : [];
    const activeBand =
        fallbackCandidates[0] &&
        fallbackCandidates[0].score > primaryBestScore
            ? { ...fallbackBand, used: true }
            : primaryBand;
    const scanBands = [
        activeBand.id === primaryBand.id ? primaryBand : { ...primaryBand, used: false },
        activeBand.id === fallbackBand.id ? activeBand : fallbackBand,
    ];
    const sourceCandidates =
        activeBand.id === fallbackBand.id ? fallbackCandidates : primaryCandidates;
    const candidates: CalibrationCandidate[] = sourceCandidates
        .map((candidate, index) => ({
            rank: index + 1,
            score: candidate.score,
            box: candidate.box,
            templateFile: templateConfig.fileName,
            scanBand: activeBand.id,
            accepted: false,
        }));
    const selectedCandidate = candidates[0];
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
    const attendanceIconRoi = activeBand.box;
    const attendanceIconMatchBox = selectedCandidate?.box ?? activeBand.box;
    const candidatePaths = candidates.map((candidate) =>
        artifactPath(config, runId, candidateFileName(candidate.rank)),
    );

    await writePngCrop(screenshot, attendanceIconRoi, attendanceIconRoiPath);
    await writePngCrop(screenshot, attendanceIconMatchBox, attendanceIconMatchPath);
    await writePngCrop(screenshot, primaryBand.box, topMenuBandPath);
    await writePngCrop(screenshot, fallbackBand.box, topMenuFallbackBandPath);

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
        gameCanvasRect: stabilized.gameCanvasRect,
        calibrationStatus,
        scanBands,
        candidates,
        selectedAnchor: selectedCandidate,
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
            topMenuBandPath,
            topMenuFallbackBandPath,
            candidateSheetPath: candidates.length > 0 ? candidateSheetPath : undefined,
            candidatePaths,
            attendanceIconRoiPath,
            attendanceIconMatchPath,
        },
    };

    await writeFile(jsonPath, JSON.stringify(calibration, null, 2), "utf8");

    return {
        calibration,
        requiredAnchorMatched: accepted,
        requiredAnchorScore: selectedCandidate?.score ?? 0,
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
                localPath: topMenuBandPath,
                metadata: {
                    source: "windows-calibration",
                    role: "top-menu-band",
                    scanBand: primaryBand,
                },
            },
            {
                kind: "screenshot",
                localPath: topMenuFallbackBandPath,
                metadata: {
                    source: "windows-calibration",
                    role: "top-menu-fallback-band",
                    scanBand: fallbackBand,
                },
            },
            ...(candidates.length > 0
                ? [
                      {
                          kind: "screenshot" as const,
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
                : []),
            ...candidates.map((candidate) => ({
                kind: "screenshot" as const,
                localPath: artifactPath(config, runId, candidateFileName(candidate.rank)),
                metadata: {
                    source: "windows-calibration",
                    role: candidateFileName(candidate.rank).replace(".png", ""),
                    rank: candidate.rank,
                    score: candidate.score,
                    box: candidate.box,
                    scanBand: candidate.scanBand,
                    templateFile: candidate.templateFile,
                    accepted: candidate.accepted,
                    calibrationStatus,
                },
            })),
            {
                kind: "screenshot",
                localPath: attendanceIconRoiPath,
                metadata: {
                    source: "windows-calibration",
                    role: "attendance-icon-roi",
                    matched: accepted,
                    anchorScore: selectedCandidate?.score ?? 0,
                    roi: attendanceIconRoi,
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
                    box: attendanceIconMatchBox,
                    templateFile: templateConfig.fileName,
                    calibrationStatus,
                },
            },
        ],
    };
}
