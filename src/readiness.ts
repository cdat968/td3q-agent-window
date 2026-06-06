import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RuntimeConfig } from "./config";
import type { AgentReadinessCheckMessage, ReadinessCheckStatus } from "./protocol";

const execFileAsync = promisify(execFile);

type CheckInput = {
    key: string;
    label: string;
    status: ReadinessCheckStatus;
    message?: string;
};

function check(input: CheckInput): AgentReadinessCheckMessage {
    return {
        ...input,
        checkedAt: new Date().toISOString(),
    };
}

async function pathExists(path: string) {
    try {
        await access(path, constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function ensureArtifactDir(config: RuntimeConfig): Promise<AgentReadinessCheckMessage> {
    try {
        await mkdir(config.artifactDir, { recursive: true });
        const probePath = `${config.artifactDir}/.write-test`;
        await writeFile(probePath, new Date().toISOString(), "utf8");
        await unlink(probePath).catch(() => {});
        return check({
            key: "artifact_dir",
            label: "Artifact Directory",
            status: "ok",
            message: config.artifactDir,
        });
    } catch (error) {
        return check({
            key: "artifact_dir",
            label: "Artifact Directory",
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
        });
    }
}

async function checkTemplateAssets(config: RuntimeConfig): Promise<AgentReadinessCheckMessage> {
    const exists = await pathExists(config.templateDir);

    if (exists) {
        return check({
            key: "template_assets",
            label: "Template Assets",
            status: "ok",
            message: config.templateDir,
        });
    }

    return check({
        key: "template_assets",
        label: "Template Assets",
        status: config.mode === "windows" ? "failed" : "skipped",
        message:
            config.mode === "windows"
                ? `Missing template directory: ${config.templateDir}`
                : "Skipped in protocol mode",
    });
}

async function checkDesktopSession(config: RuntimeConfig): Promise<AgentReadinessCheckMessage> {
    if (config.mode !== "windows") {
        return check({
            key: "desktop_session",
            label: "Desktop Session",
            status: "skipped",
            message: "Skipped in protocol mode",
        });
    }

    if (process.platform !== "win32") {
        return check({
            key: "desktop_session",
            label: "Desktop Session",
            status: "failed",
            message: "Windows mode requires process.platform win32",
        });
    }

    return check({
        key: "desktop_session",
        label: "Desktop Session",
        status: process.env.SESSIONNAME ? "ok" : "warning",
        message: process.env.SESSIONNAME ?? "SESSIONNAME is not available",
    });
}

async function checkGameProcess(config: RuntimeConfig): Promise<AgentReadinessCheckMessage> {
    if (config.mode !== "windows") {
        return check({
            key: "game_process",
            label: "Game Process",
            status: "skipped",
            message: "Skipped in protocol mode",
        });
    }

    if (!config.gameProcessName) {
        return check({
            key: "game_process",
            label: "Game Process",
            status: "failed",
            message: "GAME_PROCESS_NAME is required in Windows mode",
        });
    }

    const processName = config.gameProcessName.replace(/\.exe$/i, "");

    try {
        await execFileAsync("powershell.exe", [
            "-NoProfile",
            "-Command",
            `Get-Process -Name '${processName.replace(/'/g, "''")}' -ErrorAction Stop | Select-Object -First 1`,
        ]);
        return check({
            key: "game_process",
            label: "Game Process",
            status: "ok",
            message: config.gameProcessName,
        });
    } catch {
        return check({
            key: "game_process",
            label: "Game Process",
            status: "failed",
            message: `Process not found: ${config.gameProcessName}`,
        });
    }
}

async function checkScreenCapture(config: RuntimeConfig): Promise<AgentReadinessCheckMessage> {
    if (config.mode !== "windows") {
        return check({
            key: "screen_capture",
            label: "Screen Capture",
            status: "skipped",
            message: "Skipped in protocol mode",
        });
    }

    try {
        await mkdir(config.artifactDir, { recursive: true });
        const probePath = `${config.artifactDir}/screen-capture-probe.png`;
        await execFileAsync("powershell.exe", [
            "-NoProfile",
            "-Command",
            [
                "Add-Type -AssemblyName System.Windows.Forms",
                "Add-Type -AssemblyName System.Drawing",
                "$bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
                "$bmp=New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height",
                "$graphics=[System.Drawing.Graphics]::FromImage($bmp)",
                "$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)",
                `$bmp.Save('${probePath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
                "$graphics.Dispose()",
                "$bmp.Dispose()",
            ].join("; "),
        ]);
        return check({
            key: "screen_capture",
            label: "Screen Capture",
            status: "ok",
            message: probePath,
        });
    } catch (error) {
        return check({
            key: "screen_capture",
            label: "Screen Capture",
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
        });
    }
}

async function checkInputControl(config: RuntimeConfig): Promise<AgentReadinessCheckMessage> {
    if (config.mode !== "windows") {
        return check({
            key: "input_control",
            label: "Input Control",
            status: "skipped",
            message: "Skipped in protocol mode",
        });
    }

    try {
        await execFileAsync("powershell.exe", [
            "-NoProfile",
            "-Command",
            "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('')",
        ]);
        return check({
            key: "input_control",
            label: "Input Control",
            status: "ok",
            message: "System.Windows.Forms SendKeys available",
        });
    } catch (error) {
        return check({
            key: "input_control",
            label: "Input Control",
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
        });
    }
}

export async function collectReadiness(config: RuntimeConfig, backendConnected: boolean) {
    return [
        check({
            key: "agent_token",
            label: "Agent Token",
            status: config.token ? "ok" : "failed",
            message: config.token ? "configured" : "missing",
        }),
        check({
            key: "backend_ws",
            label: "Backend WebSocket",
            status: backendConnected ? "ok" : "failed",
            message: backendConnected ? config.wsUrl : "not connected",
        }),
        await checkDesktopSession(config),
        await checkGameProcess(config),
        await checkScreenCapture(config),
        await checkInputControl(config),
        await ensureArtifactDir(config),
        await checkTemplateAssets(config),
    ];
}

export function readinessPassed(checks: AgentReadinessCheckMessage[]) {
    return !checks.some((item) => item.status === "failed");
}
