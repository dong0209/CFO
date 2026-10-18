import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { engine } from "../lib/engine";
import { type DocTab, setState, useStore } from "../state/store";
import { Icon } from "./Icon";

/** 並排比較兩份開啟中的文件（唯讀）。可選擇同步捲動。 */
export function Compare() {
  const tabs = useStore((s) => s.tabs);
  const activeKey = useStore((s) => s.activeKey);
  const [leftKey, setLeftKey] = useState<string>(() => activeKey ?? tabs[0]?.key ?? "");
  const [rightKey, setRightKey] = useState<string>(() => tabs.find((t) => t.key !== (activeKey ?? tabs[0]?.key))?.key ?? tabs[1]?.key ?? tabs[0]?.key ?? "");
  const [sync, setSync] = useState(false);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  const left = tabs.find((t) => t.key === leftKey) ?? null;
  const right = tabs.find((t) => t.key === rightKey) ?? null;

  const close = () => setState({ compare: false });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 同步捲動：以捲動比例對應另一側
  const linkScroll = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (!sync || !from || !to || syncing.current) return;
    syncing.current = true;
    const range = from.scrollHeight - from.clientHeight;
    const fraction = range > 0 ? from.scrollTop / range : 0;
    to.scrollTop = fraction * (to.scrollHeight - to.clientHeight);
    requestAnimationFrame(() => {
      syncing.current = false;
    });
  };

  return (
    <div className="compare" role="dialog" aria-label="並排比較">
      <header className="compare-top">
        <strong>並排比較</strong>
        <select value={leftKey} onChange={(e) => setLeftKey(e.target.value)} aria-label="左側文件">
          {tabs.map((t) => (
            <option key={t.key} value={t.key}>{t.name}</option>
          ))}
        </select>
        <span className="compare-vs">↔</span>
        <select value={rightKey} onChange={(e) => setRightKey(e.target.value)} aria-label="右側文件">
          {tabs.map((t) => (
            <option key={t.key} value={t.key}>{t.name}</option>
          ))}
        </select>
        <label className="check compare-sync">
          <input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} /> 同步捲動
        </label>
        <span className="spacer" />
        <button className="icon-button" title="關閉 (Esc)" aria-label="關閉" onClick={close}>
          <Icon name="close" />
        </button>
      </header>
      <div className="compare-body">
        <ComparePane tab={left} scrollRef={leftRef} onScroll={() => linkScroll(leftRef.current, rightRef.current)} />
        <div className="compare-divider" />
        <ComparePane tab={right} scrollRef={rightRef} onScroll={() => linkScroll(rightRef.current, leftRef.current)} />
      </div>
    </div>
  );
}

function ComparePane({ tab, scrollRef, onScroll }: { tab: DocTab | null; scrollRef: React.RefObject<HTMLDivElement | null>; onScroll: () => void }) {
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!tab) return <div className="compare-pane empty" ref={scrollRef} />;
  const pageWidth = Math.max(80, width - 48);
  return (
    <div className="compare-pane" ref={scrollRef} onScroll={onScroll}>
      {tab.info.pages.map((info, page) => (
        <ComparePage key={page} tab={tab} page={page} width={Math.min(pageWidth, info.width * 2)} ratio={info.height / info.width} />
      ))}
    </div>
  );
}

function ComparePage({ tab, page, width, ratio }: { tab: DocTab; page: number; width: number; ratio: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && setVisible(true), { rootMargin: "600px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const info = tab.info.pages[page];
    const scale = (width * (window.devicePixelRatio || 1)) / info.width;
    engine
      .render(tab.engineId, page, scale)
      .then((result) => {
        const canvas = ref.current;
        if (cancelled || !canvas) return;
        canvas.width = result.width;
        canvas.height = result.height;
        canvas.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(result.pixels), result.width, result.height), 0, 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [visible, tab.engineId, tab.revision, page, width, tab.info.pages]);

  return (
    <div className="compare-page">
      <canvas ref={ref} style={{ width, height: width * ratio }} />
      <span className="compare-page-num muted small">{page + 1}</span>
    </div>
  );
}
