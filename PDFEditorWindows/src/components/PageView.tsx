import { useEffect, useRef, useState } from "react";
import { inflate, normalizeRect, rectContains } from "../engine/geometry";
import type { FontRequest } from "../engine/fonts";
import type { ReplaceResult } from "../engine/pdfEngine";
import type { AnnotInfo, LinkInfo, MarkupKind, Point, Quad, Rect, ShapeKind, TextBoxStyle, TextLine, WidgetInfo } from "../engine/types";
import { api, type ResolvedFont } from "../lib/api";
import { engine } from "../lib/engine";
import { goToPage, mutate, selectTool } from "../state/actions";
import { type DocTab, hexToRgb, rgbToHex, setState, toast, updateTab, useStore } from "../state/store";
import { downloadableFamilies, describeFont, type FontChoice, fontData, AUTO_FONT, previewFamily, resolveChoice, resolveFallback } from "../lib/fonts";
import { FontControls, type FontSettings } from "./FontControls";
import { prompt } from "./Modal";
import { lastTextBoxChoice, textBoxDialog } from "./dialogs/TextBoxDialog";
import { openSignatures } from "./dialogs/SignatureDialog";

const MOVABLE = new Set(["FreeText", "Text", "Square", "Circle", "Line", "Ink", "Stamp", "Polygon", "PolyLine", "Redact"]);
const MARKUP: Record<string, MarkupKind> = { highlight: "Highlight", underline: "Underline", strikeout: "StrikeOut" };
const SHAPES: Record<string, ShapeKind> = { rectangle: "square", ellipse: "circle", line: "line", arrow: "arrow", whiteout: "whiteout", redact: "redact" };
/** 單頁渲染的最大像素數，避免高倍率時耗盡記憶體 */
const MAX_PIXELS = 24_000_000;

type Drag =
  | { kind: "move"; annot: AnnotInfo; start: Point; current: Point }
  | { kind: "text"; start: Point; current: Point; markup: MarkupKind | null }
  | { kind: "ink"; points: Point[] }
  | { kind: "shape"; shape: ShapeKind; start: Point; current: Point };

interface Props {
  tab: DocTab;
  pageIndex: number;
  scale: number;
}

export function PageView({ tab, pageIndex, scale }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const tool = useStore((s) => s.tool);
  const color = useStore((s) => s.color);
  const lineWidth = useStore((s) => s.lineWidth);
  const fontSize = useStore((s) => s.fontSize);
  const fillShapes = useStore((s) => s.fillShapes);
  const pendingImage = useStore((s) => s.pendingImage);
  const [annots, setAnnots] = useState<AnnotInfo[]>([]);
  const [widgets, setWidgets] = useState<WidgetInfo[]>([]);
  const [links, setLinks] = useState<LinkInfo[]>([]);
  const [textLines, setTextLines] = useState<TextLine[]>([]);
  const [editingLine, setEditingLine] = useState<TextLine | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [loaded, setLoaded] = useState(false);
  const info = tab.info.pages[pageIndex];
  const width = info.width * scale;
  const height = info.height * scale;
  const { engineId, revision } = tab;

  // 渲染頁面（縮放時稍作延遲，避免連續重繪）
  useEffect(() => {
    let cancelled = false;
    const dpr = window.devicePixelRatio || 1;
    let renderScale = scale * dpr;
    const pixels = info.width * info.height * renderScale * renderScale;
    if (pixels > MAX_PIXELS) renderScale *= Math.sqrt(MAX_PIXELS / pixels);
    const timer = setTimeout(async () => {
      try {
        const result = await engine.render(engineId, pageIndex, renderScale);
        const canvas = canvasRef.current;
        if (cancelled || !canvas) return;
        canvas.width = result.width;
        canvas.height = result.height;
        canvas.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(result.pixels), result.width, result.height), 0, 0);
        setLoaded(true);
      } catch {
        // 文件已關閉或頁面已刪除
      }
    }, loaded ? 120 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineId, pageIndex, revision, scale, info.width, info.height]);

  // 編輯文字工具：讀取頁面上的文字行
  const linesRevision = useRef(-1);
  useEffect(() => {
    if (tool !== "edittext") {
      setEditingLine(null);
      return;
    }
    let cancelled = false;
    linesRevision.current = -1;
    engine
      .textLines(engineId, pageIndex)
      .then((lines) => {
        if (cancelled) return;
        setTextLines(lines);
        linesRevision.current = revision;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [engineId, pageIndex, revision, tool]);

  // 註解、表單與連結
  useEffect(() => {
    let cancelled = false;
    Promise.all([engine.annotations(engineId, pageIndex), engine.widgets(engineId, pageIndex), engine.links(engineId, pageIndex)])
      .then(([a, w, l]) => {
        if (cancelled) return;
        setAnnots(a);
        setWidgets(w);
        setLinks(l);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [engineId, pageIndex, revision]);

  const toPage = (e: { clientX: number; clientY: number }): Point => {
    const rect = overlayRef.current!.getBoundingClientRect();
    return [(e.clientX - rect.left) / scale, (e.clientY - rect.top) / scale];
  };

  const topAnnot = (p: Point, predicate: (a: AnnotInfo) => boolean) =>
    [...annots].reverse().find((a) => predicate(a) && rectContains(inflate(a.rect, 3 / scale), p));

  const rgb = hexToRgb(color);
  const select = (annot: AnnotInfo | null) => updateTab(tab.key, { selectedAnnot: annot ? { page: pageIndex, id: annot.id } : null });

  const updateSelection = async (from: Point, to: Point, markup: MarkupKind | null) => {
    const selection = await engine.selectText(engineId, pageIndex, from, to);
    updateTab(tab.key, { textSelection: selection.quads.length ? { page: pageIndex, ...selection } : null });
    return { selection, markup };
  };

  const onPointerDown = async (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const p = toPage(e);
    const target = e.currentTarget;
    const capture = () => target.setPointerCapture(e.pointerId);
    updateTab(tab.key, { currentPage: pageIndex });

    switch (tool) {
      case "edittext": {
        // 阻止後續的 mousedown 把焦點從剛出現的編輯框移走
        e.preventDefault();
        // 文字行還在分析中（例如剛切換工具或剛做完 OCR）時直接向引擎查詢
        const line = linesRevision.current === revision ? textLines.find((l) => rectContains(inflate(l.bbox, 2), p)) : await engine.textLineAt(engineId, pageIndex, p).catch(() => null);
        setEditingLine(line ?? null);
        return;
      }
      case "select": {
        const hit = topAnnot(p, (a) => MOVABLE.has(a.type));
        if (hit) {
          select(hit);
          capture();
          setDrag({ kind: "move", annot: hit, start: p, current: p });
          return;
        }
        select(null);
        const link = links.find((l) => rectContains(l.rect, p));
        if (link) {
          if (link.page !== null) goToPage(link.page);
          else if (link.uri) api().openExternal(link.uri);
          return;
        }
        updateTab(tab.key, { textSelection: null });
        capture();
        setDrag({ kind: "text", start: p, current: p, markup: null });
        return;
      }
      case "highlight":
      case "underline":
      case "strikeout":
        capture();
        setDrag({ kind: "text", start: p, current: p, markup: MARKUP[tool] });
        return;
      case "ink":
        capture();
        setDrag({ kind: "ink", points: [p] });
        return;
      case "note": {
        const text = await prompt({ title: "新增便利貼", message: "輸入備註內容：", multiline: true });
        if (text !== null) await mutate("無法新增便利貼", () => engine.addNote(engineId, pageIndex, p, text, rgb));
        return;
      }
      case "textbox": {
        const result = await textBoxDialog({ title: "新增文字", settings: { choice: lastTextBoxChoice(), bold: false, italic: false, size: fontSize, color } });
        if (result) {
          await mutate("無法新增文字", () =>
            engine.addFreeText(engineId, pageIndex, p, result.text, textBoxStyle(result.settings), fontData(result.font), fontData(result.fallback)),
          );
        }
        return;
      }
      case "image":
      case "signature": {
        if (pendingImage) {
          await placeImage(p, pendingImage.data, pendingImage.width, pendingImage.height, pendingImage.isSignature);
          setState({ pendingImage: null });
          selectTool("select");
        } else if (tool === "signature") {
          await openSignatures();
        } else {
          const [file] = await api().openFiles("images", false, "選擇要插入的圖片");
          if (file) {
            const [w, h] = await engine.imageSize(file.data);
            await placeImage(p, file.data, w, h, false);
            selectTool("select");
          }
        }
        return;
      }
      case "eraser": {
        const hit = topAnnot(p, () => true);
        if (hit) await mutate("無法刪除註解", () => engine.deleteAnnotation(engineId, pageIndex, hit.id));
        return;
      }
      default:
        if (SHAPES[tool]) {
          capture();
          setDrag({ kind: "shape", shape: SHAPES[tool], start: p, current: p });
        }
    }
  };

  const placeImage = async (p: Point, data: Uint8Array, w: number, h: number, isSignature: boolean) => {
    const targetWidth = isSignature ? 160 : 220;
    let size: Point = [targetWidth, (targetWidth * h) / Math.max(w, 1)];
    const maxH = info.height * 0.8;
    if (size[1] > maxH) size = [(maxH * w) / h, maxH];
    const rect: Rect = [p[0] - size[0] / 2, p[1] - size[1] / 2, p[0] + size[0] / 2, p[1] + size[1] / 2];
    await mutate("無法插入圖片", () => engine.addImage(engineId, pageIndex, rect, data, isSignature));
  };

  const lastSelect = useRef(0);
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = toPage(e);
    switch (drag.kind) {
      case "move":
      case "shape":
        setDrag({ ...drag, current: p });
        break;
      case "ink":
        setDrag({ ...drag, points: [...drag.points, p] });
        break;
      case "text": {
        setDrag({ ...drag, current: p });
        const now = performance.now();
        if (now - lastSelect.current > 60) {
          lastSelect.current = now;
          updateSelection(drag.start, p, drag.markup);
        }
      }
    }
  };

  const onPointerUp = async (e: React.PointerEvent) => {
    if (!drag) return;
    const current = drag;
    setDrag(null);
    const p = toPage(e);
    switch (current.kind) {
      case "move": {
        const dx = p[0] - current.start[0];
        const dy = p[1] - current.start[1];
        if (Math.hypot(dx, dy) * scale > 2) await mutate("無法移動註解", () => engine.moveAnnotation(engineId, pageIndex, current.annot.id, dx, dy));
        return;
      }
      case "text": {
        if (Math.hypot(p[0] - current.start[0], p[1] - current.start[1]) * scale < 3) {
          updateTab(tab.key, { textSelection: null });
          return;
        }
        const { selection } = await updateSelection(current.start, p, current.markup);
        if (current.markup && selection.quads.length) {
          updateTab(tab.key, { textSelection: null });
          await mutate("無法加入標記", () => engine.addMarkup(engineId, pageIndex, current.markup!, selection.quads as Quad[], rgb, selection.text));
        }
        return;
      }
      case "ink":
        if (current.points.length > 1) await mutate("無法加入手繪", () => engine.addInk(engineId, pageIndex, [current.points], rgb, lineWidth));
        return;
      case "shape":
        if (Math.hypot(p[0] - current.start[0], p[1] - current.start[1]) * scale > 4) {
          await mutate("無法加入圖形", () => engine.addShape(engineId, pageIndex, current.shape, current.start, p, rgb, lineWidth, fillShapes));
        }
    }
  };

  const onDoubleClick = async (e: React.MouseEvent) => {
    if (tool !== "select") return;
    const hit = topAnnot(toPage(e), (a) => a.type === "FreeText" || a.type === "Text");
    if (!hit) return;
    if (hit.type === "FreeText") {
      const style = hit.textStyle;
      const family = style?.family;
      const choice: FontChoice = family ? { kind: downloadableFamilies.includes(family) ? "download" : "system", family } : lastTextBoxChoice();
      const result = await textBoxDialog({
        title: "編輯文字",
        text: hit.contents,
        settings: { choice, bold: style?.bold ?? false, italic: style?.italic ?? false, size: style?.fontSize ?? fontSize, color: rgbToHex(style?.color ?? [0, 0, 0]) },
      });
      if (result) {
        await mutate("無法編輯文字", () =>
          engine.updateFreeText(engineId, pageIndex, hit.id, result.text, textBoxStyle(result.settings), fontData(result.font), fontData(result.fallback)),
        );
      }
      return;
    }
    const text = await prompt({ title: "編輯備註", initial: hit.contents, multiline: true });
    if (text !== null) await mutate("無法編輯文字", () => engine.setContents(engineId, pageIndex, hit.id, text));
  };

  const selected = tab.selectedAnnot?.page === pageIndex ? annots.find((a) => a.id === tab.selectedAnnot!.id) : undefined;
  const hits = tab.searchHits.map((hit, index) => ({ hit, index })).filter(({ hit }) => hit.page === pageIndex);
  const textSelection = tab.textSelection?.page === pageIndex ? tab.textSelection : null;
  const hover = tool === "edittext" ? "text" : tool === "select" ? "default" : tool === "eraser" ? "not-allowed" : ["highlight", "underline", "strikeout"].includes(tool) ? "text" : "crosshair";

  return (
    <div className="page" style={{ width, height }}>
      <canvas ref={canvasRef} className="page-canvas" style={{ width, height }} />
      {!loaded && <div className="page-loading">載入中…</div>}
      <div
        ref={overlayRef}
        className="page-overlay"
        style={{ cursor: hover }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
      >
        <svg width={width} height={height} className="page-svg">
          {hits.map(({ hit, index }) =>
            hit.quads.map((q, k) => <polygon key={`${index}-${k}`} points={quadPoints(q, scale)} className={index === tab.searchIndex ? "search-hit current" : "search-hit"} />),
          )}
          {textSelection?.quads.map((q, k) => <polygon key={k} points={quadPoints(q, scale)} className="text-selection" />)}
          {tool === "select" && links.map((l, k) => <rect key={k} {...rectAttrs(l.rect, scale)} className="link-area" />)}
          {selected && <rect {...rectAttrs(inflate(selected.rect, 2), scale)} className="annot-selected" />}
          {drag?.kind === "move" && (
            <rect
              {...rectAttrs(
                [
                  drag.annot.rect[0] + drag.current[0] - drag.start[0],
                  drag.annot.rect[1] + drag.current[1] - drag.start[1],
                  drag.annot.rect[2] + drag.current[0] - drag.start[0],
                  drag.annot.rect[3] + drag.current[1] - drag.start[1],
                ],
                scale,
              )}
              className="annot-moving"
            />
          )}
          {drag?.kind === "ink" && (
            <polyline points={drag.points.map(([x, y]) => `${x * scale},${y * scale}`).join(" ")} fill="none" stroke={color} strokeWidth={lineWidth * scale} strokeLinecap="round" strokeLinejoin="round" />
          )}
          {drag?.kind === "shape" && <ShapePreview drag={drag} scale={scale} color={color} lineWidth={lineWidth} fill={fillShapes} />}
        </svg>
        {tool === "select" && widgets.map((w) => <WidgetField key={w.id} widget={w} scale={scale} tab={tab} />)}
        {tool === "edittext" &&
          textLines.map((line) => (
            <div key={line.index} className="edit-line" style={boxStyle(line.bbox, scale)} title={`${line.fontName} ${line.size}pt`} />
          ))}
        {editingLine && (
          <InlineTextEditor
            key={`${revision}-${editingLine.index}`}
            line={editingLine}
            scale={scale}
            engineId={engineId}
            pageIndex={pageIndex}
            onDone={async (edit) => {
              setEditingLine(null);
              if (!edit) return;
              let result: ReplaceResult | undefined;
              await mutate("無法修改文字", async () => {
                result = await engine.replaceTextLine(engineId, pageIndex, editingLine.index, edit.text, {
                  override: edit.override,
                  font: fontData(edit.font),
                  fallbackFont: fontData(edit.fallback),
                  forceFont: edit.forceFont,
                });
              });
              if (result) toast(replaceMessage(result, edit.font));
            }}
          />
        )}
      </div>
    </div>
  );
}

function textBoxStyle(settings: FontSettings): TextBoxStyle {
  return {
    fontSize: settings.size,
    color: hexToRgb(settings.color),
    family: settings.choice.kind === "auto" ? undefined : settings.choice.family,
    bold: settings.bold,
    italic: settings.italic,
  };
}

function quadPoints(q: Quad, scale: number): string {
  // MuPDF 四邊形順序：ul, ur, ll, lr
  const pts = [[q[0], q[1]], [q[2], q[3]], [q[6], q[7]], [q[4], q[5]]];
  return pts.map(([x, y]) => `${x * scale},${y * scale}`).join(" ");
}

function rectAttrs([x0, y0, x1, y1]: Rect, scale: number) {
  return { x: x0 * scale, y: y0 * scale, width: Math.max(1, (x1 - x0) * scale), height: Math.max(1, (y1 - y0) * scale) };
}

function ShapePreview({ drag, scale, color, lineWidth, fill }: { drag: Extract<Drag, { kind: "shape" }>; scale: number; color: string; lineWidth: number; fill: boolean }) {
  const [x0, y0, x1, y1] = normalizeRect(drag.start, drag.current).map((v) => v * scale);
  const stroke = drag.shape === "whiteout" ? "#999" : drag.shape === "redact" ? "#e03131" : color;
  const common = { stroke, strokeWidth: Math.max(1, lineWidth * scale), fill: "none" as string };
  switch (drag.shape) {
    case "line":
    case "arrow":
      return <line x1={drag.start[0] * scale} y1={drag.start[1] * scale} x2={drag.current[0] * scale} y2={drag.current[1] * scale} {...common} />;
    case "circle":
      return <ellipse cx={(x0 + x1) / 2} cy={(y0 + y1) / 2} rx={(x1 - x0) / 2} ry={(y1 - y0) / 2} {...common} fill={fill ? color : "none"} fillOpacity={0.35} />;
    case "whiteout":
      return <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill="#fff" stroke="#999" strokeDasharray="4 3" />;
    case "redact":
      return <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill="rgba(224,49,49,0.25)" stroke="#e03131" strokeDasharray="4 3" />;
    default:
      return <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} {...common} fill={fill ? color : "none"} fillOpacity={0.35} />;
  }
}

/** 表單欄位：在頁面上覆蓋可輸入的控制項。 */
function WidgetField({ widget, scale, tab }: { widget: WidgetInfo; scale: number; tab: DocTab }) {
  const [value, setValue] = useState(widget.value);
  useEffect(() => setValue(widget.value), [widget.value]);
  const [x0, y0, x1, y1] = widget.rect;
  const style: React.CSSProperties = { left: x0 * scale, top: y0 * scale, width: (x1 - x0) * scale, height: (y1 - y0) * scale };
  const commit = async (next: string | null) => {
    await mutate("無法填寫表單", () => engine.setWidgetValue(tab.engineId, widget.page, widget.id, next));
  };
  if (widget.readOnly || widget.kind === "button" || widget.kind === "signature" || widget.kind === "unknown") return null;
  const stop = (e: React.PointerEvent) => e.stopPropagation();

  if (widget.kind === "checkbox" || widget.kind === "radio") {
    return <button className="widget widget-toggle" style={style} title={widget.name} onPointerDown={stop} onClick={() => commit(null)} />;
  }
  if (widget.kind === "combobox" || widget.kind === "listbox") {
    return (
      <select className="widget" style={{ ...style, fontSize: Math.min(14, (y1 - y0) * scale * 0.6) }} value={value} title={widget.name} onPointerDown={stop} onChange={(e) => commit(e.target.value)}>
        {!widget.options.includes(value) && <option value={value}>{value}</option>}
        {widget.options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    );
  }
  const props = {
    className: "widget widget-text",
    style: { ...style, fontSize: Math.max(8, Math.min(16 * scale, (y1 - y0) * scale * 0.65)) },
    value,
    title: widget.name,
    onPointerDown: stop,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValue(e.target.value),
    onBlur: () => value !== widget.value && commit(value),
  };
  return widget.multiline ? <textarea {...props} /> : <input {...props} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />;
}

function boxStyle([x0, y0, x1, y1]: Rect, scale: number): React.CSSProperties {
  return { left: x0 * scale, top: y0 * scale, width: (x1 - x0) * scale, height: (y1 - y0) * scale };
}

function replaceMessage(result: ReplaceResult, font: ResolvedFont | null): string {
  switch (result.font) {
    case "embedded":
      return "已修改文字（沿用原檔字型）";
    case "supplied":
      return `已修改文字（字型：${font?.name ?? ""}）`;
    case "mixed":
      return `已修改文字（字型：${font?.name ?? ""}，缺少的字元以標準字型補上）`;
    default:
      return "已修改文字（使用標準字型）";
  }
}

type FontStatus =
  | { state: "resolving"; family: string }
  | { state: "resolved"; font: ResolvedFont; family: string }
  | { state: "missing"; family: string };

interface InlineEdit {
  text: string;
  override: { size?: number; color?: [number, number, number]; bold?: boolean; italic?: boolean };
  font: ResolvedFont | null;
  fallback: ResolvedFont | null;
  forceFont: boolean;
}

/**
 * 在原文位置直接輸入新文字。上方工具列可選字型（預設「自動」：先辨識原字型、在電腦上尋找或自動下載）、
 * 粗體、斜體、字級與顏色；下方顯示字型辨識結果。
 */
function InlineTextEditor({ line, scale, engineId, pageIndex, onDone }: {
  line: TextLine;
  scale: number;
  engineId: number;
  pageIndex: number;
  onDone: (edit: InlineEdit | null) => void;
}) {
  const initial: FontSettings = { choice: AUTO_FONT, bold: line.bold, italic: line.italic, size: line.size, color: rgbToHex(line.color) };
  const [value, setValue] = useState(line.text);
  const [settings, setSettings] = useState<FontSettings>(initial);
  const [autoName, setAutoName] = useState(line.ocr ? "掃描影像中的文字" : line.fontName || "原字型");
  const [status, setStatus] = useState<FontStatus>({ state: "resolving", family: line.fontName });
  const [cssFamily, setCssFamily] = useState<string | null>(null);
  const finished = useRef(false);
  const committing = useRef(false);
  const autoRequest = useRef<Promise<FontRequest | null> | null>(null);
  const fontPromise = useRef<ReturnType<typeof resolveChoice>>(Promise.resolve({ font: null, request: null }));
  const ref = useRef<HTMLInputElement>(null);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  useEffect(() => {
    let cancelled = false;
    autoRequest.current ??= engine.fontRequest(engineId, pageIndex, line.index).catch(() => null);
    const promise = (async () => {
      const request = settings.choice.kind === "auto" ? await autoRequest.current : null;
      const label = settings.choice.kind === "auto" ? request?.originalName ?? line.fontName : settings.choice.family;
      if (!cancelled) {
        if (request) setAutoName(request.originalName);
        setStatus({ state: "resolving", family: label });
      }
      const resolved = await resolveChoice(settings.choice, settings.bold, settings.italic, request);
      if (!cancelled) {
        setStatus(resolved.font ? { state: "resolved", font: resolved.font, family: label } : { state: "missing", family: label });
        setCssFamily(await previewFamily(resolved.font));
      }
      return resolved;
    })();
    fontPromise.current = promise;
    return () => {
      cancelled = true;
    };
  }, [engineId, pageIndex, line.index, line.fontName, settings.choice, settings.bold, settings.italic]);

  const finish = async (commit: boolean) => {
    if (finished.current || committing.current) return;
    const styleChanged = settings.size !== initial.size || settings.color !== initial.color || settings.bold !== initial.bold || settings.italic !== initial.italic;
    if (!commit || (value === line.text && !styleChanged && settings.choice.kind === "auto")) {
      finished.current = true;
      onDone(null);
      return;
    }
    committing.current = true;
    const { font, request } = await fontPromise.current.catch(() => ({ font: null, request: null }));
    const fallback = await resolveFallback(request, value);
    finished.current = true;
    const override: InlineEdit["override"] = {};
    if (settings.size !== initial.size) override.size = settings.size;
    if (settings.color !== initial.color || line.ocr) override.color = hexToRgb(settings.color);
    if (settings.bold !== initial.bold) override.bold = settings.bold;
    if (settings.italic !== initial.italic) override.italic = settings.italic;
    onDone({ text: value, override, font, fallback, forceFont: settings.choice.kind !== "auto" });
  };

  const [x0, y0, x1, y1] = line.bbox;
  const fontSize = settings.size * scale;
  const fallbackFamily = line.mono ? '"Courier New", monospace' : line.serif ? '"Times New Roman", "PMingLiU", "MingLiU", serif' : 'Arial, "Microsoft JhengHei", sans-serif';
  const family = cssFamily ? `"${cssFamily}", ${fallbackFamily}` : fallbackFamily;
  const width = Math.max((x1 - x0) * scale, value.length * fontSize * 0.62) + fontSize;
  const height = Math.max((y1 - y0) * scale, fontSize * 1.2) + 4;
  const statusText =
    status.state === "resolving"
      ? `正在尋找字型「${status.family}」…`
      : status.state === "resolved"
        ? settings.choice.kind === "auto" && !status.font.exact
          ? `找不到「${status.family}」，改用相近字型：${describeFont(status.font)}`
          : `字型：${describeFont(status.font)}`
        : `找不到字型「${status.family}」，將使用標準字型`;
  return (
    <div
      ref={container}
      className="inline-text-edit"
      style={{ left: x0 * scale - 3, top: y0 * scale - 2 }}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={(e) => {
        // 焦點移到工具列（字型選單等）時不要結束編輯
        if (!container.current?.contains(e.relatedTarget as Node | null)) finish(true);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") finish(false);
      }}
    >
      <div className={y0 * scale < 48 ? "inline-text-toolbar below" : "inline-text-toolbar"}>
        <FontControls value={settings} onChange={setSettings} autoLabel={autoName} compact />
        <button type="button" className="primary" title="套用 (Enter)" onClick={() => finish(true)}>
          套用
        </button>
        <button type="button" title="取消 (Esc)" onClick={() => finish(false)}>
          取消
        </button>
      </div>
      <input
        ref={ref}
        className="inline-text-editor"
        value={value}
        spellCheck={false}
        style={{
          width,
          height,
          fontSize,
          fontFamily: family,
          fontWeight: cssFamily ? undefined : settings.bold ? 700 : 400,
          fontStyle: cssFamily ? undefined : settings.italic ? "italic" : "normal",
          color: settings.color,
        }}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") finish(true);
          else if (e.key === "Escape") finish(false);
        }}
      />
      <div className="inline-text-status">
        {!line.textReliable && <div className="warning">⚠ 原文無法正確辨識（PDF 缺少字元對照表），請重新輸入整行文字</div>}
        {line.ocr && <div>這一行是 OCR 辨識出的掃描文字：套用後會把影像中的原字改成背景色，再寫入新文字</div>}
        {line.embeddedFont && settings.choice.kind === "auto" && <div>原檔內嵌字型「{line.fontName}」，字形足夠時會直接沿用</div>}
        <div>{statusText}</div>
      </div>
    </div>
  );
}
