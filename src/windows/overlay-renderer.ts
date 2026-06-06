import { readFile, writeFile } from "node:fs/promises";
import { PNG } from "pngjs";
import type { PixelBox } from "./types";

type OverlayShape = {
    box: PixelBox;
    color: "blue" | "green" | "red" | "yellow";
};

const COLORS: Record<OverlayShape["color"], [number, number, number, number]> = {
    blue: [37, 99, 235, 255],
    green: [22, 163, 74, 255],
    red: [220, 38, 38, 255],
    yellow: [234, 179, 8, 255],
};

function setPixel(png: PNG, x: number, y: number, color: [number, number, number, number]) {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;

    const offset = (y * png.width + x) * 4;
    png.data[offset] = color[0];
    png.data[offset + 1] = color[1];
    png.data[offset + 2] = color[2];
    png.data[offset + 3] = color[3];
}

function drawBox(png: PNG, box: PixelBox, color: [number, number, number, number]) {
    const left = Math.max(0, Math.min(box.x, png.width - 1));
    const top = Math.max(0, Math.min(box.y, png.height - 1));
    const right = Math.max(0, Math.min(box.x + box.width, png.width - 1));
    const bottom = Math.max(0, Math.min(box.y + box.height, png.height - 1));

    for (let line = 0; line < 4; line += 1) {
        for (let x = left; x <= right; x += 1) {
            setPixel(png, x, top + line, color);
            setPixel(png, x, bottom - line, color);
        }

        for (let y = top; y <= bottom; y += 1) {
            setPixel(png, left + line, y, color);
            setPixel(png, right - line, y, color);
        }
    }
}

export async function renderOverlay(
    screenshotPath: string,
    outputPath: string,
    shapes: OverlayShape[],
) {
    const raw = await readFile(screenshotPath);
    const png = PNG.sync.read(raw);

    for (const shape of shapes) {
        drawBox(png, shape.box, COLORS[shape.color]);
    }

    await writeFile(outputPath, PNG.sync.write(png));
    return outputPath;
}
