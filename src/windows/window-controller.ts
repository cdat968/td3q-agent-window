import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RuntimeConfig } from "../config";
import type { PixelBox, WindowStabilization } from "./types";

const execFileAsync = promisify(execFile);

type PowerShellWindowResult = {
    ok: boolean;
    reason?: string;
    processName?: string;
    processId?: number;
    hwnd?: string;
    title?: string;
    screen?: {
        width: number;
        height: number;
        dpiScale?: number;
    };
    windowRect?: PixelBox;
    clientRect?: PixelBox;
};

function psString(value: string) {
    return `'${value.replace(/'/g, "''")}'`;
}

const DPI_AWARENESS_POWERSHELL = `
try {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DpiAwarenessApi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int awareness);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiFlag);
}
"@
  $dpiOk = $false
  try {
    $dpiOk = [DpiAwarenessApi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
  } catch {}
  if (-not $dpiOk) {
    try {
      $dpiResult = [DpiAwarenessApi]::SetProcessDpiAwareness(2)
      $dpiOk = ($dpiResult -eq 0 -or $dpiResult -eq -2147024891)
    } catch {}
  }
  if (-not $dpiOk) {
    [DpiAwarenessApi]::SetProcessDPIAware() | Out-Null
  }
} catch {}
`;

function normalizeProcessName(name: string) {
    return name.replace(/\.exe$/i, "");
}

function parseWindowResult(stdout: string): PowerShellWindowResult {
    const trimmed = stdout.trim();
    if (!trimmed) {
        throw new Error("window discovery returned empty output");
    }

    return JSON.parse(trimmed) as PowerShellWindowResult;
}

function chooseGameCanvasRect(result: PowerShellWindowResult): PixelBox {
    if (result.clientRect) return result.clientRect;
    if (result.windowRect) return result.windowRect;
    if (result.screen) {
        return {
            x: 0,
            y: 0,
            width: result.screen.width,
            height: result.screen.height,
        };
    }

    throw new Error("window discovery did not return screen or window bounds");
}

export async function stabilizeGameWindow(config: RuntimeConfig): Promise<WindowStabilization> {
    if (config.mode !== "windows") {
        throw new Error("window stabilization requires AGENT_MODE=windows");
    }

    if (process.platform !== "win32") {
        throw new Error("window stabilization requires Windows process.platform win32");
    }

    if (!config.gameProcessName) {
        throw new Error("process not found: GAME_PROCESS_NAME is not configured");
    }

    const processName = normalizeProcessName(config.gameProcessName);
    const script = `
$ErrorActionPreference = 'Stop'
${DPI_AWARENESS_POWERSHELL}
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32WindowApi {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public struct POINT { public int X; public int Y; }
}
"@
function ToBox($left, $top, $right, $bottom) {
  return @{ x = [int]$left; y = [int]$top; width = [int]($right - $left); height = [int]($bottom - $top) }
}
$deadline = (Get-Date).AddMilliseconds(${config.windowStabilizeTimeoutMs})
$proc = $null
while ((Get-Date) -lt $deadline) {
  $candidates = @(Get-Process -Name ${psString(processName)} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
  if ($candidates.Count -gt 0) {
    $proc = $candidates | Select-Object -First 1
    break
  }
  Start-Sleep -Milliseconds 250
}
if ($null -eq $proc) {
  @{ ok = $false; reason = 'process not found'; processName = ${psString(processName)} } | ConvertTo-Json -Compress
  exit 0
}
$hwnd = [IntPtr]$proc.MainWindowHandle
[Win32WindowApi]::ShowWindow($hwnd, 9) | Out-Null
[Win32WindowApi]::ShowWindow($hwnd, 3) | Out-Null
$focused = [Win32WindowApi]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 500
$windowRect = New-Object Win32WindowApi+RECT
$clientRect = New-Object Win32WindowApi+RECT
$clientOrigin = New-Object Win32WindowApi+POINT
$hasWindowRect = [Win32WindowApi]::GetWindowRect($hwnd, [ref]$windowRect)
$hasClientRect = [Win32WindowApi]::GetClientRect($hwnd, [ref]$clientRect)
$hasClientOrigin = [Win32WindowApi]::ClientToScreen($hwnd, [ref]$clientOrigin)
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$result = @{
  ok = $focused
  reason = $(if ($focused) { $null } else { 'focus/maximize failed' })
  processName = $proc.ProcessName
  processId = $proc.Id
  hwnd = $proc.MainWindowHandle.ToString()
  title = $proc.MainWindowTitle
  screen = @{ width = [int]$screen.Width; height = [int]$screen.Height; dpiScale = 1 }
}
if ($hasWindowRect) {
  $result.windowRect = ToBox $windowRect.Left $windowRect.Top $windowRect.Right $windowRect.Bottom
}
if ($hasClientRect -and $hasClientOrigin) {
  $result.clientRect = @{
    x = [int]$clientOrigin.X
    y = [int]$clientOrigin.Y
    width = [int]($clientRect.Right - $clientRect.Left)
    height = [int]($clientRect.Bottom - $clientRect.Top)
  }
}
$result | ConvertTo-Json -Compress -Depth 5
`;

    const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ]);
    const result = parseWindowResult(stdout);

    if (!result.ok) {
        throw new Error(result.reason ?? "focus/maximize failed");
    }

    if (!result.processName || !result.processId || !result.hwnd || !result.screen) {
        throw new Error("window handle not found");
    }

    return {
        processName: result.processName,
        processId: result.processId,
        hwnd: result.hwnd,
        title: result.title ?? "",
        screen: result.screen,
        windowRect: result.windowRect,
        clientRect: result.clientRect,
        gameCanvasRect: chooseGameCanvasRect(result),
    };
}
