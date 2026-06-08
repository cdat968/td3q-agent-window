import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { promisify } from "node:util";
import type { RuntimeConfig } from "../config";

const execFileAsync = promisify(execFile);

export type GameLaunchStatus = "already_running" | "launched";

export type GameLaunchResult = {
    launchStatus: GameLaunchStatus;
    processName: string;
    launchPath?: string;
    processId?: number;
    hwnd?: string;
    title?: string;
    waitedMs: number;
};

type PowerShellLaunchResult = {
    ok: boolean;
    reason?: string;
    launchStatus?: GameLaunchStatus;
    processName?: string;
    processId?: number;
    hwnd?: string;
    title?: string;
    waitedMs?: number;
};

function psString(value: string) {
    return `'${value.replace(/'/g, "''")}'`;
}

function normalizeProcessName(name: string) {
    return name.replace(/\.exe$/i, "");
}

async function pathExists(filePath: string) {
    try {
        await access(filePath, constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

function parseLaunchResult(stdout: string): PowerShellLaunchResult {
    const trimmed = stdout.trim();
    if (!trimmed) {
        throw new Error("game launch returned empty output");
    }

    return JSON.parse(trimmed) as PowerShellLaunchResult;
}

export async function ensureGameLaunched(config: RuntimeConfig): Promise<GameLaunchResult> {
    if (config.mode !== "windows") {
        throw new Error("game launcher requires AGENT_MODE=windows");
    }

    if (process.platform !== "win32") {
        throw new Error("game launcher requires Windows process.platform win32");
    }

    if (!config.gameProcessName) {
        throw new Error("launch failed: GAME_PROCESS_NAME is not configured");
    }

    const processName = normalizeProcessName(config.gameProcessName);
    const launchPath = config.gameLaunchPath;
    if (launchPath && !(await pathExists(launchPath))) {
        throw new Error(`launch failed: GAME_LAUNCH_PATH does not exist: ${launchPath}`);
    }

    const script = `
$ErrorActionPreference = 'Stop'
$processName = ${psString(processName)}
$launchPath = ${launchPath ? psString(launchPath) : "$null"}
$timeoutMs = ${config.gameLaunchTimeoutMs}
$startedAt = Get-Date
$launchStatus = 'already_running'
function Get-GameProcess() {
  $items = @(Get-Process -Name $processName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
  if ($items.Count -gt 0) {
    return $items | Select-Object -First 1
  }
  return $null
}
function Get-AnyGameProcess() {
  $items = @(Get-Process -Name $processName -ErrorAction SilentlyContinue)
  if ($items.Count -gt 0) {
    return $items | Select-Object -First 1
  }
  return $null
}
$proc = Get-GameProcess
if ($null -eq $proc -and $null -eq (Get-AnyGameProcess)) {
  if ($null -eq $launchPath -or $launchPath -eq '') {
    @{ ok = $false; reason = 'process not found and GAME_LAUNCH_PATH is not configured'; processName = $processName } | ConvertTo-Json -Compress
    exit 0
  }
  try {
    Start-Process -FilePath $launchPath | Out-Null
    $launchStatus = 'launched'
  } catch {
    @{ ok = $false; reason = ('launch failed: ' + $_.Exception.Message); processName = $processName } | ConvertTo-Json -Compress
    exit 0
  }
}
$deadline = (Get-Date).AddMilliseconds($timeoutMs)
while ((Get-Date) -lt $deadline) {
  $proc = Get-GameProcess
  if ($null -ne $proc) {
    $waitedMs = [int]((Get-Date) - $startedAt).TotalMilliseconds
    @{
      ok = $true
      launchStatus = $launchStatus
      processName = $proc.ProcessName
      processId = $proc.Id
      hwnd = $proc.MainWindowHandle.ToString()
      title = $proc.MainWindowTitle
      waitedMs = $waitedMs
    } | ConvertTo-Json -Compress
    exit 0
  }
  Start-Sleep -Milliseconds 500
}
@{
  ok = $false
  reason = 'window handle not found before GAME_LAUNCH_TIMEOUT_MS'
  launchStatus = $launchStatus
  processName = $processName
  waitedMs = [int]((Get-Date) - $startedAt).TotalMilliseconds
} | ConvertTo-Json -Compress
`;

    const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ]);
    const result = parseLaunchResult(stdout);

    if (!result.ok || !result.launchStatus || !result.processName) {
        throw new Error(result.reason ?? "launch failed");
    }

    return {
        launchStatus: result.launchStatus,
        processName: result.processName,
        launchPath,
        processId: result.processId,
        hwnd: result.hwnd,
        title: result.title,
        waitedMs: result.waitedMs ?? 0,
    };
}
