import { readFile } from "node:fs/promises";
import { PNG } from "pngjs";
import type { PixelBox } from "./types";

export type DecodedPng = {
    width: number;
    height: number;
    data: Buffer;
};

export type TemplateMatchResult = {
    matched: boolean;
    score: number;
    box?: PixelBox;
};

export async function readPng(filePath: string): Promise<DecodedPng> {
    const raw = await readFile(filePath);
    const png = PNG.sync.read(raw);
    return {
        width: png.width,
        height: png.height,
        data: Buffer.from(png.data),
    };
}

function clampRoi(roi: PixelBox, image: DecodedPng): PixelBox {
    const x = Math.max(0, Math.min(roi.x, image.width - 1));
    const y = Math.max(0, Math.min(roi.y, image.height - 1));
    const width = Math.max(1, Math.min(roi.width, image.width - x));
    const height = Math.max(1, Math.min(roi.height, image.height - y));
    return { x, y, width, height };
}

function pixelOffset(image: DecodedPng, x: number, y: number) {
    return (y * image.width + x) * 4;
}

function scoreAt(image: DecodedPng, template: DecodedPng, x: number, y: number) {
    let total = 0;
    let compared = 0;

    for (let ty = 0; ty < template.height; ty += 1) {
        for (let tx = 0; tx < template.width; tx += 1) {
            const imageOffset = pixelOffset(image, x + tx, y + ty);
            const templateOffset = pixelOffset(template, tx, ty);
            const alpha = template.data[templateOffset + 3] / 255;

            if (alpha < 0.2) continue;

            const dr = Math.abs(image.data[imageOffset] - template.data[templateOffset]);
            const dg = Math.abs(image.data[imageOffset + 1] - template.data[templateOffset + 1]);
            const db = Math.abs(image.data[imageOffset + 2] - template.data[templateOffset + 2]);
            total += (dr + dg + db) / 765;
            compared += 1;
        }
    }

    if (compared === 0) return 0;
    return 1 - total / compared;
}

export function matchTemplate(
    image: DecodedPng,
    template: DecodedPng,
    options: {
        roi: PixelBox;
        threshold: number;
        step?: number;
    },
): TemplateMatchResult {
    const roi = clampRoi(options.roi, image);
    const step = options.step ?? 3;
    const maxX = roi.x + roi.width - template.width;
    const maxY = roi.y + roi.height - template.height;

    if (maxX < roi.x || maxY < roi.y) {
        return { matched: false, score: 0 };
    }

    let bestScore = -1;
    let bestBox: PixelBox | undefined;

    for (let y = roi.y; y <= maxY; y += step) {
        for (let x = roi.x; x <= maxX; x += step) {
            const score = scoreAt(image, template, x, y);

            if (score > bestScore) {
                bestScore = score;
                bestBox = {
                    x,
                    y,
                    width: template.width,
                    height: template.height,
                };
            }
        }
    }

    return {
        matched: bestScore >= options.threshold,
        score: Number(Math.max(0, bestScore).toFixed(4)),
        box: bestBox,
    };
}
