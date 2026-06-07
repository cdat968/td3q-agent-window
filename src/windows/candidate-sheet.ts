import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import type { DecodedPng } from "./template-match";
import type { PixelBox } from "./types";

type CandidateSheetItem = {
    box: PixelBox;
};

function clampBox(box: PixelBox, image: DecodedPng): PixelBox {
    const x = Math.max(0, Math.min(box.x, image.width - 1));
    const y = Math.max(0, Math.min(box.y, image.height - 1));
    const width = Math.max(1, Math.min(box.width, image.width - x));
    const height = Math.max(1, Math.min(box.height, image.height - y));
    return { x, y, width, height };
}

function fill(png: PNG, color: [number, number, number, number]) {
    for (let y = 0; y < png.height; y += 1) {
        for (let x = 0; x < png.width; x += 1) {
            const offset = (y * png.width + x) * 4;
            png.data[offset] = color[0];
            png.data[offset + 1] = color[1];
            png.data[offset + 2] = color[2];
            png.data[offset + 3] = color[3];
        }
    }
}

function copyCrop(
    source: DecodedPng,
    target: PNG,
    sourceBox: PixelBox,
    targetX: number,
    targetY: number,
) {
    const cropBox = clampBox(sourceBox, source);

    for (let y = 0; y < cropBox.height; y += 1) {
        for (let x = 0; x < cropBox.width; x += 1) {
            const sourceOffset = ((cropBox.y + y) * source.width + cropBox.x + x) * 4;
            const targetOffset = ((targetY + y) * target.width + targetX + x) * 4;

            target.data[targetOffset] = source.data[sourceOffset];
            target.data[targetOffset + 1] = source.data[sourceOffset + 1];
            target.data[targetOffset + 2] = source.data[sourceOffset + 2];
            target.data[targetOffset + 3] = source.data[sourceOffset + 3];
        }
    }
}

export async function writeCandidateSheet(
    image: DecodedPng,
    items: CandidateSheetItem[],
    outputPath: string,
) {
    const boxes = items.map((item) => clampBox(item.box, image));
    const padding = 8;
    const maxWidth = Math.max(1, ...boxes.map((box) => box.width));
    const totalHeight =
        padding +
        boxes.reduce((sum, box) => sum + box.height + padding, 0);
    const sheet = new PNG({
        width: maxWidth + padding * 2,
        height: Math.max(1, totalHeight),
    });

    fill(sheet, [18, 18, 18, 255]);

    let cursorY = padding;
    for (const box of boxes) {
        copyCrop(image, sheet, box, padding, cursorY);
        cursorY += box.height + padding;
    }

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, PNG.sync.write(sheet));
    return outputPath;
}
