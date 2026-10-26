import { useEffect, useRef, useState } from "react";
import type { AnnotInfo, OutlineNode } from "../engine/types";
import { engine } from "../lib/engine";
import {
  addBookmark, deletePages, duplicatePages, extractPages, goToPage, insertBlank, insertFromFile,
  movePages, mutate, nextHit, rotatePages, search, targetPages,
} from "../state/actions";
import { type DocTab, type SidebarTab, rgbToHex, setState, updateTab, useStore } from "../state/store";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Icon } from "./Icon";
import { prompt } from "./Modal";
import { openDialog } from "./dialogs/openDialog";

const TABS: Array<{ id: SidebarTab; title: string; icon: string }> = [
  { id: "thumbnails", title: "縮圖", icon: "pages" },
  { id: "outline", title: "書籤", icon: "bookmark" },
  { id: "annotations", title: "註解", icon: "comment" },
  { id: "search", title: "搜尋", icon: "search" },
];

export function Sidebar({ tab }: { tab: DocTab }) {
  const current = useStore((s) => s.sidebarTab);
  return (
    <aside className="sidebar">
      <div className="sidebar-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={current === t.id} className={current === t.id ? "active" : ""} title={t.title} onClick={() => setState({ sidebarTab: t.id })}>
            <Icon name={t.icon} />
            <span>{t.title}</span>
          </button>
        ))}
      </div>
      {current === "thumbnails" && <Thumbnails tab={tab} />}
      {current === "outline" && <Outline tab={tab} />}
      {current === "annotations" && <Annotations tab={tab} />}
      {current === "search" && <Search tab={tab} />}
    </aside>
  );
}

// MARK: - 縮圖

function Thumbnails({ tab }: { tab: DocTab }) {
  const [menu, setMenu] = useState<{ x: number; y: number; page: number } | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<number | null>(null);
  const selected = new Set(tab.selectedPages);

  useEffect(() => {
    listRef.current?.querySelector(`[data-thumb="${tab.currentPage}"]`)?.scrollIntoView({ block: "nearest" });
  }, [tab.currentPage]);

  const click = (e: React.MouseEvent, page: number) => {
    let pages: number[];
    if (e.shiftKey && anchor.current !== null) {
      const [a, b] = [Math.min(anchor.current, page), Math.max(anchor.current, page)];
      pages = Array.from({ length: b - a + 1 }, (_, i) => a + i);
    } else if (e.ctrlKey || e.metaKey) {
      pages = selected.has(page) ? tab.selectedPages.filter((p) => p !== page) : [...tab.selectedPages, page];
      anchor.current = page;
    } else {
      pages = [];
      anchor.current = page;
    }
    updateTab(tab.key, { selectedPages: pages });
    goToPage(page);
  };

  const menuTargets = (page: number) => (selected.has(page) ? targetPages(tab) : [page]);
  const menuItems = (page: number): MenuItem[] => {
    const pages = menuTargets(page);
    return [
      { label: "向右旋轉", action: () => rotatePages(pages, 90) },
      { label: "向左旋轉", action: () => rotatePages(pages, -90) },
      "separator",
      { label: "在後方插入空白頁", action: () => insertBlank(page) },
      { label: "在後方插入其他 PDF…", action: () => insertFromFile(page) },
      { label: "複製頁面", action: () => duplicatePages(pages) },
      { label: "擷取為新 PDF…", action: () => extractPages(pages) },
      { label: "匯出為圖片…", action: () => openDialog("export-images") },
      "separator",
      { label: pages.length > 1 ? `刪除 ${pages.length} 頁` : "刪除頁面", danger: true, action: () => deletePages(pages) },
    ];
  };

  return (
    <div className="sidebar-panel">
      <div
        className="thumbnails"
        ref={listRef}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const source = JSON.parse(e.dataTransfer.getData("application/x-pages") || "[]") as number[];
          if (source.length && dropIndex !== null) movePages(source, dropIndex);
          setDropIndex(null);
        }}
      >
        {tab.info.pages.map((info, page) => (
          <div
            key={page}
            data-thumb={page}
            className={`thumb ${page === tab.currentPage ? "current" : ""} ${selected.has(page) ? "selected" : ""} ${dropIndex === page ? "drop-before" : ""} ${dropIndex === page + 1 && page === tab.info.pageCount - 1 ? "drop-after" : ""}`}
            draggable
            onDragStart={(e) => {
              const pages = selected.has(page) ? targetPages(tab) : [page];
              e.dataTransfer.setData("application/x-pages", JSON.stringify(pages));
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setDropIndex(e.clientY < rect.top + rect.height / 2 ? page : page + 1);
            }}
            onDragEnd={() => setDropIndex(null)}
            onClick={(e) => click(e, page)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, page });
            }}
          >
            <Thumbnail tab={tab} page={page} ratio={info.height / info.width} />
            <span className="thumb-label">{page + 1}</span>
          </div>
        ))}
      </div>
      <div className="panel-footer">
        <button title="插入空白頁" onClick={() => insertBlank(Math.max(...targetPages(tab)))}>
          <Icon name="plus" />
        </button>
        <button title="刪除頁面" onClick={() => deletePages(targetPages(tab))}>
          <Icon name="trash" />
        </button>
        <button title="向右旋轉" onClick={() => rotatePages(targetPages(tab), 90)}>
          <Icon name="rotate-right" />
        </button>
        <span className="spacer" />
        <span className="muted small">{tab.selectedPages.length ? `已選 ${tab.selectedPages.length} 頁` : `共 ${tab.info.pageCount} 頁`}</span>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.page)} onClose={() => setMenu(null)} />}
    </div>
  );
}

const THUMB_WIDTH = 132;

function Thumbnail({ tab, page, ratio }: { tab: DocTab; page: number; ratio: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "400px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const info = tab.info.pages[page];
    const scale = (THUMB_WIDTH * (window.devicePixelRatio || 1)) / info.width;
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
  }, [visible, tab.engineId, tab.revision, page, tab.info.pages]);

  return <canvas ref={ref} className="thumb-canvas" style={{ width: THUMB_WIDTH, height: THUMB_WIDTH * ratio }} />;
}

// MARK: - 書籤

function Outline({ tab }: { tab: DocTab }) {
  const [menu, setMenu] = useState<{ x: number; y: number; path: number[]; node: OutlineNode } | null>(null);
  const render = (nodes: OutlineNode[], parent: number[]) => (
    <ul className="outline">
      {nodes.map((node, i) => {
        const path = [...parent, i];
        return (
          <li key={path.join("-")}>
            <OutlineRow node={node} tab={tab} onMenu={(x, y) => setMenu({ x, y, path, node })} />
            {node.children.length > 0 && render(node.children, path)}
          </li>
        );
      })}
    </ul>
  );
  return (
    <div className="sidebar-panel">
      <div className="panel-scroll">
        {tab.info.outline.length ? render(tab.info.outline, []) : <Empty icon="bookmark" text="這份文件沒有書籤" />}
      </div>
      <div className="panel-footer">
        <button onClick={addBookmark}>
          <Icon name="bookmark" /> 為目前頁面新增書籤
        </button>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: "重新命名…",
              action: async () => {
                const title = await prompt({ title: "重新命名書籤", initial: menu.node.title });
                if (title) await mutate("無法重新命名", (t) => engine.renameBookmark(t.engineId, menu.path, title));
              },
            },
            { label: "刪除", danger: true, action: () => mutate("無法刪除書籤", (t) => engine.deleteBookmark(t.engineId, menu.path)) },
          ]}
        />
      )}
    </div>
  );
}

function OutlineRow({ node, tab, onMenu }: { node: OutlineNode; tab: DocTab; onMenu: (x: number, y: number) => void }) {
  return (
    <button
      className={`outline-row ${node.page === tab.currentPage ? "current" : ""}`}
      onClick={() => node.page !== null && goToPage(node.page)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <span className="outline-title">{node.title || "（未命名）"}</span>
      {node.page !== null && <span className="muted small">{node.page + 1}</span>}
    </button>
  );
}

// MARK: - 註解清單

const TYPE_NAMES: Record<string, string> = {
  Highlight: "螢光筆", Underline: "底線", StrikeOut: "刪除線", Squiggly: "波浪線", Text: "便利貼", FreeText: "文字",
  Ink: "手繪", Square: "矩形", Circle: "橢圓", Line: "直線", Stamp: "圖章", Redact: "待套用遮蓋", Polygon: "多邊形", PolyLine: "折線",
  FileAttachment: "附件", Caret: "插入符號",
};

export function annotationLabel(a: AnnotInfo): string {
  if (a.role === "whiteout") return "白底遮蓋";
  if (a.role === "signature") return "簽名";
  if (a.role === "image") return "圖片";
  if (a.type === "Line" && a.lineEnd && a.lineEnd !== "None") return "箭頭";
  return TYPE_NAMES[a.type] ?? a.type;
}

function Annotations({ tab }: { tab: DocTab }) {
  const [items, setItems] = useState<AnnotInfo[]>([]);
  useEffect(() => {
    engine.allAnnotations(tab.engineId).then(setItems).catch(() => setItems([]));
  }, [tab.engineId, tab.revision]);
  if (!items.length) return <Empty icon="comment" text="尚無註解" />;
  return (
    <div className="sidebar-panel">
      <div className="panel-scroll">
        {items.map((a) => (
          <div
            key={`${a.page}-${a.id}`}
            className={`annot-row ${tab.selectedAnnot?.id === a.id ? "selected" : ""}`}
            onClick={() => {
              updateTab(tab.key, { selectedAnnot: { page: a.page, id: a.id } });
              goToPage(a.page, a.rect[1]);
            }}
          >
            <span className="swatch" style={{ background: a.color.length ? rgbToHex(a.color) : "transparent" }} />
            <div className="annot-text">
              <strong>{annotationLabel(a)}</strong>
              {a.contents && <p>{a.contents}</p>}
              <span className="muted small">第 {a.page + 1} 頁</span>
            </div>
            <button
              className="icon-button"
              title="刪除註解"
              onClick={(e) => {
                e.stopPropagation();
                mutate("無法刪除註解", (t) => engine.deleteAnnotation(t.engineId, a.page, a.id));
              }}
            >
              <Icon name="trash" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// MARK: - 搜尋

function Search({ tab }: { tab: DocTab }) {
  const [query, setQuery] = useState(tab.searchQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  return (
    <div className="sidebar-panel">
      <form
        className="search-box"
        onSubmit={(e) => {
          e.preventDefault();
          search(query);
        }}
      >
        <input ref={inputRef} type="search" placeholder="搜尋文件內容" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="submit" title="搜尋">
          <Icon name="search" />
        </button>
      </form>
      {tab.searchHits.length > 0 && (
        <div className="search-nav">
          <span className="muted small">
            第 {tab.searchIndex + 1} 筆，共 {tab.searchHits.length} 筆
          </span>
          <span className="spacer" />
          <button className="icon-button" title="上一個 (Shift+F3)" onClick={() => nextHit(-1)}>
            <Icon name="chevron-up" />
          </button>
          <button className="icon-button" title="下一個 (F3)" onClick={() => nextHit(1)}>
            <Icon name="chevron-down" />
          </button>
        </div>
      )}
      <div className="panel-scroll">
        {tab.searchHits.map((hit, i) => (
          <button
            key={i}
            className={`search-result ${i === tab.searchIndex ? "current" : ""}`}
            onClick={() => {
              updateTab(tab.key, { searchIndex: i });
              goToPage(hit.page, hit.quads[0][1]);
            }}
          >
            <span className="muted small">第 {hit.page + 1} 頁</span>
            <span>{highlight(hit.context, tab.searchQuery)}</span>
          </button>
        ))}
        {!tab.searchHits.length && tab.searchQuery && <Empty icon="search" text="找不到符合的文字" />}
      </div>
    </div>
  );
}

function highlight(text: string, query: string) {
  const index = text.toLowerCase().indexOf(query.trim().toLowerCase());
  if (index < 0 || !query.trim()) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + query.trim().length)}</mark>
      {text.slice(index + query.trim().length)}
    </>
  );
}

function Empty({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="empty">
      <Icon name={icon} size={36} />
      <p>{text}</p>
    </div>
  );
}
