export type ReadinessCheckStatus = "ok" | "warning" | "failed" | "skipped";

export type AgentPlatform = "windows" | "macos" | "linux" | "android" | "unknown";

export type AgentReadinessCheckMessage = {
    key: string;
    label: string;
    status: ReadinessCheckStatus;
    message?: string;
    checkedAt?: string;
};

export type AgentArtifactDraft = {
    kind: "screenshot" | "overlay" | "log" | "trace" | "other";
    localPath?: string;
    url?: string;
    metadata?: Record<string, unknown>;
};

export type AgentHelloMessage = {
    type: "hello";
    agentId: string;
    token: string;
    version: string;
    hostname: string;
    platform: AgentPlatform;
    runtimeTypes: string[];
    capabilities: string[];
};

export type AgentToServerMessage =
    | AgentHelloMessage
    | {
          type: "heartbeat";
          at: string;
          telemetry?: Record<string, unknown>;
      }
    | {
          type: "readiness_report";
          checks: AgentReadinessCheckMessage[];
      }
    | {
          type: "command_accepted";
          commandId: string;
      }
    | {
          type: "command_result";
          commandId: string;
          ok: boolean;
          message?: string;
          runId?: string;
          artifacts?: AgentArtifactDraft[];
          metadata?: Record<string, unknown>;
      }
    | {
          type: "run_event";
          runId?: string;
          eventType: string;
          message?: string;
          metadata?: Record<string, unknown>;
      };

export type ServerToAgentMessage =
    | {
          type: "welcome";
          sessionId: string;
      }
    | {
          type: "command";
          commandId: string;
          commandType: string;
          payload?: Record<string, unknown>;
      }
    | {
          type: "ping";
          at: string;
      };

export function encodeProtocolMessage(message: AgentToServerMessage | ServerToAgentMessage) {
    return JSON.stringify(message);
}

export function parseProtocolMessage(data: unknown): ServerToAgentMessage {
    if (typeof data === "string") {
        return JSON.parse(data) as ServerToAgentMessage;
    }

    if (Buffer.isBuffer(data)) {
        return JSON.parse(data.toString("utf8")) as ServerToAgentMessage;
    }

    if (data instanceof ArrayBuffer) {
        return JSON.parse(Buffer.from(data).toString("utf8")) as ServerToAgentMessage;
    }

    return JSON.parse(String(data)) as ServerToAgentMessage;
}
