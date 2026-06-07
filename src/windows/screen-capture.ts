import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { PixelBox } from "./types";

const execFileAsync = promisify(execFile);

export type CaptureBounds = PixelBox;

export type CaptureDpiResult = {
    dpiAwarenessAttempted: boolean;
    dpiAwarenessOk: boolean;
    dpiAwarenessMethod?: string;
    dpiAwarenessError?: string;
};

const DPI_AWARENESS_POWERSHELL = `
$dpiAttempted = $true
$dpiOk = $false
$dpiMethod = $null
$dpiError = $null
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
  try {
    $dpiOk = [DpiAwarenessApi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
    if ($dpiOk) { $dpiMethod = "per-monitor-v2" }
  } catch {}
  if (-not $dpiOk) {
    try {
      $dpiResult = [DpiAwarenessApi]::SetProcessDpiAwareness(2)
      $dpiOk = ($dpiResult -eq 0 -or $dpiResult -eq -2147024891)
      if ($dpiOk) { $dpiMethod = "per-monitor" }
    } catch {}
  }
  if (-not $dpiOk) {
    $dpiOk = [DpiAwarenessApi]::SetProcessDPIAware()
    if ($dpiOk) { $dpiMethod = "system" }
  }
} catch {
  $dpiError = $_.Exception.Message
}
`;

function psString(value: string) {
    return `'${value.replace(/'/g, "''")}'`;
}

function psBox(box: CaptureBounds) {
    return `@{ x = ${box.x}; y = ${box.y}; width = ${box.width}; height = ${box.height} }`;
}

function parseCaptureResult(stdout: string): CaptureDpiResult {
    const trimmed = stdout.trim();
    if (!trimmed) {
        return {
            dpiAwarenessAttempted: true,
            dpiAwarenessOk: false,
            dpiAwarenessError: "capture returned empty metadata",
        };
    }

    return JSON.parse(trimmed) as CaptureDpiResult;
}

export async function capturePrimaryScreenPng(outputPath: string): Promise<string> {
    await mkdir(path.dirname(outputPath), { recursive: true });

    const script = `
$ErrorActionPreference = 'Stop'
${DPI_AWARENESS_POWERSHELL}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bitmap.Save(${psString(outputPath)}, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
`;

    await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ]);

    return outputPath;
}

export async function captureScreenBoundsPng(
    outputPath: string,
    bounds: CaptureBounds,
): Promise<CaptureDpiResult> {
    await mkdir(path.dirname(outputPath), { recursive: true });

    const script = `
$ErrorActionPreference = 'Stop'
${DPI_AWARENESS_POWERSHELL}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = ${psBox(bounds)}
$bitmap = New-Object System.Drawing.Bitmap ([int]$bounds.width), ([int]$bounds.height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen([int]$bounds.x, [int]$bounds.y, 0, 0, $bitmap.Size)
$bitmap.Save(${psString(outputPath)}, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
@{
  dpiAwarenessAttempted = $dpiAttempted
  dpiAwarenessOk = $dpiOk
  dpiAwarenessMethod = $dpiMethod
  dpiAwarenessError = $dpiError
} | ConvertTo-Json -Compress
`;

    const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ]);

    return parseCaptureResult(stdout);
}

export async function getPrimaryAndVirtualScreenBounds(): Promise<{
    primary: PixelBox;
    virtual: PixelBox;
}> {
    const script = `
$ErrorActionPreference = 'Stop'
${DPI_AWARENESS_POWERSHELL}
Add-Type -AssemblyName System.Windows.Forms
function ToBox($bounds) {
  return @{
    x = [int]$bounds.X
    y = [int]$bounds.Y
    width = [int]$bounds.Width
    height = [int]$bounds.Height
  }
}
@{
  primary = ToBox ([System.Windows.Forms.Screen]::PrimaryScreen.Bounds)
  virtual = ToBox ([System.Windows.Forms.SystemInformation]::VirtualScreen)
} | ConvertTo-Json -Compress -Depth 4
`;

    const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ]);

    return JSON.parse(stdout.trim()) as {
        primary: PixelBox;
        virtual: PixelBox;
    };
}

export function fullScreenBox(width: number, height: number): PixelBox {
    return { x: 0, y: 0, width, height };
}
