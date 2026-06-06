import "dotenv/config";

import process from "node:process";
import { WebSocket } from "ws";
import { buildHello, loadConfig } from "./config";
import { executeCommand } from "./command-runner";
import { collectReadiness } from "./readiness";
import {
    encodeProtocolMessage,
    parseProtocolMessage,
    type AgentToServerMessage,
    type ServerToAgentMessage,
} from "./protocol";

function log(message: string, metadata?: Record<string, unknown>) {
    if (metadata) {
        console.log(`[windows-agent] ${message}`, metadata);
        return;
    }

    console.log(`[windows-agent] ${message}`);
}

async function runDoctorOnly() {
    const config = loadConfig();
    const checks = await collectReadiness(config, false);
    console.log(JSON.stringify({ agentId: config.agentId, mode: config.mode, checks }, null, 2));

    if (checks.some((item) => item.status === "failed")) {
        process.exitCode = 1;
    }
}

async function runRuntime() {
    const config = loadConfig();
    const ws = new WebSocket(config.wsUrl);
    let connected = false;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let readinessTimer: NodeJS.Timeout | undefined;

    function send(message: AgentToServerMessage) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(encodeProtocolMessage(message));
        }
    }

    async function publishReadiness() {
        const checks = await collectReadiness(config, connected);
        send({ type: "readiness_report", checks });
    }

    function startIntervals() {
        heartbeatTimer = setInterval(() => {
            send({
                type: "heartbeat",
                at: new Date().toISOString(),
                telemetry: {
                    pid: process.pid,
                    uptimeSec: Math.round(process.uptime()),
                    mode: config.mode,
                },
            });
        }, config.heartbeatIntervalMs);

        readinessTimer = setInterval(() => {
            publishReadiness().catch((error) =>
                log("readiness publish failed", {
                    error: error instanceof Error ? error.message : String(error),
                }),
            );
        }, config.readinessIntervalMs);
    }

    ws.on("open", () => {
        send(buildHello(config));
        log(`connecting ${config.agentId} -> ${config.wsUrl}`);
    });

    ws.on("message", async (data) => {
        try {
            const message = parseProtocolMessage(data) as ServerToAgentMessage;

            if (message.type === "welcome") {
                connected = true;
                log(`registered session ${message.sessionId}`);
                startIntervals();
                await publishReadiness();
                return;
            }

            if (message.type === "ping") {
                send({ type: "heartbeat", at: new Date().toISOString(), telemetry: { pingAt: message.at } });
                return;
            }

            if (message.type === "command") {
                log(`received ${message.commandType} ${message.commandId}`);
                send({ type: "command_accepted", commandId: message.commandId });

                const result = await executeCommand(config, message, send);
                send({
                    type: "command_result",
                    commandId: message.commandId,
                    ok: result.ok,
                    message: result.message,
                    runId: result.runId,
                    artifacts: result.artifacts,
                });
            }
        } catch (error) {
            log("message handling failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });

    ws.on("close", (code, reason) => {
        connected = false;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (readinessTimer) clearInterval(readinessTimer);
        log(`closed code=${code} reason=${reason.toString() || "none"}`);
        process.exitCode = code === 1000 ? 0 : 1;
    });

    ws.on("error", (error) => {
        log("websocket error", { error: error.message });
    });

    process.on("SIGINT", () => {
        log("stopping");
        ws.close(1000, "SIGINT");
    });

    process.on("SIGTERM", () => {
        log("stopping");
        ws.close(1000, "SIGTERM");
    });
}

if (process.argv.includes("--doctor")) {
    await runDoctorOnly();
} else {
    await runRuntime();
}
