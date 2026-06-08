import { writeFile } from "node:fs/promises";
import type { AgentArtifactDraft } from "../protocol";
import type { GameContentResolution } from "./game-content-resolver";
import { renderOverlay } from "./overlay-renderer";
import { readPng, type DecodedPng } from "./template-match";
import type { WindowStabilization } from "./types";
import type { GameLaunchResult } from "./game-launcher";

export type GameReadyState =
    | "MAIN_CANVAS_READY"
    | "AUTH_CHOICE_SCREEN"
    | "LOGIN_SCREEN"
    | "GAME_LOADING"
    | "UNKNOWN_BLOCKER"
    | "POPUP_OPEN";

export type GameReadyProbeResult = {
    gameState: GameReadyState;
    stateReason: string;
    confidence: number;
    texture: {
        width: number;
        height: number;
        luminanceVariance: number;
        edgeDensity: number;
        sampledPixels: number;
    };
    artifacts: AgentArtifactDraft[];
    gameReadyProbe: {
        probeVersion: "windows-game-ready-v1";
        classifier: "texture-density";
        reservedStates: GameReadyState[];
    };
};

type GameReadyProbeInput = {
    runId: string;
    capturePath: string;
    gameContentCropPath: string;
    overlayPath: string;
    stateJsonPath: string;
    gameContent: GameContentResolution;
    launch: GameLaunchResult;
    stabilized: WindowStabilization;
};

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

function measureTexture(image: DecodedPng) {
    let count = 0;
    let sum = 0;
    let sumSquared = 0;
    let edge = 0;
    let edgeCount = 0;
    const stepX = Math.max(1, Math.floor(image.width / 180));
    const stepY = Math.max(1, Math.floor(image.height / 120));

    for (let y = 0; y < image.height; y += stepY) {
        for (let x = 0; x < image.width; x += stepX) {
            const current = luminance(image, x, y);
            count += 1;
            sum += current;
            sumSquared += current * current;

            if (x + stepX < image.width) {
                edge += Math.abs(current - luminance(image, x + stepX, y));
                edgeCount += 1;
            }

            if (y + stepY < image.height) {
                edge += Math.abs(current - luminance(image, x, y + stepY));
                edgeCount += 1;
            }
        }
    }

    const mean = count > 0 ? sum / count : 0;

    return {
        width: image.width,
        height: image.height,
        luminanceVariance: Number(
            (count > 0 ? Math.max(0, sumSquared / count - mean * mean) : 0).toFixed(2),
        ),
        edgeDensity: Number((edgeCount > 0 ? edge / edgeCount : 0).toFixed(2)),
        sampledPixels: count,
    };
}

function classifyGameState(texture: ReturnType<typeof measureTexture>) {
    if (texture.width < 300 || texture.height < 300) {
        return {
            gameState: "UNKNOWN_BLOCKER" as const,
            stateReason: "gameContentRect is too small for reliable automation",
            confidence: 0.2,
        };
    }

    if (texture.luminanceVariance < 120 || texture.edgeDensity < 1.5) {
        return {
            gameState: "GAME_LOADING" as const,
            stateReason: "game content crop is low texture or near blank",
            confidence: 0.65,
        };
    }

    if (texture.luminanceVariance >= 500 && texture.edgeDensity >= 4) {
        return {
            gameState: "MAIN_CANVAS_READY" as const,
            stateReason: "game content crop has enough texture for the next automation stage",
            confidence: 0.7,
        };
    }

    return {
        gameState: "UNKNOWN_BLOCKER" as const,
        stateReason: "game content exists but does not meet main-canvas texture thresholds",
        confidence: 0.4,
    };
}

function overlayColor(gameState: GameReadyState) {
    if (gameState === "MAIN_CANVAS_READY") return "green" as const;
    if (gameState === "GAME_LOADING") return "yellow" as const;
    return "blue" as const;
}

export async function probeWindowsGameReady(
    input: GameReadyProbeInput,
): Promise<GameReadyProbeResult> {
    const cropImage = await readPng(input.gameContentCropPath);
    const texture = measureTexture(cropImage);
    const classified = classifyGameState(texture);
    const gameReadyProbe = {
        probeVersion: "windows-game-ready-v1" as const,
        classifier: "texture-density" as const,
        reservedStates: [
            "MAIN_CANVAS_READY",
            "AUTH_CHOICE_SCREEN",
            "LOGIN_SCREEN",
            "GAME_LOADING",
            "UNKNOWN_BLOCKER",
            "POPUP_OPEN",
        ] as GameReadyState[],
    };

    await renderOverlay(input.capturePath, input.overlayPath, [
        {
            box: input.gameContent.gameContentRect,
            color: overlayColor(classified.gameState),
        },
    ]);

    const body = {
        runId: input.runId,
        launchStatus: input.launch.launchStatus,
        launch: input.launch,
        gameState: classified.gameState,
        stateReason: classified.stateReason,
        confidence: classified.confidence,
        gameContentRect: input.gameContent.gameContentRect,
        gameContentResolver: input.gameContent.gameContentResolver,
        texture,
        processName: input.stabilized.processName,
        processId: input.stabilized.processId,
        hwnd: input.stabilized.hwnd,
        windowRect: input.stabilized.windowRect,
        clientRect: input.stabilized.clientRect,
        gameReadyProbe,
        generatedAt: new Date().toISOString(),
    };
    await writeFile(input.stateJsonPath, JSON.stringify(body, null, 2), "utf8");

    const commonMetadata = {
        source: "windows-game-ready-probe",
        launchStatus: input.launch.launchStatus,
        gameState: classified.gameState,
        stateReason: classified.stateReason,
        confidence: classified.confidence,
        gameContentRect: input.gameContent.gameContentRect,
        gameReadyProbe,
    };

    return {
        ...classified,
        texture,
        gameReadyProbe,
        artifacts: [
            {
                kind: "overlay",
                localPath: input.overlayPath,
                metadata: {
                    ...commonMetadata,
                    role: "game-ready-probe-overlay",
                    box: input.gameContent.gameContentRect,
                },
            },
            {
                kind: "trace",
                localPath: input.stateJsonPath,
                metadata: {
                    ...commonMetadata,
                    role: "game-ready-state-json",
                },
            },
        ],
    };
}
