import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfig } from "./config";
import type { AgentArtifactDraft } from "./protocol";

export async function writeJsonArtifact(
    config: RuntimeConfig,
    runId: string | undefined,
    name: string,
    payload: Record<string, unknown>,
): Promise<AgentArtifactDraft> {
    await mkdir(config.artifactDir, { recursive: true });

    const safeRunId = runId ?? "command";
    const filePath = path.join(config.artifactDir, `${safeRunId}-${name}.json`);

    await writeFile(
        filePath,
        JSON.stringify(
            {
                ...payload,
                createdAt: new Date().toISOString(),
            },
            null,
            2,
        ),
        "utf8",
    );

    return {
        kind: "trace",
        localPath: filePath,
        metadata: {
            name,
            source: "windows-agent-runtime",
        },
    };
}
