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

export type TemplateMatchCandidate = {
    rank: number;
    score: number;
    box: PixelBox;
    scale?: number;
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

function resizeNearest(image: DecodedPng, scale: number): DecodedPng {
    if (scale === 1) return image;

    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const data = Buffer.alloc(width * height * 4);

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const sourceX = Math.min(image.width - 1, Math.floor(x / scale));
            const sourceY = Math.min(image.height - 1, Math.floor(y / scale));
            const sourceOffset = pixelOffset(image, sourceX, sourceY);
            const targetOffset = (y * width + x) * 4;

            data[targetOffset] = image.data[sourceOffset];
            data[targetOffset + 1] = image.data[sourceOffset + 1];
            data[targetOffset + 2] = image.data[sourceOffset + 2];
            data[targetOffset + 3] = image.data[sourceOffset + 3];
        }
    }

    return { width, height, data };
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

function intersectionOverUnion(a: PixelBox, b: PixelBox) {
    const left = Math.max(a.x, b.x);
    const top = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    const intersection = width * height;
    const union = a.width * a.height + b.width * b.height - intersection;

    return union === 0 ? 0 : intersection / union;
}

export function matchTemplateCandidates(
    image: DecodedPng,
    template: DecodedPng,
    options: {
        roi: PixelBox;
        limit: number;
        minScore?: number;
        step?: number;
        overlapThreshold?: number;
        scales?: number[];
    },
): TemplateMatchCandidate[] {
    const roi = clampRoi(options.roi, image);
    const step = options.step ?? 3;
    const minScore = options.minScore ?? 0;
    const overlapThreshold = options.overlapThreshold ?? 0.35;
    const scales = options.scales ?? [1];
    const rawCandidates: Array<{ score: number; box: PixelBox; scale: number }> = [];

    for (const scale of scales) {
        const scaledTemplate = resizeNearest(template, scale);
        const maxX = roi.x + roi.width - scaledTemplate.width;
        const maxY = roi.y + roi.height - scaledTemplate.height;

        if (maxX < roi.x || maxY < roi.y) continue;

        for (let y = roi.y; y <= maxY; y += step) {
            for (let x = roi.x; x <= maxX; x += step) {
                const score = scoreAt(image, scaledTemplate, x, y);

                if (score >= minScore) {
                    rawCandidates.push({
                        score,
                        scale,
                        box: {
                            x,
                            y,
                            width: scaledTemplate.width,
                            height: scaledTemplate.height,
                        },
                    });
                }
            }
        }
    }

    if (rawCandidates.length === 0) return [];

    rawCandidates.sort((a, b) => b.score - a.score);

    const selected: TemplateMatchCandidate[] = [];

    for (const candidate of rawCandidates) {
        if (
            selected.some(
                (existing) =>
                    intersectionOverUnion(existing.box, candidate.box) >
                    overlapThreshold,
            )
        ) {
            continue;
        }

        selected.push({
            rank: selected.length + 1,
            score: Number(candidate.score.toFixed(4)),
            scale: candidate.scale,
            box: candidate.box,
        });

        if (selected.length >= options.limit) break;
    }

    return selected;
}
