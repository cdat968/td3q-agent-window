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

export type CanvasSource = "screen" | "client" | "window";

export type CanvasCandidate = {
    source: CanvasSource;
    box: PixelBox;
    originalBox?: PixelBox;
    selected: boolean;
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

export type CalibrationStatus =
    | "matched"
    | "needs_template_confirmation"
    | "candidate_only"
    | "not_found";

export type CalibrationScanBand = {
    id: string;
    box: PixelBox;
    used: boolean;
    step?: number;
};

export type CalibrationCandidate = {
    rank: number;
    score: number;
    box: PixelBox;
    scale?: number;
    templateFile: string;
    scanBand: CalibrationScanBand["id"];
    accepted: boolean;
};

export type ResolvedRois = Record<string, PixelBox>;

export type CalibrationResult = {
    screen: ScreenInfo;
    windowRect?: PixelBox;
    clientRect?: PixelBox;
    gameCanvasRect: PixelBox;
    previousClientRect?: PixelBox;
    selectedGameCanvasRect?: PixelBox;
    canvasSource?: CanvasSource;
    canvasCandidates?: CanvasCandidate[];
    calibrationStatus?: CalibrationStatus;
    scanBands?: CalibrationScanBand[];
    candidates?: CalibrationCandidate[];
    selectedAnchor?: CalibrationCandidate;
    anchors: TemplateAnchor[];
    resolvedRois: ResolvedRois;
    artifacts: {
        screenshotPath: string;
        overlayPath: string;
        jsonPath: string;
        canvasSelectionOverlayPath?: string;
        canvasScreenPath?: string;
        canvasClientPath?: string;
        canvasWindowPath?: string;
        topMenuBandPath?: string;
        topMenuFallbackBandPath?: string;
        candidateSheetPath?: string;
        candidatePaths?: string[];
        attendanceIconRoiPath?: string;
        attendanceIconMatchPath?: string;
    };
};
