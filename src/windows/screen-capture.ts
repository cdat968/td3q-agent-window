import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { PixelBox } from "./types";

const execFileAsync = promisify(execFile);

function psString(value: string) {
    return `'${value.replace(/'/g, "''")}'`;
}

export async function capturePrimaryScreenPng(outputPath: string): Promise<string> {
    await mkdir(path.dirname(outputPath), { recursive: true });

    const script = `
$ErrorActionPreference = 'Stop'
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

export function fullScreenBox(width: number, height: number): PixelBox {
    return { x: 0, y: 0, width, height };
}
