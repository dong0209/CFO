import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { setZoom } from "../state/actions";
import { type DocTab, updateTab } from "../state/store";
import { PageView } from "./PageView";

/** 100% 縮放時 1pt 對應的 CSS 像素。 */
export const PT_TO_PX = 96 / 72;
const GAP = 16;
const PADDING = 24;

interface Row {
  pages: number[];
  top: number;
  height: number;
  width: number;
}

export function Viewer({ tab }: { tab: DocTab }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [scrollTop, setScrollTop] = useState(0);
  const { pages } = tab.info;
  const twoUp = tab.layout === "twoUp";

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    observer.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => observer.disconnect();
  }, []);

  // 符合寬度／頁面時由容器大小計算縮放
  const scale = useMemo(() => {
    if (!tab.fit || pages.length === 0) return tab.zoom * PT_TO_PX;
    const maxWidth = Math.max(...pages.map((p) => p.width)) * (twoUp ? 2 : 1) + (twoUp ? GAP : 0);
    const byWidth = (size.width - PADDING * 2) / maxWidth;
    if (tab.fit === "width") return Math.max(0.05, byWidth);
    const current = pages[tab.currentPage] ?? pages[0];
    return Math.max(0.05, Math.min(byWidth, (size.height - PADDING * 2) / current.height));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.fit, tab.zoom, pages, twoUp, size.width, size.height]);

  useEffect(() => {
    const zoom = scale / PT_TO_PX;
    if (tab.fit && Math.abs(zoom - tab.zoom) > 0.001) updateTab(tab.key, { zoom });
  }, [scale, tab.fit, tab.zoom, tab.key]);

  const rows = useMemo<Row[]>(() => {
    const result: Row[] = [];
    let top = PADDING;
    const step = twoUp ? 2 : 1;
    for (let i = 0; i < pages.length; i += step) {
      const group = twoUp ? [i, i + 1].filter((p) => p < pages.length) : [i];
      const height = Math.max(...group.map((p) => pages[p].height * scale));
      const width = group.reduce((sum, p) => sum + pages[p].width * scale, 0) + (group.length - 1) * GAP;
      result.push({ pages: group, top, height, width });
      top += height + GAP;
    }
    return result;
  }, [pages, scale, twoUp]);

  const totalHeight = rows.length ? rows[rows.length - 1].top + rows[rows.length - 1].height + PADDING : 0;
  const contentWidth = Math.max(size.width, ...rows.map((r) => r.width + PADDING * 2));

  // 縮放時維持目前閱讀位置
  const previousScale = useRef(scale);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || previousScale.current === scale) return;
    const ratio = scale / previousScale.current;
    const centerY = el.scrollTop + el.clientHeight / 2;
    el.scrollTop = (centerY - PADDING) * ratio + PADDING - el.clientHeight / 2;
    previousScale.current = scale;
    setScrollTop(el.scrollTop);
  }, [scale]);

  // 捲動到指定頁面
  useLayoutEffect(() => {
    const request = tab.scrollRequest;
    const el = scrollRef.current;
    if (!request || !el) return;
    const row = rows.find((r) => r.pages.includes(request.page));
    if (!row) return;
    const offset = request.y !== undefined ? Math.max(0, request.y * scale - el.clientHeight / 3) : -8;
    el.scrollTop = row.top + offset;
    setScrollTop(el.scrollTop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.scrollRequest?.nonce]);

  // 更新目前頁面
  const lastReported = useRef(tab.currentPage);
  useEffect(() => {
    const center = scrollTop + size.height / 3;
    const row = rows.find((r) => center >= r.top - GAP && center <= r.top + r.height) ?? (center < PADDING ? rows[0] : rows[rows.length - 1]);
    if (!row) return;
    const page = row.pages[0];
    if (page !== lastReported.current) {
      lastReported.current = page;
      updateTab(tab.key, { currentPage: page });
    }
  }, [scrollTop, rows, size.height, tab.key]);

  useEffect(() => {
    lastReported.current = tab.currentPage;
  }, [tab.currentPage]);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom((scale / PT_TO_PX) * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    },
    [scale],
  );

  // React 的 wheel 事件是 passive，需自行註冊才能阻止瀏覽器縮放
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  const visibleTop = scrollTop - size.height;
  const visibleBottom = scrollTop + size.height * 2;

  return (
    <div className="viewer" ref={scrollRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} onWheel={onWheel}>
      <div className="viewer-content" style={{ height: totalHeight, width: contentWidth }}>
        {rows.map((row) => {
          const visible = row.top + row.height >= visibleTop && row.top <= visibleBottom;
          let left = (contentWidth - row.width) / 2;
          return row.pages.map((page) => {
            const info = pages[page];
            const style = { top: row.top + (row.height - info.height * scale) / 2, left, width: info.width * scale, height: info.height * scale };
            left += info.width * scale + GAP;
            return (
              <div key={page} className="page-slot" style={style} data-page={page}>
                {visible ? <PageView tab={tab} pageIndex={page} scale={scale} /> : <div className="page-placeholder" />}
              </div>
            );
          });
        })}
      </div>
    </div>
  );
}
