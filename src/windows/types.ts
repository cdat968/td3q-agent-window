export type PixelBox = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type RatioRoi = {
    xRatio: number;
    yRatio: number;
    widthRatio: number;
    heightRatio: number;
};

export type ScreenInfo = {
    width: number;
    height: number;
    dpiScale?: number;
};

export type WindowStabilization = {
    processName: string;
    processId: number;
    hwnd: string;
    title: string;
    screen: ScreenInfo;
    windowRect?: PixelBox;
    clientRect?: PixelBox;
    gameCanvasRect: PixelBox;
};

export type TemplateAnchor = {
    id: string;
    templateFile: string;
    matched: boolean;
    score: number;
    threshold: number;
    box?: PixelBox;
    roi?: PixelBox;
};

export type ResolvedRois = Record<string, PixelBox>;

export type CalibrationResult = {
    screen: ScreenInfo;
    windowRect?: PixelBox;
    clientRect?: PixelBox;
    gameCanvasRect: PixelBox;
    anchors: TemplateAnchor[];
    resolvedRois: ResolvedRois;
    artifacts: {
        screenshotPath: string;
        overlayPath: string;
        jsonPath: string;
    };
};
