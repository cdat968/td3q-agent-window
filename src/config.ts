import os from "node:os";
import path from "node:path";
import type { AgentHelloMessage, AgentPlatform } from "./protocol";

export type AgentMode = "protocol" | "windows";

export type RuntimeConfig = {
    agentId: string;
    token: string;
    wsUrl: string;
    backendHttpUrl?: string;
    mode: AgentMode;
    version: string;
    hostname: string;
    artifactDir: string;
    templateDir: string;
    gameProcessName?: string;
    gameLaunchPath?: string;
    gameLaunchTimeoutMs: number;
    gameReadyTimeoutMs: number;
    gameReadyRetryMs: number;
    windowStabilizeMode: "api-first";
    windowStabilizeTimeoutMs: number;
    heartbeatIntervalMs: number;
    readinessIntervalMs: number;
};

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} is required.`);
    }
    return value;
}

function numberEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function detectPlatform(): AgentPlatform {
    if (process.platform === "win32") return "windows";
    if (process.platform === "darwin") return "macos";
    if (process.platform === "linux") return "linux";
    return "unknown";
}

export function loadConfig(): RuntimeConfig {
    const mode = process.env.AGENT_MODE === "windows" ? "windows" : "protocol";
    const agentId = requiredEnv("AGENT_ID");

    return {
        agentId,
        token: requiredEnv("AGENT_TOKEN"),
        wsUrl: requiredEnv("AGENT_WS_URL"),
        backendHttpUrl: process.env.AGENT_BACKEND_HTTP_URL || undefined,
        mode,
        version: process.env.AGENT_VERSION ?? "0.1.0",
        hostname: process.env.AGENT_HOSTNAME ?? os.hostname(),
        artifactDir: path.resolve(process.env.AGENT_ARTIFACT_DIR ?? `.runtime/agents/${agentId}/artifacts`),
        templateDir: path.resolve(process.env.AGENT_TEMPLATE_DIR ?? "templates"),
        gameProcessName: process.env.GAME_PROCESS_NAME || undefined,
        gameLaunchPath: process.env.GAME_LAUNCH_PATH || undefined,
        gameLaunchTimeoutMs: numberEnv("GAME_LAUNCH_TIMEOUT_MS", 60000),
        gameReadyTimeoutMs: numberEnv("GAME_READY_TIMEOUT_MS", 90000),
        gameReadyRetryMs: numberEnv("GAME_READY_RETRY_MS", 1500),
        windowStabilizeMode: "api-first",
        windowStabilizeTimeoutMs: numberEnv("WINDOW_STABILIZE_TIMEOUT_MS", 10000),
        heartbeatIntervalMs: numberEnv("HEARTBEAT_INTERVAL_MS", 5000),
        readinessIntervalMs: numberEnv("READINESS_INTERVAL_MS", 30000),
    };
}

export function buildHello(config: RuntimeConfig): AgentHelloMessage {
    const platform = config.mode === "windows" ? "windows" : detectPlatform();

    return {
        type: "hello",
        agentId: config.agentId,
        token: config.token,
        version: config.version,
        hostname: config.hostname,
        platform,
        runtimeTypes: platform === "windows" ? ["windows"] : ["browser"],
        capabilities:
            platform === "windows"
                ? [
                      "windows-desktop",
                      "visual-detection",
                      "template-matching",
                      "diagnostics-overlay",
                      "artifact-upload",
                      "websocket-control",
                  ]
                : ["browser-runtime", "artifact-upload", "websocket-control"],
    };
}
