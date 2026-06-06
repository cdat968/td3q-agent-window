import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import type { DecodedPng } from "./template-match";
import type { PixelBox } from "./types";

function clampBox(box: PixelBox, image: DecodedPng): PixelBox {
    const x = Math.max(0, Math.min(box.x, image.width - 1));
    const y = Math.max(0, Math.min(box.y, image.height - 1));
    const width = Math.max(1, Math.min(box.width, image.width - x));
    const height = Math.max(1, Math.min(box.height, image.height - y));
    return { x, y, width, height };
}

export async function writePngCrop(
    image: DecodedPng,
    box: PixelBox,
    outputPath: string,
) {
    const cropBox = clampBox(box, image);
    const png = new PNG({ width: cropBox.width, height: cropBox.height });

    for (let y = 0; y < cropBox.height; y += 1) {
        for (let x = 0; x < cropBox.width; x += 1) {
            const sourceOffset = ((cropBox.y + y) * image.width + cropBox.x + x) * 4;
            const targetOffset = (y * cropBox.width + x) * 4;

            png.data[targetOffset] = image.data[sourceOffset];
            png.data[targetOffset + 1] = image.data[sourceOffset + 1];
            png.data[targetOffset + 2] = image.data[sourceOffset + 2];
            png.data[targetOffset + 3] = image.data[sourceOffset + 3];
        }
    }

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, PNG.sync.write(png));

    return outputPath;
}
