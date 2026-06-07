import type { RuntimeConfig } from "./config";
import { writeJsonArtifact } from "./artifacts";
import { uploadArtifacts } from "./artifact-uploader";
import { collectReadiness, readinessPassed } from "./readiness";
import type { AgentArtifactDraft, AgentToServerMessage, ServerToAgentMessage } from "./protocol";
import { runWindowsCaptureDiagnostic } from "./windows/capture-diagnostic";

export type SendAgentMessage = (message: AgentToServerMessage) => void;

type CommandResult = {
    ok: boolean;
    message: string;
    runId?: string;
    artifacts?: AgentArtifactDraft[];
};

function payloadString(payload: Record<string, unknown> | undefined, key: string) {
    const value = payload?.[key];
    return typeof value === "string" ? value : undefined;
}

function sendProgress(
    send: SendAgentMessage,
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

async function runStart(
    config: RuntimeConfig,
    command: Extract<ServerToAgentMessage, { type: "command" }>,
    send: SendAgentMessage,
): Promise<CommandResult> {
    const runId = payloadString(command.payload, "runId") ?? `run-${Date.now()}-${config.agentId}`;
    const scenarioId = payloadString(command.payload, "scenarioId") ?? "td3q.attendance";

    send({
        type: "run_event",
        runId,
        eventType: "run_started",
        message: `Started ${scenarioId}`,
        metadata: {
            commandId: command.commandId,
            mode: config.mode,
        },
    });

    if (config.mode === "windows" && scenarioId === "td3q.attendance") {
        try {
            const result = await runWindowsCaptureDiagnostic(config, runId, send);
            sendProgress(send, runId, 85, "artifact upload started", {
                artifactCount: result.artifacts.length,
            });
            const artifacts = await uploadArtifacts(config, runId, result.artifacts);
            sendProgress(send, runId, 95, "artifact upload completed", {
                artifactCount: artifacts.length,
                uploadedCount: artifacts.filter((artifact) => artifact.url).length,
            });

            for (const artifact of artifacts) {
                send({
                    type: "run_event",
                    runId,
                    eventType: "artifact_created",
                    message: artifact.localPath,
                    metadata: artifact.metadata,
                });
            }

            sendProgress(send, runId, 100, "capture diagnostic finished", {
                captureSource: result.captureSource,
            });
            send({
                type: "run_event",
                runId,
                eventType: "capture_diagnostic_finished",
                message: "Windows capture diagnostic completed",
                metadata: {
                    captureSource: result.captureSource,
                    captureCandidates: result.captureCandidates,
                },
            });

            return {
                ok: true,
                runId,
                message: "Windows capture diagnostic completed",
                artifacts,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            send({
                type: "run_event",
                runId,
                eventType: "capture_diagnostic_failed",
                message,
                metadata: {
                    scenarioId,
                    mode: config.mode,
                    phase: "capture-diagnostic",
                },
            });

            return {
                ok: false,
                runId,
                message,
            };
        }
    }

    const artifact = await writeJsonArtifact(config, runId, "runtime-proof", {
        agentId: config.agentId,
        commandId: command.commandId,
        scenarioId,
        mode: config.mode,
        note:
            config.mode === "windows"
                ? "Windows runtime accepted the run. Scenario-specific game automation is not implemented yet."
                : "Protocol smoke run. No desktop automation executed.",
    });

    send({
        type: "run_event",
        runId,
        eventType: "artifact_created",
        message: artifact.localPath,
        metadata: artifact.metadata,
    });

    send({
        type: "run_event",
        runId,
        eventType: "run_finished",
        message: `Finished ${scenarioId} protocol execution`,
        metadata: {
            commandId: command.commandId,
            artifactPath: artifact.localPath,
        },
    });

    return {
        ok: true,
        runId,
        message: `Completed ${scenarioId} protocol execution`,
        artifacts: [artifact],
    };
}

export async function executeCommand(
    config: RuntimeConfig,
    command: Extract<ServerToAgentMessage, { type: "command" }>,
    send: SendAgentMessage,
): Promise<CommandResult> {
    if (command.commandType === "agent.doctor") {
        const checks = await collectReadiness(config, true);
        send({ type: "readiness_report", checks });
        return {
            ok: readinessPassed(checks),
            message: readinessPassed(checks)
                ? "Doctor checks passed"
                : "Doctor checks reported failures",
        };
    }

    if (command.commandType === "run.start") {
        return runStart(config, command, send);
    }

    if (command.commandType === "run.cancel") {
        return {
            ok: true,
            message: "Run cancel acknowledged. Scenario interruption will be wired in the TD3Q runner.",
            runId: payloadString(command.payload, "runId"),
        };
    }

    if (
        command.commandType === "agent.restart" ||
        command.commandType === "scheduler.pause" ||
        command.commandType === "scheduler.resume" ||
        command.commandType === "assignment.update"
    ) {
        return {
            ok: true,
            message: `${command.commandType} acknowledged by runtime`,
        };
    }

    return {
        ok: false,
        message: `Unsupported command type: ${command.commandType}`,
        runId: payloadString(command.payload, "runId"),
    };
}
