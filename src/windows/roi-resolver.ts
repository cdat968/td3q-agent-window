import type { PixelBox, RatioRoi, ResolvedRois } from "./types";

export const ATTENDANCE_WINDOWS_ROIS = {
    attendanceIcon: {
        xRatio: 0.68,
        yRatio: 0.08,
        widthRatio: 0.22,
        heightRatio: 0.22,
    },
    popupHeader: {
        xRatio: 0.44,
        yRatio: 0.12,
        widthRatio: 0.32,
        heightRatio: 0.14,
    },
    popupCloseButton: {
        xRatio: 0.65,
        yRatio: 0.02,
        widthRatio: 0.3,
        heightRatio: 0.25,
    },
    dailyRewardPopup: {
        xRatio: 0.43,
        yRatio: 0.33,
        widthRatio: 0.15,
        heightRatio: 0.1,
    },
    dailyRewardCloseButton: {
        xRatio: 0.63,
        yRatio: 0.28,
        widthRatio: 0.08,
        heightRatio: 0.15,
    },
    milestoneBar: {
        xRatio: 0.362,
        yRatio: 0.857,
        widthRatio: 0.448,
        heightRatio: 0.11,
    },
} satisfies Record<string, RatioRoi>;

export function clampBox(box: PixelBox, bounds: PixelBox): PixelBox {
    const x = Math.max(bounds.x, Math.min(box.x, bounds.x + bounds.width - 1));
    const y = Math.max(bounds.y, Math.min(box.y, bounds.y + bounds.height - 1));
    const width = Math.max(1, Math.min(box.width, bounds.x + bounds.width - x));
    const height = Math.max(1, Math.min(box.height, bounds.y + bounds.height - y));

    return { x, y, width, height };
}

export function resolveRatioRoi(baseRect: PixelBox, roi: RatioRoi): PixelBox {
    return clampBox(
        {
            x: Math.round(baseRect.x + baseRect.width * roi.xRatio),
            y: Math.round(baseRect.y + baseRect.height * roi.yRatio),
            width: Math.max(1, Math.round(baseRect.width * roi.widthRatio)),
            height: Math.max(1, Math.round(baseRect.height * roi.heightRatio)),
        },
        baseRect,
    );
}

export function resolveAttendanceRois(gameCanvasRect: PixelBox): ResolvedRois {
    return Object.fromEntries(
        Object.entries(ATTENDANCE_WINDOWS_ROIS).map(([name, roi]) => [
            name,
            resolveRatioRoi(gameCanvasRect, roi),
        ]),
    );
}
