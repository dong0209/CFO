import { useCallback, useEffect, useRef, useState } from "react";
import type { RGB } from "../engine/types";
import "./imageEditor.css";
import {
  type EditorFontChoice,
  type EditorHost,
  type EditorObject,
  type EditorResult,
  type EditorTextObject,
  hexToRgb,
  isLine,
  rgbCss,
  rgbToHex,
  TEXT_ASCENT,
  TEXT_LINE_HEIGHT,
  transformObject,
} from "./model";
import { adjust, clampRect, inpaint, looksPhotographic, paperColor, type PixelRect } from "./raster";

export interface EditorPage {
  png: Uint8Array;
  /** 頁面大小（點） */
  width: number;
  height: number;
}

type Tool = "select" | "marquee" | "brush" | "eraser" | "heal" | "text" | "rect" | "ellipse" | "line" | "arrow" | "crop" | "eyedropper";

const TOOLS: Array<{ id: Tool; label: string; key: string; icon: string }> = [
  { id: "select", label: "選取／移動物件", key: "V", icon: "M5 3l14 9-6 1-3 6z" },
  { id: "marquee", label: "框選區域（搬移、複製、刪除）", key: "M", icon: "M4 4h4M12 4h4M20 4v4M20 12v4M20 20h-4M12 20H8M4 20v-4M4 12V8" },
  { id: "brush", label: "筆刷", key: "B", icon: "M4 20c3 0 5-2 5-4s2-3 3-3l8-8-2-2-8 8c0 1-1 3-3 3s-4 2-4 6z" },
  { id: "eraser", label: "橡皮擦（塗上背景色）", key: "E", icon: "M4 16l9-9 7 7-6 6H8zM10 20h10" },
  { id: "heal", label: "修補（以周圍顏色填補）", key: "J", icon: "M7 17l10-10M9 7l8 8M4 12a8 8 0 0116 0 8 8 0 01-16 0" },
  { id: "text", label: "文字", key: "T", icon: "M5 5h14M12 5v14M9 19h6" },
  { id: "rect", label: "矩形", key: "R", icon: "M4 6h16v12H4z" },
  { id: "ellipse", label: "橢圓", key: "O", icon: "M12 5c5 0 8 3 8 7s-3 7-8 7-8-3-8-7 3-7 8-7z" },
  { id: "line", label: "直線", key: "L", icon: "M5 19L19 5" },
  { id: "arrow", label: "箭頭", key: "A", icon: "M5 19L19 5M11 5h8v8" },
  { id: "crop", label: "裁切頁面", key: "C", icon: "M6 2v16h16M2 6h16v16" },
  { id: "eyedropper", label: "吸管（取色）", key: "I", icon: "M19 5l-3-3-4 4-1-1-2 2 1 1-7 7v3h3l7-7 1 1 2-2-1-1z" },
];

type HistoryEntry =
  | { kind: "raster"; rect: PixelRect; before: ImageData; after: ImageData }
  | { kind: "canvas"; before: CanvasState; after: CanvasState }
  | { kind: "objects"; before: EditorObject[]; after: EditorObject[] };

interface CanvasState {
  image: ImageData;
  width: number;
  height: number;
  objects: EditorObject[];
}

interface Floating {
  /** 浮動選取的像素 */
  canvas: HTMLCanvasElement;
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 拿起前的整張影像（用來復原與記錄） */
  before: ImageData;
  /** 原本所在的位置（像素） */
  from: PixelRect;
}

type Drag =
  | { kind: "stroke"; tool: "brush" | "eraser" | "heal"; points: Array<[number, number]> }
  | { kind: "rect"; tool: "marquee" | "crop" | "rect" | "ellipse" | "line" | "arrow"; start: [number, number]; current: [number, number] }
  | { kind: "move"; start: [number, number]; before: EditorObject[]; origin: EditorObject }
  | { kind: "resize"; corner: [number, number]; before: EditorObject[]; origin: EditorObject }
  | { kind: "rotate"; before: EditorObject[]; origin: EditorObject }
  | { kind: "endpoint"; end: 1 | 2; before: EditorObject[]; origin: EditorObject }
  | { kind: "floating"; start: [number, number]; origin: { x: number; y: number } }
  | { kind: "floatingResize"; origin: { x: number; y: number; w: number; h: number } };

let nextObjectId = 1;

function fontStack(cssFamily: string | null | undefined, choice: EditorFontChoice): string {
  const fallback = '"Microsoft JhengHei", "PingFang TC", "Noto Sans TC", sans-serif';
  return cssFamily ? `"${cssFamily}", ${fallback}` : `"${choice.family}", ${fallback}`;
}

function choiceKey(choice: EditorFontChoice, bold: boolean, italic: boolean) {
  return `${choice.kind}:${choice.family}:${bold ? 1 : 0}${italic ? 1 : 0}`;
}

/** 將頁面當作圖片編輯：像素工具（筆刷、橡皮擦、修補、框選搬移）、物件圖層（文字、圖形、圖片）與整頁調整。 */
export function ImageEditor({ page, host, title, onDone }: { page: EditorPage; host: EditorHost; title?: string; onDone: (result: EditorResult | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [pageSize, setPageSize] = useState({ w: page.width, h: page.height });
  const [view, setView] = useState(1);
  const [tool, setToolState] = useState<Tool>("select");
  const [objects, setObjects] = useState<EditorObject[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selection, setSelection] = useState<[number, number, number, number] | null>(null);
  const [floating, setFloating] = useState<Floating | null>(null);
  const [cropRect, setCropRect] = useState<[number, number, number, number] | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const undoStack = useRef<HistoryEntry[]>([]);
  const redoStack = useRef<HistoryEntry[]>([]);
  const clipboard = useRef<HTMLCanvasElement | null>(null);

  // 工具設定
  const [brushColor, setBrushColor] = useState("#e03131");
  const [brushSize, setBrushSize] = useState(6);
  const [brushOpacity, setBrushOpacity] = useState(1);
  const [paper, setPaper] = useState("#ffffff");
  const [strokeColor, setStrokeColor] = useState("#e03131");
  const [fillColor, setFillColor] = useState<string | null>(null);
  const [strokeWidth, setStrokeWidth] = useState(2);
  const [textColor, setTextColor] = useState("#000000");
  const [textSize, setTextSize] = useState(18);
  const [fonts, setFonts] = useState<{ families: Array<{ family: string; label: string }>; downloadable: string[]; defaultChoice: EditorFontChoice } | null>(null);
  const [fontCss, setFontCss] = useState<Record<string, string | null>>({});
  const [lastChoice, setLastChoice] = useState<EditorFontChoice | null>(null);
  // 整頁調整
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [grayscale, setGrayscale] = useState(false);
  const [deskew, setDeskew] = useState(0);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const selected = objects.find((o) => o.id === selectedId) ?? null;
  const k = () => (canvasRef.current ? canvasRef.current.width / pageSize.w : 1);
  const ctx = () => canvasRef.current!.getContext("2d", { willReadFrequently: true })!;
  const canUndo = undoStack.current.length > 0 || floating !== null;
  const canRedo = redoStack.current.length > 0;
  const pixelsChanged = undoStack.current.some((e) => e.kind !== "objects") || floating !== null;
  void historyVersion;

  // MARK: 載入

  useEffect(() => {
    let cancelled = false;
    const url = URL.createObjectURL(new Blob([page.png as BlobPart], { type: "image/png" }));
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const canvas = canvasRef.current!;
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const c = canvas.getContext("2d", { willReadFrequently: true })!;
      c.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      const sample = c.getImageData(0, 0, canvas.width, canvas.height);
      setPaper(rgbToHex(paperColor(sample).map((v) => v / 255) as RGB));
      setLoaded(true);
      fitToStage();
    };
    img.src = url;
    host
      .listFonts()
      .then((list) => !cancelled && setFonts(list))
      .catch(() => setFonts({ families: [], downloadable: [], defaultChoice: { kind: "system", family: "sans-serif" } }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const fitToStage = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const scale = Math.min((stage.clientWidth - 48) / pageSize.w, (stage.clientHeight - 48) / pageSize.h);
    setView(Math.max(0.1, Math.min(4, scale)));
  }, [pageSize]);

  // 文字物件的預覽字型
  const ensureFont = useCallback(
    (choice: EditorFontChoice, bold: boolean, italic: boolean) => {
      const key = choiceKey(choice, bold, italic);
      if (key in fontCss) return;
      setFontCss((map) => ({ ...map, [key]: null }));
      host
        .previewFont(choice, bold, italic)
        .then((css) => setFontCss((map) => ({ ...map, [key]: css })))
        .catch(() => {});
    },
    [fontCss, host],
  );

  // MARK: 歷史紀錄

  const pushHistory = (entry: HistoryEntry) => {
    undoStack.current.push(entry);
    if (undoStack.current.length > 40) undoStack.current.shift();
    redoStack.current = [];
    setHistoryVersion((v) => v + 1);
  };

  const snapshot = (): ImageData => ctx().getImageData(0, 0, canvasRef.current!.width, canvasRef.current!.height);

  /** 像素修改：只保留受影響範圍前後的像素。 */
  const recordRaster = (before: ImageData, rect: PixelRect) => {
    const canvas = canvasRef.current!;
    const [x0, y0, x1, y1] = clampRect(rect, canvas.width, canvas.height);
    if (x1 <= x0 || y1 <= y0) return;
    const region = new ImageData(x1 - x0, y1 - y0);
    for (let y = y0; y < y1; y++) {
      region.data.set(before.data.subarray((y * before.width + x0) * 4, (y * before.width + x1) * 4), (y - y0) * (x1 - x0) * 4);
    }
    pushHistory({ kind: "raster", rect: [x0, y0, x1, y1], before: region, after: ctx().getImageData(x0, y0, x1 - x0, y1 - y0) });
  };

  const canvasState = (): CanvasState => ({ image: snapshot(), width: pageSize.w, height: pageSize.h, objects });

  const restoreCanvas = (state: CanvasState) => {
    const canvas = canvasRef.current!;
    canvas.width = state.image.width;
    canvas.height = state.image.height;
    ctx().putImageData(state.image, 0, 0);
    setPageSize({ w: state.width, h: state.height });
    setObjects(state.objects);
  };

  const commitObjects = (next: EditorObject[], before: EditorObject[] = objects) => {
    setObjects(next);
    if (JSON.stringify(stripUrls(before)) !== JSON.stringify(stripUrls(next))) pushHistory({ kind: "objects", before, after: next });
  };

  const undo = () => {
    if (floating) {
      cancelFloating();
      return;
    }
    const entry = undoStack.current.pop();
    if (!entry) return;
    redoStack.current.push(entry);
    applyEntry(entry, "before");
    setHistoryVersion((v) => v + 1);
  };

  const redo = () => {
    const entry = redoStack.current.pop();
    if (!entry) return;
    undoStack.current.push(entry);
    applyEntry(entry, "after");
    setHistoryVersion((v) => v + 1);
  };

  const applyEntry = (entry: HistoryEntry, side: "before" | "after") => {
    setSelection(null);
    setCropRect(null);
    if (entry.kind === "raster") ctx().putImageData(entry[side], entry.rect[0], entry.rect[1]);
    else if (entry.kind === "canvas") restoreCanvas(entry[side]);
    else {
      setObjects(entry[side]);
      if (!entry[side].some((o) => o.id === selectedId)) setSelectedId(null);
    }
  };

  // MARK: 浮動選取（搬移、複製、貼上）

  const liftSelection = (rect: [number, number, number, number], cut: boolean): Floating | null => {
    const s = k();
    const px = clampRect([rect[0] * s, rect[1] * s, rect[2] * s, rect[3] * s], canvasRef.current!.width, canvasRef.current!.height);
    const w = px[2] - px[0];
    const h = px[3] - px[1];
    if (w < 1 || h < 1) return null;
    const before = snapshot();
    const piece = document.createElement("canvas");
    piece.width = w;
    piece.height = h;
    piece.getContext("2d")!.putImageData(ctx().getImageData(px[0], px[1], w, h), 0, 0);
    if (cut) {
      const c = ctx();
      c.fillStyle = paper;
      c.fillRect(px[0], px[1], w, h);
    }
    const f: Floating = { canvas: piece, url: piece.toDataURL(), x: px[0] / s, y: px[1] / s, w: w / s, h: h / s, before, from: px };
    setFloating(f);
    setSelection(null);
    return f;
  };

  const commitFloating = (f: Floating | null = floating) => {
    if (!f) return;
    const s = k();
    ctx().drawImage(f.canvas, f.x * s, f.y * s, f.w * s, f.h * s);
    const to: PixelRect = [f.x * s - 1, f.y * s - 1, (f.x + f.w) * s + 1, (f.y + f.h) * s + 1];
    recordRaster(f.before, [Math.min(f.from[0], to[0]), Math.min(f.from[1], to[1]), Math.max(f.from[2], to[2]), Math.max(f.from[3], to[3])]);
    setFloating(null);
    setSelection([f.x, f.y, f.x + f.w, f.y + f.h]);
  };

  const cancelFloating = () => {
    if (!floating) return;
    ctx().putImageData(floating.before, 0, 0);
    setFloating(null);
  };

  const copySelection = () => {
    const source = floating ? floating.canvas : null;
    if (source) {
      clipboard.current = cloneCanvas(source);
      return;
    }
    if (!selection) return;
    const s = k();
    const px = clampRect([selection[0] * s, selection[1] * s, selection[2] * s, selection[3] * s], canvasRef.current!.width, canvasRef.current!.height);
    const piece = document.createElement("canvas");
    piece.width = px[2] - px[0];
    piece.height = px[3] - px[1];
    if (piece.width < 1 || piece.height < 1) return;
    piece.getContext("2d")!.putImageData(ctx().getImageData(px[0], px[1], piece.width, piece.height), 0, 0);
    clipboard.current = piece;
  };

  const pasteClipboard = () => {
    const source = clipboard.current;
    if (!source) return;
    commitFloating();
    const s = k();
    const w = source.width / s;
    const h = source.height / s;
    const base = selection ?? [pageSize.w / 2 - w / 2, pageSize.h / 2 - h / 2];
    const x = Math.min(pageSize.w - w, base[0] + 12);
    const y = Math.min(pageSize.h - h, base[1] + 12);
    const piece = cloneCanvas(source);
    setFloating({ canvas: piece, url: piece.toDataURL(), x, y, w, h, before: snapshot(), from: [x * s, y * s, (x + w) * s, (y + h) * s] });
    setSelection(null);
    setTool("marquee");
  };

  const fillSelection = (mode: "paper" | "heal") => {
    const rect = floating ? null : selection;
    if (floating) {
      // 浮動選取：直接丟棄（拿起時原位置已填成背景色）
      commitFloatingDiscard();
      return;
    }
    if (!rect) return;
    const s = k();
    const canvas = canvasRef.current!;
    const px = clampRect([rect[0] * s, rect[1] * s, rect[2] * s, rect[3] * s], canvas.width, canvas.height);
    const before = snapshot();
    if (mode === "paper") {
      const c = ctx();
      c.fillStyle = paper;
      c.fillRect(px[0], px[1], px[2] - px[0], px[3] - px[1]);
    } else {
      const margin = Math.round(4 * s);
      const area = clampRect([px[0] - margin, px[1] - margin, px[2] + margin, px[3] + margin], canvas.width, canvas.height);
      const region = ctx().getImageData(area[0], area[1], area[2] - area[0], area[3] - area[1]);
      const mask = new Uint8Array(region.width * region.height);
      for (let y = px[1] - area[1]; y < px[3] - area[1]; y++) for (let x = px[0] - area[0]; x < px[2] - area[0]; x++) mask[y * region.width + x] = 1;
      inpaint({ width: region.width, height: region.height, data: region.data }, mask);
      ctx().putImageData(region, area[0], area[1]);
    }
    recordRaster(before, px);
  };

  const commitFloatingDiscard = () => {
    if (!floating) return;
    recordRaster(floating.before, floating.from);
    setFloating(null);
  };

  // MARK: 像素筆畫

  const rasterizeStroke = (strokeTool: "brush" | "eraser" | "heal", points: Array<[number, number]>) => {
    if (!points.length) return;
    const s = k();
    const canvas = canvasRef.current!;
    const size = brushSize * s;
    const xs = points.map((p) => p[0] * s);
    const ys = points.map((p) => p[1] * s);
    const bounds: PixelRect = [Math.min(...xs) - size, Math.min(...ys) - size, Math.max(...xs) + size, Math.max(...ys) + size];
    const before = snapshot();
    const drawPath = (c: CanvasRenderingContext2D, color: string) => {
      c.save();
      c.lineCap = "round";
      c.lineJoin = "round";
      c.lineWidth = size;
      c.strokeStyle = color;
      c.fillStyle = color;
      c.beginPath();
      if (points.length === 1) {
        c.arc(points[0][0] * s, points[0][1] * s, size / 2, 0, Math.PI * 2);
        c.fill();
      } else {
        c.moveTo(points[0][0] * s, points[0][1] * s);
        for (const [x, y] of points.slice(1)) c.lineTo(x * s, y * s);
        c.stroke();
      }
      c.restore();
    };
    if (strokeTool === "heal") {
      const area = clampRect([bounds[0] - size, bounds[1] - size, bounds[2] + size, bounds[3] + size], canvas.width, canvas.height);
      const w = area[2] - area[0];
      const h = area[3] - area[1];
      if (w < 1 || h < 1) return;
      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = w;
      maskCanvas.height = h;
      const mc = maskCanvas.getContext("2d")!;
      mc.translate(-area[0], -area[1]);
      drawPath(mc, "#000");
      const maskPixels = mc.getImageData(0, 0, w, h).data;
      const mask = new Uint8Array(w * h);
      for (let i = 0; i < mask.length; i++) mask[i] = maskPixels[i * 4 + 3] > 40 ? 1 : 0;
      const region = ctx().getImageData(area[0], area[1], w, h);
      inpaint({ width: w, height: h, data: region.data }, mask);
      ctx().putImageData(region, area[0], area[1]);
    } else {
      // 先畫在暫存畫布上再一次合成，透明度才會均勻
      const temp = document.createElement("canvas");
      temp.width = canvas.width;
      temp.height = canvas.height;
      drawPath(temp.getContext("2d")!, strokeTool === "eraser" ? paper : brushColor);
      const c = ctx();
      c.save();
      c.globalAlpha = strokeTool === "eraser" ? 1 : brushOpacity;
      c.drawImage(temp, 0, 0);
      c.restore();
    }
    recordRaster(before, bounds);
  };

  // MARK: 整頁操作

  const rotate90 = (clockwise: boolean) => {
    commitFloating();
    const before = canvasState();
    const canvas = canvasRef.current!;
    const source = cloneCanvas(canvas);
    canvas.width = source.height;
    canvas.height = source.width;
    const c = ctx();
    c.save();
    if (clockwise) {
      c.translate(canvas.width, 0);
      c.rotate(Math.PI / 2);
    } else {
      c.translate(0, canvas.height);
      c.rotate(-Math.PI / 2);
    }
    c.drawImage(source, 0, 0);
    c.restore();
    const { w, h } = pageSize;
    const map = clockwise ? (x: number, y: number): [number, number] => [h - y, x] : (x: number, y: number): [number, number] => [y, w - x];
    const nextObjects = objects.map((o) => transformObject(o, map, clockwise ? 90 : -90));
    setPageSize({ w: h, h: w });
    setObjects(nextObjects);
    setSelection(null);
    pushHistory({ kind: "canvas", before, after: { image: snapshot(), width: h, height: w, objects: nextObjects } });
  };

  const applyDeskew = () => {
    if (!deskew) return;
    commitFloating();
    const before = canvasState();
    const canvas = canvasRef.current!;
    const source = cloneCanvas(canvas);
    const c = ctx();
    c.save();
    c.fillStyle = paper;
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.translate(canvas.width / 2, canvas.height / 2);
    c.rotate((deskew * Math.PI) / 180);
    c.drawImage(source, -canvas.width / 2, -canvas.height / 2);
    c.restore();
    setDeskew(0);
    pushHistory({ kind: "canvas", before, after: { ...before, image: snapshot() } });
  };

  const applyAdjust = () => {
    if (brightness === 100 && contrast === 100 && !grayscale) return;
    commitFloating();
    const before = snapshot();
    const image = snapshot();
    adjust({ width: image.width, height: image.height, data: image.data }, brightness / 100, contrast / 100, grayscale);
    ctx().putImageData(image, 0, 0);
    setBrightness(100);
    setContrast(100);
    setGrayscale(false);
    recordRaster(before, [0, 0, image.width, image.height]);
  };

  const applyCrop = () => {
    if (!cropRect) return;
    commitFloating();
    const [x0, y0, x1, y1] = cropRect;
    if (x1 - x0 < 10 || y1 - y0 < 10) return;
    const before = canvasState();
    const s = k();
    const canvas = canvasRef.current!;
    const px = clampRect([x0 * s, y0 * s, x1 * s, y1 * s], canvas.width, canvas.height);
    const region = ctx().getImageData(px[0], px[1], px[2] - px[0], px[3] - px[1]);
    canvas.width = region.width;
    canvas.height = region.height;
    ctx().putImageData(region, 0, 0);
    const width = region.width / s;
    const height = region.height / s;
    const ox = px[0] / s;
    const oy = px[1] / s;
    const nextObjects = objects.map((o) => transformObject(o, (x, y) => [x - ox, y - oy], 0));
    setPageSize({ w: width, h: height });
    setObjects(nextObjects);
    setCropRect(null);
    pushHistory({ kind: "canvas", before, after: { image: snapshot(), width, height, objects: nextObjects } });
    setTool("select");
  };

  // MARK: 物件

  const measureText = useCallback(
    (obj: EditorTextObject): { w: number; h: number } => {
      const lines = obj.text.split("\n");
      const c = document.createElement("canvas").getContext("2d")!;
      c.font = `${obj.italic ? "italic " : ""}${obj.bold ? 700 : 400} ${obj.size}px ${fontStack(fontCssFor(obj), obj.choice)}`;
      const w = Math.max(obj.size * 0.5, ...lines.map((l) => c.measureText(l).width));
      return { w: Math.ceil(w + 2), h: obj.size * (TEXT_ASCENT + 0.32 + (lines.length - 1) * TEXT_LINE_HEIGHT) };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fontCss],
  );

  const fontCssFor = (obj: EditorTextObject) => fontCss[choiceKey(obj.choice, obj.bold, obj.italic)];

  // 字型載入或文字改變後重新計算文字外框（以左上角為準）
  useEffect(() => {
    let changed = false;
    const next = objects.map((o) => {
      if (o.type !== "text") return o;
      ensureFont(o.choice, o.bold, o.italic);
      const { w, h } = measureText(o);
      if (Math.abs(w - o.w) < 0.5 && Math.abs(h - o.h) < 0.5) return o;
      changed = true;
      return { ...o, w, h };
    });
    if (changed) setObjects(next);
  }, [objects, measureText, ensureFont]);

  const updateSelected = (patch: Partial<EditorObject>, record = true) => {
    if (!selected) return;
    const next = objects.map((o) => (o.id === selected.id ? ({ ...o, ...patch } as EditorObject) : o));
    if (record) commitObjects(next);
    else setObjects(next);
  };

  const deleteSelected = () => {
    if (!selected) return;
    commitObjects(objects.filter((o) => o.id !== selected.id));
    setSelectedId(null);
  };

  const reorderSelected = (direction: 1 | -1) => {
    if (!selected) return;
    const index = objects.findIndex((o) => o.id === selected.id);
    const target = index + direction;
    if (target < 0 || target >= objects.length) return;
    const next = [...objects];
    [next[index], next[target]] = [next[target], next[index]];
    commitObjects(next);
  };

  const addText = (x: number, y: number) => {
    const choice = lastChoice ?? fonts?.defaultChoice ?? { kind: "system", family: "sans-serif" };
    const obj: EditorTextObject = {
      id: nextObjectId++,
      type: "text",
      x,
      y,
      w: textSize * 4,
      h: textSize * 1.2,
      rotation: 0,
      text: "輸入文字",
      size: textSize,
      color: hexToRgb(textColor),
      bold: false,
      italic: false,
      align: "left",
      opacity: 1,
      choice,
    };
    commitObjects([...objects, obj]);
    setSelectedId(obj.id);
    setTool("select");
    setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    }, 0);
  };

  const insertImage = async () => {
    const data = await host.pickImage().catch(() => null);
    if (!data) return;
    const url = URL.createObjectURL(new Blob([data as BlobPart]));
    const img = new Image();
    img.onload = () => {
      const scale = Math.min((pageSize.w * 0.4) / img.naturalWidth, (pageSize.h * 0.4) / img.naturalHeight, 1);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      const obj: EditorObject = { id: nextObjectId++, type: "image", x: (pageSize.w - w) / 2, y: (pageSize.h - h) / 2, w, h, rotation: 0, data, opacity: 1, url };
      commitObjects([...objects, obj]);
      setSelectedId(obj.id);
      setTool("select");
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  };

  // MARK: 工具切換

  const setTool = (next: Tool) => {
    if (next !== "marquee") commitFloating();
    if (next !== "marquee") setSelection(null);
    if (next !== "crop") setCropRect(null);
    if (next === "crop") setCropRect([0, 0, pageSize.w, pageSize.h]);
    setToolState(next);
  };

  // MARK: 滑鼠

  const toPoint = (e: React.PointerEvent | PointerEvent): [number, number] => {
    const rect = svgRef.current!.getBoundingClientRect();
    return [(e.clientX - rect.left) / view, (e.clientY - rect.top) / view];
  };

  const hitObject = (p: [number, number]): EditorObject | null => {
    for (let i = objects.length - 1; i >= 0; i--) {
      const o = objects[i];
      if (isLine(o)) {
        if (distanceToSegment(p, [o.x1, o.y1], [o.x2, o.y2]) <= Math.max(4, o.strokeWidth) + 3 / view) return o;
        continue;
      }
      const local = rotatePoint(p, [o.x + o.w / 2, o.y + o.h / 2], -o.rotation);
      if (local[0] >= o.x - 3 && local[0] <= o.x + o.w + 3 && local[1] >= o.y - 3 && local[1] <= o.y + o.h + 3) return o;
    }
    return null;
  };

  const inside = (p: [number, number], r: { x: number; y: number; w: number; h: number } | null) => !!r && p[0] >= r.x && p[0] <= r.x + r.w && p[1] >= r.y && p[1] <= r.y + r.h;

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !loaded) return;
    const p = toPoint(e);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const handle = (e.target as Element).getAttribute?.("data-handle");

    // 物件的控制點
    if (handle && selected) {
      if (handle === "rotate") setDrag({ kind: "rotate", before: objects, origin: selected });
      else if (handle === "p1" || handle === "p2") setDrag({ kind: "endpoint", end: handle === "p1" ? 1 : 2, before: objects, origin: selected });
      else if (handle === "floating") setDrag({ kind: "floatingResize", origin: { x: floating!.x, y: floating!.y, w: floating!.w, h: floating!.h } });
      else {
        const [sx, sy] = handle.split(",").map(Number);
        setDrag({ kind: "resize", corner: [sx, sy], before: objects, origin: selected });
      }
      return;
    }
    if (handle === "floating" && floating) {
      setDrag({ kind: "floatingResize", origin: { x: floating.x, y: floating.y, w: floating.w, h: floating.h } });
      return;
    }

    switch (tool) {
      case "select": {
        if (floating && inside(p, floating)) {
          setDrag({ kind: "floating", start: p, origin: { x: floating.x, y: floating.y } });
          return;
        }
        const hit = hitObject(p);
        setSelectedId(hit?.id ?? null);
        if (hit) setDrag({ kind: "move", start: p, before: objects, origin: hit });
        return;
      }
      case "marquee": {
        if (floating && inside(p, floating)) {
          setDrag({ kind: "floating", start: p, origin: { x: floating.x, y: floating.y } });
          return;
        }
        if (!floating && selection && inside(p, { x: selection[0], y: selection[1], w: selection[2] - selection[0], h: selection[3] - selection[1] })) {
          // 拖曳選取範圍：拿起像素搬移（按住 Alt 為複製）
          const f = liftSelection(selection, !e.altKey);
          if (f) setDrag({ kind: "floating", start: p, origin: { x: f.x, y: f.y } });
          return;
        }
        commitFloating();
        setSelection(null);
        setDrag({ kind: "rect", tool: "marquee", start: p, current: p });
        return;
      }
      case "crop":
      case "rect":
      case "ellipse":
      case "line":
      case "arrow":
        setDrag({ kind: "rect", tool, start: p, current: p });
        return;
      case "brush":
      case "eraser":
      case "heal":
        setDrag({ kind: "stroke", tool, points: [p] });
        return;
      case "text": {
        const hit = hitObject(p);
        if (hit?.type === "text") {
          setSelectedId(hit.id);
          setTool("select");
          setTimeout(() => textareaRef.current?.focus(), 0);
        } else {
          addText(p[0], p[1] - textSize * 0.6);
        }
        return;
      }
      case "eyedropper": {
        const s = k();
        const [r, g, b] = ctx().getImageData(Math.floor(p[0] * s), Math.floor(p[1] * s), 1, 1).data;
        const hex = rgbToHex([r / 255, g / 255, b / 255]);
        if (e.altKey) setPaper(hex);
        else {
          setBrushColor(hex);
          setTextColor(hex);
          setStrokeColor(hex);
        }
        return;
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = toPoint(e);
    switch (drag.kind) {
      case "stroke":
        setDrag({ ...drag, points: [...drag.points, p] });
        return;
      case "rect": {
        let current = p;
        if (e.shiftKey && (drag.tool === "line" || drag.tool === "arrow")) {
          // Shift：以 45° 為單位
          const angle = Math.round(Math.atan2(p[1] - drag.start[1], p[0] - drag.start[0]) / (Math.PI / 4)) * (Math.PI / 4);
          const length = Math.hypot(p[0] - drag.start[0], p[1] - drag.start[1]);
          current = [drag.start[0] + Math.cos(angle) * length, drag.start[1] + Math.sin(angle) * length];
        }
        setDrag({ ...drag, current });
        if (drag.tool === "crop") setCropRect(normalized(drag.start, current, pageSize));
        return;
      }
      case "move": {
        const dx = p[0] - drag.start[0];
        const dy = p[1] - drag.start[1];
        const o = drag.origin;
        const moved: EditorObject = isLine(o) ? { ...o, x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy } : { ...o, x: o.x + dx, y: o.y + dy };
        setObjects(objects.map((x) => (x.id === o.id ? moved : x)));
        return;
      }
      case "endpoint": {
        const o = drag.origin;
        if (!isLine(o)) return;
        setObjects(objects.map((x) => (x.id === o.id ? (drag.end === 1 ? { ...o, x1: p[0], y1: p[1] } : { ...o, x2: p[0], y2: p[1] }) : x)));
        return;
      }
      case "rotate": {
        const o = drag.origin;
        if (isLine(o)) return;
        const c = [o.x + o.w / 2, o.y + o.h / 2];
        let angle = (Math.atan2(p[1] - c[1], p[0] - c[0]) * 180) / Math.PI + 90;
        if (e.shiftKey) angle = Math.round(angle / 15) * 15;
        angle = ((Math.round(angle) % 360) + 360) % 360;
        setObjects(objects.map((x) => (x.id === o.id ? ({ ...o, rotation: angle } as EditorObject) : x)));
        return;
      }
      case "resize": {
        const o = drag.origin;
        if (isLine(o)) return;
        const center: [number, number] = [o.x + o.w / 2, o.y + o.h / 2];
        const local = rotatePoint(p, center, -o.rotation);
        const [sx, sy] = drag.corner;
        // 對角固定不動
        const fixed: [number, number] = [sx < 0 ? o.x + o.w : o.x, sy < 0 ? o.y + o.h : o.y];
        let w = Math.max(4, Math.abs(local[0] - fixed[0]));
        let h = Math.max(4, Math.abs(local[1] - fixed[1]));
        if (o.type === "text") {
          const factor = h / o.h;
          const size = Math.max(4, Math.round(o.size * factor * 2) / 2);
          setObjects(objects.map((x) => (x.id === o.id ? { ...o, size } : x)));
          return;
        }
        if (o.type === "image" || e.shiftKey) {
          const factor = Math.max(w / o.w, h / o.h);
          w = o.w * factor;
          h = o.h * factor;
        }
        const nx = sx < 0 ? fixed[0] - w : fixed[0];
        const ny = sy < 0 ? fixed[1] - h : fixed[1];
        // 以原中心旋轉後的位置換算新中心
        const newCenterLocal: [number, number] = [nx + w / 2, ny + h / 2];
        const newCenter = rotatePoint(newCenterLocal, center, o.rotation);
        setObjects(objects.map((x) => (x.id === o.id ? ({ ...o, x: newCenter[0] - w / 2, y: newCenter[1] - h / 2, w, h } as EditorObject) : x)));
        return;
      }
      case "floating": {
        if (!floating) return;
        setFloating({ ...floating, x: drag.origin.x + p[0] - drag.start[0], y: drag.origin.y + p[1] - drag.start[1] });
        return;
      }
      case "floatingResize": {
        if (!floating) return;
        const o = drag.origin;
        let w = Math.max(2, p[0] - o.x);
        let h = Math.max(2, p[1] - o.y);
        if (!e.shiftKey) {
          // 預設維持比例
          const factor = Math.max(w / o.w, h / o.h);
          w = o.w * factor;
          h = o.h * factor;
        }
        setFloating({ ...floating, w, h });
        return;
      }
    }
  };

  const onPointerUp = () => {
    const current = drag;
    setDrag(null);
    if (!current) return;
    switch (current.kind) {
      case "stroke":
        rasterizeStroke(current.tool, current.points);
        return;
      case "rect": {
        const [x0, y0, x1, y1] = normalized(current.start, current.current, pageSize);
        const small = x1 - x0 < 2 && y1 - y0 < 2;
        if (current.tool === "marquee") {
          setSelection(small ? null : [x0, y0, x1, y1]);
          return;
        }
        if (current.tool === "crop") {
          if (small) setCropRect([0, 0, pageSize.w, pageSize.h]);
          return;
        }
        if (Math.hypot(current.current[0] - current.start[0], current.current[1] - current.start[1]) < 3) return;
        let obj: EditorObject;
        if (current.tool === "line" || current.tool === "arrow") {
          obj = { id: nextObjectId++, type: current.tool, x1: current.start[0], y1: current.start[1], x2: current.current[0], y2: current.current[1], stroke: hexToRgb(strokeColor), strokeWidth, opacity: 1 };
        } else {
          obj = { id: nextObjectId++, type: current.tool, x: x0, y: y0, w: x1 - x0, h: y1 - y0, rotation: 0, stroke: strokeWidth > 0 ? hexToRgb(strokeColor) : null, fill: fillColor ? hexToRgb(fillColor) : null, strokeWidth, opacity: 1 };
        }
        commitObjects([...objects, obj]);
        setSelectedId(obj.id);
        return;
      }
      case "move":
      case "resize":
      case "rotate":
      case "endpoint":
        commitObjects(objects, current.before);
        return;
    }
  };

  // MARK: 鍵盤

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.tagName === "TEXTAREA" || (target.tagName === "INPUT" && !["range", "checkbox", "color", "button"].includes((target as HTMLInputElement).type));
      const mod = e.ctrlKey || e.metaKey;
      if (confirmCancel || busy) return;
      if (mod && e.key.toLowerCase() === "z" && !typing) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y" && !typing) {
        e.preventDefault();
        redo();
        return;
      }
      if (typing) {
        if (e.key === "Escape") target.blur();
        return;
      }
      if (mod && ["c", "x", "v"].includes(e.key.toLowerCase())) {
        // 由 copy／cut／paste 事件處理
        return;
      } else if (mod && (e.key === "=" || e.key === "+")) {
        setView((v) => Math.min(6, v * 1.25));
        e.preventDefault();
      } else if (mod && e.key === "-") {
        setView((v) => Math.max(0.1, v / 1.25));
        e.preventDefault();
      } else if (mod && e.key === "0") {
        fitToStage();
        e.preventDefault();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selected) deleteSelected();
        else if (selection || floating) {
          fillSelection("paper");
          setSelection(null);
        }
        e.preventDefault();
      } else if (e.key === "Enter") {
        if (tool === "crop") applyCrop();
        else if (floating) commitFloating();
      } else if (e.key === "Escape") {
        if (floating) cancelFloating();
        else if (selection) setSelection(null);
        else if (selectedId !== null) setSelectedId(null);
        else if (tool !== "select") setTool("select");
      } else if (selected && e.key.startsWith("Arrow")) {
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        const o = selected;
        commitObjects(objects.map((x) => (x.id === o.id ? (isLine(o) ? { ...o, x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy } : { ...o, x: o.x + dx, y: o.y + dy }) : x)));
        e.preventDefault();
      } else if (!mod && !e.altKey) {
        const found = TOOLS.find((t) => t.key === e.key.toUpperCase());
        if (found) setTool(found.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // 主程式選單的指令（Windows 版的選單快速鍵不會送出按鍵事件）與系統的複製／貼上
  useEffect(() => {
    const onCommand = (event: Event) => {
      const command = (event as CustomEvent<string>).detail;
      if (command === "undo") undo();
      else if (command === "redo") redo();
      else if (command === "zoom-in") setView((v) => Math.min(6, v * 1.25));
      else if (command === "zoom-out") setView((v) => Math.max(0.1, v / 1.25));
      else if (command === "zoom-actual" || command === "fit-page" || command === "fit-width") fitToStage();
    };
    const editingText = (e: Event) => {
      const target = e.target as HTMLElement | null;
      return !!target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT");
    };
    const onCopy = (e: ClipboardEvent) => {
      if (editingText(e)) return;
      copySelection();
      e.preventDefault();
    };
    const onCut = (e: ClipboardEvent) => {
      if (editingText(e)) return;
      copySelection();
      fillSelection("paper");
      setSelection(null);
      e.preventDefault();
    };
    const onPaste = (e: ClipboardEvent) => {
      if (editingText(e)) return;
      pasteClipboard();
      e.preventDefault();
    };
    window.addEventListener("app-command", onCommand);
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("app-command", onCommand);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
    };
  });

  // MARK: 完成

  const finish = async () => {
    commitFloating();
    setBusy("正在套用…");
    try {
      let background: Uint8Array | null = null;
      if (undoStack.current.some((e) => e.kind !== "objects")) {
        const canvas = canvasRef.current!;
        const image = ctx().getImageData(0, 0, canvas.width, canvas.height);
        const photo = looksPhotographic({ width: image.width, height: image.height, data: image.data });
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, photo ? "image/jpeg" : "image/png", 0.92));
        if (!blob) throw new Error("無法輸出影像");
        background = new Uint8Array(await blob.arrayBuffer());
      }
      const result: EditorResult = {
        width: pageSize.w,
        height: pageSize.h,
        background,
        objects: objects.map((o) => {
          if (o.type === "image") {
            const { id: _id, url: _url, ...rest } = o;
            return rest;
          }
          const { id: _id, ...rest } = o;
          return rest;
        }),
      };
      onDone(result);
    } catch (error) {
      setBusy(null);
      alert(error instanceof Error ? error.message : String(error));
    }
  };

  const hasChanges = undoStack.current.length > 0 || floating !== null;
  const requestCancel = () => {
    if (hasChanges) setConfirmCancel(true);
    else onDone(null);
  };

  // MARK: 畫面

  const width = pageSize.w * view;
  const height = pageSize.h * view;
  const previewFilter = `brightness(${brightness}%) contrast(${contrast}%)${grayscale ? " grayscale(1)" : ""}`;
  const strokePreview = drag?.kind === "stroke" ? drag : null;
  const shapePreview = drag?.kind === "rect" && ["rect", "ellipse", "line", "arrow", "marquee"].includes(drag.tool) ? drag : null;
  const handleSize = 9 / view;

  return (
    <div className="ie-root" role="dialog" aria-label="影像編輯">
      <header className="ie-top">
        <strong className="ie-title">{title ?? "影像編輯"}</strong>
        <button onClick={undo} disabled={!canUndo} title="復原 (Ctrl+Z)">復原</button>
        <button onClick={redo} disabled={!canRedo} title="重做 (Ctrl+Y)">重做</button>
        <span className="ie-sep" />
        <button onClick={() => setView((v) => Math.max(0.1, v / 1.25))} title="縮小 (Ctrl+-)">−</button>
        <span className="ie-zoom">{Math.round(view * 100)}%</span>
        <button onClick={() => setView((v) => Math.min(6, v * 1.25))} title="放大 (Ctrl+=)">＋</button>
        <button onClick={fitToStage} title="符合視窗 (Ctrl+0)">符合視窗</button>
        <span className="ie-spacer" />
        {pixelsChanged && <span className="ie-note">套用後，此頁會以編輯後的影像取代（文字物件仍可搜尋）</span>}
        <button onClick={requestCancel}>取消</button>
        <button className="ie-primary" onClick={finish} disabled={!loaded || !!busy}>
          套用到 PDF
        </button>
      </header>

      <div className="ie-body">
        <nav className="ie-tools" aria-label="工具">
          {TOOLS.map((t) => (
            <button key={t.id} className={tool === t.id ? "active" : ""} title={`${t.label} (${t.key})`} aria-label={t.label} aria-pressed={tool === t.id} data-tool={t.id} onClick={() => setTool(t.id)}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d={t.icon} />
              </svg>
            </button>
          ))}
          <button title="插入圖片" aria-label="插入圖片" onClick={insertImage}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01" />
            </svg>
          </button>
        </nav>

        <div
          className="ie-stage"
          ref={stageRef}
          onWheel={(e) => {
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();
            setView((v) => Math.max(0.1, Math.min(6, v * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
          }}
        >
          <div className="ie-page" style={{ width, height }}>
            <canvas
              ref={canvasRef}
              className="ie-canvas"
              style={{ width, height, filter: previewFilter, transform: deskew ? `rotate(${deskew}deg)` : undefined }}
            />
            <svg
              ref={svgRef}
              className={`ie-overlay tool-${tool}`}
              width={width}
              height={height}
              viewBox={`0 0 ${pageSize.w} ${pageSize.h}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onDoubleClick={() => {
                if (selected?.type === "text") textareaRef.current?.focus();
              }}
            >
              {floating && (
                <g>
                  <image href={floating.url} x={floating.x} y={floating.y} width={floating.w} height={floating.h} preserveAspectRatio="none" />
                  <rect className="ie-ants" x={floating.x} y={floating.y} width={floating.w} height={floating.h} strokeWidth={1 / view} />
                  <rect className="ie-handle" data-handle="floating" x={floating.x + floating.w - handleSize / 2} y={floating.y + floating.h - handleSize / 2} width={handleSize} height={handleSize} strokeWidth={1 / view} />
                </g>
              )}
              {objects.map((o) => (
                <ObjectView key={o.id} obj={o} css={o.type === "text" ? fontCssFor(o) : undefined} />
              ))}
              {selected && <SelectionHandles obj={selected} view={view} />}
              {selection && !floating && (
                <rect className="ie-ants" x={selection[0]} y={selection[1]} width={selection[2] - selection[0]} height={selection[3] - selection[1]} strokeWidth={1 / view} />
              )}
              {cropRect && tool === "crop" && (
                <g>
                  <path className="ie-crop-shade" d={`M0 0H${pageSize.w}V${pageSize.h}H0Z M${cropRect[0]} ${cropRect[1]}V${cropRect[3]}H${cropRect[2]}V${cropRect[1]}Z`} fillRule="evenodd" />
                  <rect className="ie-crop" x={cropRect[0]} y={cropRect[1]} width={cropRect[2] - cropRect[0]} height={cropRect[3] - cropRect[1]} strokeWidth={1.5 / view} />
                </g>
              )}
              {strokePreview && (
                <polyline
                  points={strokePreview.points.map((p) => p.join(",")).join(" ")}
                  fill="none"
                  stroke={strokePreview.tool === "heal" ? "rgba(224,49,49,0.45)" : strokePreview.tool === "eraser" ? paper : brushColor}
                  strokeOpacity={strokePreview.tool === "brush" ? brushOpacity : 1}
                  strokeWidth={brushSize}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
              {shapePreview && <ShapePreview drag={shapePreview} stroke={strokeColor} fill={fillColor} width={strokeWidth} view={view} />}
            </svg>
          </div>
          {!loaded && <div className="ie-loading">正在載入頁面…</div>}
        </div>

        <aside className="ie-panel">
          {selected ? (
            <ObjectPanel
              obj={selected}
              fonts={fonts}
              textareaRef={textareaRef}
              onChange={(patch, record) => {
                updateSelected(patch, record);
                if (selected.type === "text" && "choice" in patch && patch.choice) setLastChoice(patch.choice as EditorFontChoice);
              }}
              onCommit={(before) => commitObjects(objects, before)}
              objects={objects}
              onDelete={deleteSelected}
              onReorder={reorderSelected}
            />
          ) : (
            <ToolPanel
              tool={tool}
              brush={{ color: brushColor, size: brushSize, opacity: brushOpacity, setColor: setBrushColor, setSize: setBrushSize, setOpacity: setBrushOpacity }}
              paper={paper}
              setPaper={setPaper}
              shape={{ stroke: strokeColor, fill: fillColor, width: strokeWidth, setStroke: setStrokeColor, setFill: setFillColor, setWidth: setStrokeWidth }}
              text={{ color: textColor, size: textSize, setColor: setTextColor, setSize: setTextSize }}
              selection={!!selection || !!floating}
              floating={!!floating}
              onFill={(mode) => {
                fillSelection(mode);
                setSelection(null);
              }}
              onCopy={copySelection}
              onPaste={pasteClipboard}
              onCommitFloating={() => commitFloating()}
              onCancelFloating={cancelFloating}
              cropRect={cropRect}
              onApplyCrop={applyCrop}
              onResetCrop={() => setCropRect([0, 0, pageSize.w, pageSize.h])}
            />
          )}
          <section className="ie-section">
            <h3>整頁</h3>
            <div className="ie-row">
              <button onClick={() => rotate90(false)} title="向左旋轉 90°">↺ 90°</button>
              <button onClick={() => rotate90(true)} title="向右旋轉 90°">↻ 90°</button>
            </div>
            <label className="ie-field">
              <span>拉正（{deskew}°）</span>
              <input type="range" min={-15} max={15} step={0.5} value={deskew} onChange={(e) => setDeskew(Number(e.target.value))} />
            </label>
            {deskew !== 0 && (
              <div className="ie-row">
                <button onClick={applyDeskew}>套用拉正</button>
                <button onClick={() => setDeskew(0)}>重設</button>
              </div>
            )}
            <label className="ie-field">
              <span>亮度（{brightness}%）</span>
              <input type="range" min={30} max={200} value={brightness} onChange={(e) => setBrightness(Number(e.target.value))} />
            </label>
            <label className="ie-field">
              <span>對比（{contrast}%）</span>
              <input type="range" min={30} max={300} value={contrast} onChange={(e) => setContrast(Number(e.target.value))} />
            </label>
            <label className="ie-check">
              <input type="checkbox" checked={grayscale} onChange={(e) => setGrayscale(e.target.checked)} /> 轉成黑白（灰階）
            </label>
            {(brightness !== 100 || contrast !== 100 || grayscale) && (
              <div className="ie-row">
                <button onClick={applyAdjust}>套用調整</button>
                <button
                  onClick={() => {
                    setBrightness(100);
                    setContrast(100);
                    setGrayscale(false);
                  }}
                >
                  重設
                </button>
              </div>
            )}
          </section>
        </aside>
      </div>

      {confirmCancel && (
        <div className="ie-modal">
          <div className="ie-dialog">
            <p>要放棄這一頁的影像編輯嗎？所做的修改都不會套用。</p>
            <div className="ie-row end">
              <button onClick={() => setConfirmCancel(false)}>繼續編輯</button>
              <button className="ie-danger" onClick={() => onDone(null)}>
                放棄修改
              </button>
            </div>
          </div>
        </div>
      )}
      {busy && (
        <div className="ie-modal">
          <div className="ie-dialog">{busy}</div>
        </div>
      )}
    </div>
  );
}

// MARK: - 物件顯示

function ObjectView({ obj, css }: { obj: EditorObject; css?: string | null }) {
  switch (obj.type) {
    case "text": {
      const lines = obj.text.split("\n");
      const anchor = obj.align === "center" ? "middle" : obj.align === "right" ? "end" : "start";
      const x = obj.align === "center" ? obj.x + obj.w / 2 : obj.align === "right" ? obj.x + obj.w : obj.x;
      return (
        <g transform={obj.rotation ? `rotate(${obj.rotation} ${obj.x + obj.w / 2} ${obj.y + obj.h / 2})` : undefined} opacity={obj.opacity}>
          {lines.map((line, i) => (
            <text
              key={i}
              x={x}
              y={obj.y + obj.size * (TEXT_ASCENT + i * TEXT_LINE_HEIGHT)}
              fontSize={obj.size}
              fontFamily={fontStack(css, obj.choice)}
              fontWeight={obj.bold ? 700 : 400}
              fontStyle={obj.italic ? "italic" : "normal"}
              fill={rgbCss(obj.color)}
              textAnchor={anchor}
              style={{ whiteSpace: "pre" }}
            >
              {line || " "}
            </text>
          ))}
        </g>
      );
    }
    case "rect":
    case "ellipse": {
      const common = {
        fill: rgbCss(obj.fill),
        stroke: obj.stroke && obj.strokeWidth > 0 ? rgbCss(obj.stroke) : "none",
        strokeWidth: obj.strokeWidth,
        opacity: obj.opacity,
        transform: obj.rotation ? `rotate(${obj.rotation} ${obj.x + obj.w / 2} ${obj.y + obj.h / 2})` : undefined,
      };
      return obj.type === "rect" ? <rect x={obj.x} y={obj.y} width={obj.w} height={obj.h} {...common} /> : <ellipse cx={obj.x + obj.w / 2} cy={obj.y + obj.h / 2} rx={obj.w / 2} ry={obj.h / 2} {...common} />;
    }
    case "line":
    case "arrow": {
      const angle = Math.atan2(obj.y2 - obj.y1, obj.x2 - obj.x1);
      const head = Math.max(8, obj.strokeWidth * 4);
      const ex = obj.type === "arrow" ? obj.x2 - head * 0.8 * Math.cos(angle) : obj.x2;
      const ey = obj.type === "arrow" ? obj.y2 - head * 0.8 * Math.sin(angle) : obj.y2;
      return (
        <g opacity={obj.opacity}>
          <line x1={obj.x1} y1={obj.y1} x2={ex} y2={ey} stroke={rgbCss(obj.stroke)} strokeWidth={obj.strokeWidth} strokeLinecap="round" />
          {obj.type === "arrow" && (
            <polygon
              points={[
                [obj.x2, obj.y2],
                [obj.x2 - head * Math.cos(angle - Math.PI / 7), obj.y2 - head * Math.sin(angle - Math.PI / 7)],
                [obj.x2 - head * Math.cos(angle + Math.PI / 7), obj.y2 - head * Math.sin(angle + Math.PI / 7)],
              ]
                .map((p) => p.join(","))
                .join(" ")}
              fill={rgbCss(obj.stroke)}
            />
          )}
        </g>
      );
    }
    case "image":
      return (
        <image
          href={obj.url}
          x={obj.x}
          y={obj.y}
          width={obj.w}
          height={obj.h}
          preserveAspectRatio="none"
          opacity={obj.opacity}
          transform={obj.rotation ? `rotate(${obj.rotation} ${obj.x + obj.w / 2} ${obj.y + obj.h / 2})` : undefined}
        />
      );
  }
}

function SelectionHandles({ obj, view }: { obj: EditorObject; view: number }) {
  const size = 9 / view;
  const stroke = 1 / view;
  if (isLine(obj)) {
    return (
      <g>
        {([1, 2] as const).map((end) => (
          <circle key={end} className="ie-handle" data-handle={`p${end}`} cx={end === 1 ? obj.x1 : obj.x2} cy={end === 1 ? obj.y1 : obj.y2} r={size / 1.6} strokeWidth={stroke} />
        ))}
      </g>
    );
  }
  const cx = obj.x + obj.w / 2;
  const cy = obj.y + obj.h / 2;
  const corners: Array<[number, number]> = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  return (
    <g transform={obj.rotation ? `rotate(${obj.rotation} ${cx} ${cy})` : undefined}>
      <rect className="ie-selected" x={obj.x} y={obj.y} width={obj.w} height={obj.h} strokeWidth={stroke} />
      <line className="ie-selected" x1={cx} y1={obj.y} x2={cx} y2={obj.y - 22 / view} strokeWidth={stroke} />
      <circle className="ie-handle ie-rotate" data-handle="rotate" cx={cx} cy={obj.y - 22 / view} r={size / 1.6} strokeWidth={stroke} />
      {corners.map(([sx, sy]) => (
        <rect
          key={`${sx},${sy}`}
          className="ie-handle"
          data-handle={`${sx},${sy}`}
          x={(sx < 0 ? obj.x : obj.x + obj.w) - size / 2}
          y={(sy < 0 ? obj.y : obj.y + obj.h) - size / 2}
          width={size}
          height={size}
          strokeWidth={stroke}
        />
      ))}
    </g>
  );
}

function ShapePreview({ drag, stroke, fill, width, view }: { drag: Extract<Drag, { kind: "rect" }>; stroke: string; fill: string | null; width: number; view: number }) {
  const [x0, y0] = [Math.min(drag.start[0], drag.current[0]), Math.min(drag.start[1], drag.current[1])];
  const [x1, y1] = [Math.max(drag.start[0], drag.current[0]), Math.max(drag.start[1], drag.current[1])];
  if (drag.tool === "marquee") return <rect className="ie-ants" x={x0} y={y0} width={x1 - x0} height={y1 - y0} strokeWidth={1 / view} />;
  if (drag.tool === "line" || drag.tool === "arrow") return <line x1={drag.start[0]} y1={drag.start[1]} x2={drag.current[0]} y2={drag.current[1]} stroke={stroke} strokeWidth={width} strokeLinecap="round" />;
  const common = { stroke: width > 0 ? stroke : "none", strokeWidth: width, fill: fill ?? "none" };
  return drag.tool === "rect" ? <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} {...common} /> : <ellipse cx={(x0 + x1) / 2} cy={(y0 + y1) / 2} rx={(x1 - x0) / 2} ry={(y1 - y0) / 2} {...common} />;
}

// MARK: - 屬性面板

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="ie-field ie-inline">
      <span>{label}</span>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function NumberField({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <label className="ie-field ie-inline">
      <span>{label}</span>
      <input type="number" min={min} max={max} step={step} value={Math.round(value * 100) / 100} onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || min)))} />
    </label>
  );
}

function ToolPanel(props: {
  tool: Tool;
  brush: { color: string; size: number; opacity: number; setColor: (v: string) => void; setSize: (v: number) => void; setOpacity: (v: number) => void };
  paper: string;
  setPaper: (v: string) => void;
  shape: { stroke: string; fill: string | null; width: number; setStroke: (v: string) => void; setFill: (v: string | null) => void; setWidth: (v: number) => void };
  text: { color: string; size: number; setColor: (v: string) => void; setSize: (v: number) => void };
  selection: boolean;
  floating: boolean;
  onFill: (mode: "paper" | "heal") => void;
  onCopy: () => void;
  onPaste: () => void;
  onCommitFloating: () => void;
  onCancelFloating: () => void;
  cropRect: [number, number, number, number] | null;
  onApplyCrop: () => void;
  onResetCrop: () => void;
}) {
  const { tool, brush, shape, text } = props;
  const info = TOOLS.find((t) => t.id === tool);
  return (
    <section className="ie-section">
      <h3>{info?.label ?? "工具"}</h3>
      {tool === "select" && <p className="ie-hint">點選文字、圖形或圖片即可拖曳移動；拖曳角落縮放、拖曳上方圓點旋轉（按住 Shift 以 15° 為單位）。方向鍵微調位置。</p>}
      {tool === "marquee" && (
        <>
          <p className="ie-hint">拖曳框選頁面上的任何區域（文字、表格、圖案都當作圖片）。拖曳選取範圍可搬移，按住 Alt 拖曳為複製；拖曳右下角可縮放。</p>
          <div className="ie-row wrap">
            <button disabled={!props.selection} onClick={props.onCopy} title="Ctrl+C">複製</button>
            <button onClick={props.onPaste} title="Ctrl+V">貼上</button>
            <button disabled={!props.selection} onClick={() => props.onFill("paper")} title="Delete">刪除（填背景色）</button>
            <button disabled={!props.selection || props.floating} onClick={() => props.onFill("heal")}>修補填滿</button>
          </div>
          {props.floating && (
            <div className="ie-row">
              <button className="ie-primary" onClick={props.onCommitFloating} title="Enter">放下</button>
              <button onClick={props.onCancelFloating} title="Esc">取消搬移</button>
            </div>
          )}
          <ColorField label="背景色" value={props.paper} onChange={props.setPaper} />
        </>
      )}
      {tool === "brush" && (
        <>
          <ColorField label="顏色" value={brush.color} onChange={brush.setColor} />
          <NumberField label="粗細" value={brush.size} min={0.5} max={200} step={0.5} onChange={brush.setSize} />
          <label className="ie-field">
            <span>不透明度（{Math.round(brush.opacity * 100)}%）</span>
            <input type="range" min={0.05} max={1} step={0.05} value={brush.opacity} onChange={(e) => brush.setOpacity(Number(e.target.value))} />
          </label>
        </>
      )}
      {tool === "eraser" && (
        <>
          <p className="ie-hint">把塗過的地方改成背景色（預設為自動偵測的紙張顏色，可用吸管按住 Alt 點選頁面取色）。</p>
          <ColorField label="背景色" value={props.paper} onChange={props.setPaper} />
          <NumberField label="粗細" value={brush.size} min={0.5} max={200} step={0.5} onChange={brush.setSize} />
        </>
      )}
      {tool === "heal" && (
        <>
          <p className="ie-hint">塗過要去除的地方（污點、不要的字或線條），放開滑鼠後以周圍的顏色自然填補。</p>
          <NumberField label="粗細" value={brush.size} min={1} max={200} step={0.5} onChange={brush.setSize} />
        </>
      )}
      {tool === "text" && (
        <>
          <p className="ie-hint">在頁面上點一下加入文字，之後可在右側修改內容、字型與大小，隨時拖曳移動或旋轉。</p>
          <ColorField label="顏色" value={text.color} onChange={text.setColor} />
          <NumberField label="字級" value={text.size} min={4} max={300} step={0.5} onChange={text.setSize} />
        </>
      )}
      {(tool === "rect" || tool === "ellipse" || tool === "line" || tool === "arrow") && (
        <>
          <p className="ie-hint">拖曳繪製{tool === "line" || tool === "arrow" ? "（按住 Shift 以 45° 為單位）" : ""}，畫好後可隨時調整。</p>
          <ColorField label="線條顏色" value={shape.stroke} onChange={shape.setStroke} />
          <NumberField label="線條粗細" value={shape.width} min={0} max={50} step={0.5} onChange={shape.setWidth} />
          {(tool === "rect" || tool === "ellipse") && (
            <>
              <label className="ie-check">
                <input type="checkbox" checked={shape.fill !== null} onChange={(e) => shape.setFill(e.target.checked ? shape.stroke : null)} /> 填色
              </label>
              {shape.fill !== null && <ColorField label="填色" value={shape.fill} onChange={shape.setFill} />}
            </>
          )}
        </>
      )}
      {tool === "crop" && (
        <>
          <p className="ie-hint">拖曳選擇要保留的範圍，按「套用裁切」或 Enter。裁切後頁面大小會改變。</p>
          {props.cropRect && (
            <p className="ie-hint">
              {Math.round(props.cropRect[2] - props.cropRect[0])} × {Math.round(props.cropRect[3] - props.cropRect[1])} pt
            </p>
          )}
          <div className="ie-row">
            <button className="ie-primary" onClick={props.onApplyCrop}>套用裁切</button>
            <button onClick={props.onResetCrop}>重設</button>
          </div>
        </>
      )}
      {tool === "eyedropper" && <p className="ie-hint">點選頁面取色，套用到筆刷、文字與圖形的顏色；按住 Alt 點選則設為背景色。</p>}
    </section>
  );
}

function ObjectPanel({
  obj,
  fonts,
  textareaRef,
  onChange,
  onCommit,
  objects,
  onDelete,
  onReorder,
}: {
  obj: EditorObject;
  fonts: { families: Array<{ family: string; label: string }>; downloadable: string[] } | null;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onChange: (patch: Partial<EditorObject>, record: boolean) => void;
  onCommit: (before: EditorObject[]) => void;
  objects: EditorObject[];
  onDelete: () => void;
  onReorder: (direction: 1 | -1) => void;
}) {
  // 連續輸入（打字、拖曳滑桿）時只記錄一次復原
  const before = useRef<EditorObject[] | null>(null);
  const live = (patch: Partial<EditorObject>) => {
    before.current ??= objects;
    onChange(patch, false);
  };
  const done = () => {
    if (before.current) onCommit(before.current);
    before.current = null;
  };
  const names: Record<EditorObject["type"], string> = { text: "文字", rect: "矩形", ellipse: "橢圓", line: "直線", arrow: "箭頭", image: "圖片" };
  const key = obj.type === "text" ? `${obj.choice.kind}:${obj.choice.family}` : "";
  const fontKnown = obj.type === "text" && (fonts?.families.some((f) => `system:${f.family}` === key) || fonts?.downloadable.some((f) => `download:${f}` === key));

  return (
    <section className="ie-section">
      <h3>{names[obj.type]}</h3>
      {obj.type === "text" && (
        <>
          <textarea
            ref={textareaRef}
            className="ie-textarea"
            rows={3}
            value={obj.text}
            onChange={(e) => live({ text: e.target.value })}
            onBlur={done}
          />
          <label className="ie-field">
            <span>字型</span>
            <select
              value={key}
              onChange={(e) => {
                const [kind, ...rest] = e.target.value.split(":");
                onChange({ choice: { kind: kind as "system" | "download", family: rest.join(":") } } as Partial<EditorObject>, true);
              }}
            >
              {!fontKnown && <option value={key}>{obj.choice.family}</option>}
              <optgroup label="可自動下載的開源字型">
                {fonts?.downloadable.map((f) => (
                  <option key={f} value={`download:${f}`}>{f}</option>
                ))}
              </optgroup>
              <optgroup label={fonts ? "電腦上的字型" : "電腦上的字型（讀取中…）"}>
                {fonts?.families.map((f) => (
                  <option key={f.family} value={`system:${f.family}`}>{f.label}</option>
                ))}
              </optgroup>
            </select>
          </label>
          <div className="ie-row">
            <button className={obj.bold ? "active" : ""} aria-pressed={obj.bold} onClick={() => onChange({ bold: !obj.bold }, true)} title="粗體"><b>B</b></button>
            <button className={obj.italic ? "active" : ""} aria-pressed={obj.italic} onClick={() => onChange({ italic: !obj.italic }, true)} title="斜體"><i>I</i></button>
            {(["left", "center", "right"] as const).map((a) => (
              <button key={a} className={obj.align === a ? "active" : ""} onClick={() => onChange({ align: a }, true)} title={{ left: "靠左", center: "置中", right: "靠右" }[a]}>
                {{ left: "左", center: "中", right: "右" }[a]}
              </button>
            ))}
          </div>
          <NumberField label="字級" value={obj.size} min={4} max={300} step={0.5} onChange={(v) => onChange({ size: v }, true)} />
          <ColorField label="顏色" value={rgbToHex(obj.color)} onChange={(v) => onChange({ color: hexToRgb(v) }, true)} />
        </>
      )}
      {(obj.type === "rect" || obj.type === "ellipse") && (
        <>
          <label className="ie-check">
            <input type="checkbox" checked={obj.stroke !== null && obj.strokeWidth > 0} onChange={(e) => onChange({ stroke: e.target.checked ? obj.stroke ?? [0, 0, 0] : null, strokeWidth: e.target.checked ? Math.max(1, obj.strokeWidth) : obj.strokeWidth }, true)} /> 線條
          </label>
          {obj.stroke && <ColorField label="線條顏色" value={rgbToHex(obj.stroke)} onChange={(v) => onChange({ stroke: hexToRgb(v) }, true)} />}
          <NumberField label="線條粗細" value={obj.strokeWidth} min={0} max={50} step={0.5} onChange={(v) => onChange({ strokeWidth: v }, true)} />
          <label className="ie-check">
            <input type="checkbox" checked={obj.fill !== null} onChange={(e) => onChange({ fill: e.target.checked ? obj.stroke ?? [1, 1, 1] : null }, true)} /> 填色
          </label>
          {obj.fill && <ColorField label="填色" value={rgbToHex(obj.fill)} onChange={(v) => onChange({ fill: hexToRgb(v) }, true)} />}
        </>
      )}
      {(isLine(obj)) && (
        <>
          <ColorField label="顏色" value={rgbToHex(obj.stroke)} onChange={(v) => onChange({ stroke: hexToRgb(v) }, true)} />
          <NumberField label="粗細" value={obj.strokeWidth} min={0.5} max={50} step={0.5} onChange={(v) => onChange({ strokeWidth: v }, true)} />
        </>
      )}
      {!isLine(obj) && (
        <NumberField label="旋轉（°）" value={obj.rotation} min={-360} max={360} onChange={(v) => onChange({ rotation: ((v % 360) + 360) % 360 }, true)} />
      )}
      <label className="ie-field">
        <span>不透明度（{Math.round(obj.opacity * 100)}%）</span>
        <input type="range" min={0.05} max={1} step={0.05} value={obj.opacity} onChange={(e) => live({ opacity: Number(e.target.value) })} onPointerUp={done} onKeyUp={done} />
      </label>
      <div className="ie-row wrap">
        <button onClick={() => onReorder(1)} title="移到上一層">上移一層</button>
        <button onClick={() => onReorder(-1)} title="移到下一層">下移一層</button>
        <button className="ie-danger" onClick={onDelete} title="Delete">刪除</button>
      </div>
    </section>
  );
}

// MARK: - 幾何

function rotatePoint([x, y]: [number, number], [cx, cy]: [number, number], degrees: number): [number, number] {
  const r = (degrees * Math.PI) / 180;
  return [cx + (x - cx) * Math.cos(r) - (y - cy) * Math.sin(r), cy + (x - cx) * Math.sin(r) + (y - cy) * Math.cos(r)];
}

function distanceToSegment(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function normalized(a: [number, number], b: [number, number], size: { w: number; h: number }): [number, number, number, number] {
  const clampX = (v: number) => Math.max(0, Math.min(size.w, v));
  const clampY = (v: number) => Math.max(0, Math.min(size.h, v));
  return [clampX(Math.min(a[0], b[0])), clampY(Math.min(a[1], b[1])), clampX(Math.max(a[0], b[0])), clampY(Math.max(a[1], b[1]))];
}

function cloneCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  canvas.getContext("2d")!.drawImage(source, 0, 0);
  return canvas;
}

function stripUrls(list: EditorObject[]) {
  return list.map((o) => (o.type === "image" ? { ...o, data: o.data.length, url: "" } : o));
}

/** 預設的範例主程式（測試用）。 */
export const EMPTY_HOST: EditorHost = {
  listFonts: async () => ({ families: [], downloadable: [], defaultChoice: { kind: "system", family: "sans-serif" } }),
  previewFont: async () => null,
  pickImage: async () => null,
};

export type { EditorHost, EditorResult };
