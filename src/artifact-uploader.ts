import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfig } from "./config";
import type { AgentArtifactDraft } from "./protocol";

function mimeTypeFor(filePath: string) {
    const extension = path.extname(filePath).toLowerCase();

    if (extension === ".png") return "image/png";
    if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
    if (extension === ".json") return "application/json";
    if (extension === ".txt" || extension === ".log") return "text/plain";

    return "application/octet-stream";
}

function roleForArtifact(artifact: AgentArtifactDraft) {
    const role = artifact.metadata?.role;
    if (typeof role === "string" && role.trim()) return role;
    return artifact.kind;
}

async function uploadArtifact(
    config: RuntimeConfig,
    runId: string,
    artifact: AgentArtifactDraft,
): Promise<AgentArtifactDraft> {
    if (!config.backendHttpUrl || !artifact.localPath) return artifact;

    try {
        const buffer = await readFile(artifact.localPath);
        const formData = new FormData();
        const role = roleForArtifact(artifact);

        formData.set("agentId", config.agentId);
        formData.set("runId", runId);
        formData.set("kind", artifact.kind);
        formData.set("role", role);
        formData.set("localPath", artifact.localPath);
        formData.set(
            "metadata",
            JSON.stringify({
                ...(artifact.metadata ?? {}),
                agentId: config.agentId,
                runId,
                role,
            }),
        );
        formData.set(
            "file",
            new Blob([new Uint8Array(buffer)], { type: mimeTypeFor(artifact.localPath) }),
            path.basename(artifact.localPath),
        );

        const response = await fetch(
            `${config.backendHttpUrl.replace(/\/$/, "")}/api/agent-artifacts/upload`,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${config.token}`,
                },
                body: formData,
            },
        );

        if (!response.ok) {
            const error = (await response.json().catch(() => null)) as { error?: string } | null;
            throw new Error(error?.error ?? `Artifact upload returned ${response.status}`);
        }

        const body = (await response.json()) as { artifact?: AgentArtifactDraft };

        return body.artifact
            ? {
                  ...artifact,
                  ...body.artifact,
                  metadata: {
                      ...(artifact.metadata ?? {}),
                      ...(body.artifact.metadata ?? {}),
                  },
              }
            : artifact;
    } catch (error) {
        return {
            ...artifact,
            metadata: {
                ...(artifact.metadata ?? {}),
                uploadStatus: "failed",
                uploadError: error instanceof Error ? error.message : String(error),
            },
        };
    }
}

export async function uploadArtifacts(
    config: RuntimeConfig,
    runId: string,
    artifacts: AgentArtifactDraft[],
) {
    const uploaded: AgentArtifactDraft[] = [];

    for (const artifact of artifacts) {
        uploaded.push(await uploadArtifact(config, runId, artifact));
    }

    return uploaded;
}
