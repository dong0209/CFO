import { useState } from "react";
import {
  activate, closeTab, fromImagesDialog, mergeDialog, newBlank, openDialog as openFileDialog, openPaths, printDocument,
  promptGoToPage, redo, rotatePages, save, selectTool, setLayout, setZoom, targetPages, undo, zoomStep, applyRedactions,
} from "../state/actions";
import { type DocTab, type Tool, setState, useStore } from "../state/store";
import { api } from "../lib/api";
import { Icon } from "./Icon";
import { openDialog } from "./dialogs/openDialog";
import { openImageEditor } from "./dialogs/ImageEditorDialog";

// MARK: - 分頁列

export function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const activeKey = useStore((s) => s.activeKey);
  return (
    <div className="tabbar" role="tablist">
      {tabs.map((tab) => (
        <div
          key={tab.key}
          role="tab"
          aria-selected={tab.key === activeKey}
          className={`tab ${tab.key === activeKey ? "active" : ""}`}
          onClick={() => activate(tab.key)}
          onAuxClick={(e) => e.button === 1 && closeTab(tab.key)}
          title={tab.path ?? tab.name}
        >
          <span className="tab-name">{tab.name}</span>
          {tab.dirty && <span className="dirty-dot" title="尚未儲存" />}
          <button
            className="tab-close"
            title="關閉分頁 (Ctrl+W)"
            onClick={(e) => {
              e.stopPropagation();
              closeTab(tab.key);
            }}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
      <button className="tab-add" title="開啟 PDF (Ctrl+O)" onClick={openFileDialog}>
        <Icon name="plus" size={16} />
      </button>
    </div>
  );
}

// MARK: - 工具列

const TOOL_GROUPS: Array<Array<[Tool, string, string, string]>> = [
  [
    ["select", "選取", "cursor", "V"],
    ["edittext", "編輯文字", "edit-text", "T"],
  ],
  [
    ["highlight", "螢光筆", "highlighter", "Y"],
    ["underline", "底線", "underline", "U"],
    ["strikeout", "刪除線", "strikethrough", "K"],
  ],
  [
    ["note", "便利貼", "note", "N"],
    ["textbox", "文字方塊", "textbox", "B"],
    ["ink", "手繪", "pen", "P"],
  ],
  [
    ["rectangle", "矩形", "square", "R"],
    ["ellipse", "橢圓", "circle", "O"],
    ["line", "直線", "line", "L"],
    ["arrow", "箭頭", "arrow", "A"],
  ],
  [
    ["whiteout", "白底遮蓋", "whiteout", "I"],
    ["redact", "塗黑遮蓋", "redact", "X"],
  ],
  [
    ["image", "圖片", "image", ""],
    ["signature", "簽名", "signature", ""],
    ["eraser", "橡皮擦", "eraser", "E"],
  ],
];

export const TOOL_KEYS: Record<string, Tool> = Object.fromEntries(
  TOOL_GROUPS.flat().filter(([, , , key]) => key).map(([tool, , , key]) => [key.toLowerCase(), tool]),
);

const SWATCHES = ["#ffd400", "#1f9d55", "#1c7ed6", "#e03131", "#f76707", "#7048e8", "#000000"];

export function Toolbar({ tab }: { tab: DocTab }) {
  const tool = useStore((s) => s.tool);
  const color = useStore((s) => s.color);
  const lineWidth = useStore((s) => s.lineWidth);
  const fontSize = useStore((s) => s.fontSize);
  const fillShapes = useStore((s) => s.fillShapes);
  const pending = useStore((s) => s.pendingImage);
  const usesColor = !["select", "whiteout", "redact", "image", "signature", "eraser"].includes(tool);
  const usesWidth = ["ink", "rectangle", "ellipse", "line", "arrow"].includes(tool);

  return (
    <div className="toolbars">
      <div className="toolbar">
        <button title="開啟 (Ctrl+O)" onClick={openFileDialog}><Icon name="open" /></button>
        <button title="儲存 (Ctrl+S)" onClick={() => save()}><Icon name="save" /></button>
        <button title="列印 (Ctrl+P)" onClick={printDocument}><Icon name="print" /></button>
        <span className="divider" />
        <button title="復原 (Ctrl+Z)" onClick={undo} disabled={!tab.info.canUndo}><Icon name="undo" /></button>
        <button title="重做 (Ctrl+Y)" onClick={redo} disabled={!tab.info.canRedo}><Icon name="redo" /></button>
        <span className="divider" />
        <button title="縮小 (Ctrl+-)" onClick={() => zoomStep(-1)}><Icon name="zoom-out" /></button>
        <ZoomBox zoom={tab.zoom} />
        <button title="放大 (Ctrl+=)" onClick={() => zoomStep(1)}><Icon name="zoom-in" /></button>
        <button title="符合寬度 (Ctrl+2)" className={tab.fit === "width" ? "active" : ""} onClick={() => setZoom(tab.zoom, "width")}><Icon name="fit-width" /></button>
        <button title={tab.layout === "twoUp" ? "單頁連續捲動" : "雙頁顯示"} className={tab.layout === "twoUp" ? "active" : ""} onClick={() => setLayout(tab.layout === "twoUp" ? "continuous" : "twoUp")}><Icon name="layout" /></button>
        <span className="divider" />
        <button title="向左旋轉頁面 (Ctrl+Shift+R)" onClick={() => rotatePages(targetPages(tab), -90)}><Icon name="rotate-left" /></button>
        <button title="向右旋轉頁面 (Ctrl+R)" onClick={() => rotatePages(targetPages(tab), 90)}><Icon name="rotate-right" /></button>
        <span className="divider" />
        <button title="影像編輯此頁 (Ctrl+E)：像編輯圖片一樣塗改、框選搬移、加文字" onClick={() => openImageEditor()}><Icon name="image-edit" /></button>
        <button title="浮水印" onClick={() => openDialog("watermark")}><Icon name="watermark" /></button>
        <button title="頁碼與頁首頁尾" onClick={() => openDialog("page-numbers")}><Icon name="hash" /></button>
        <button title="文字辨識（OCR）" onClick={() => openDialog("ocr")}><Icon name="ocr" /></button>
        <button title="密碼保護" className={tab.security ? "active" : ""} onClick={() => openDialog("password")}><Icon name="lock" /></button>
        <span className="spacer" />
        <button title="搜尋 (Ctrl+F)" onClick={() => setState({ sidebar: true, sidebarTab: "search" })}><Icon name="search" /></button>
        <button title="顯示／隱藏側欄 (F4)" onClick={() => setState((s) => ({ sidebar: !s.sidebar }))}><Icon name="sidebar" /></button>
      </div>
      <div className="toolbar tools">
        {TOOL_GROUPS.map((group, i) => (
          <div className="tool-group" key={i}>
            {group.map(([id, label, icon, key]) => (
              <button
                key={id}
                className={tool === id ? "active" : ""}
                title={key ? `${label} (${key})` : label}
                aria-pressed={tool === id}
                onClick={() => {
                  selectTool(id);
                  if (id === "signature" && !pending) openDialog("signatures");
                }}
              >
                <Icon name={icon} />
              </button>
            ))}
          </div>
        ))}
        <span className="divider" />
        {usesColor && (
          <div className="swatches">
            {SWATCHES.map((c) => (
              <button key={c} className={`swatch ${c === color ? "active" : ""}`} style={{ background: c }} title={c} onClick={() => setState({ color: c })} />
            ))}
            <input type="color" value={color} title="自訂顏色" onChange={(e) => setState({ color: e.target.value })} />
          </div>
        )}
        {usesWidth && (
          <label className="inline" title="線條粗細">
            粗細
            <input type="range" min={0.5} max={12} step={0.5} value={lineWidth} onChange={(e) => setState({ lineWidth: Number(e.target.value) })} />
            <output>{lineWidth}</output>
          </label>
        )}
        {(tool === "rectangle" || tool === "ellipse") && (
          <label className="inline">
            <input type="checkbox" checked={fillShapes} onChange={(e) => setState({ fillShapes: e.target.checked })} /> 填色
          </label>
        )}
        {tool === "textbox" && (
          <label className="inline">
            字級
            <input type="number" min={6} max={96} value={fontSize} onChange={(e) => setState({ fontSize: Math.max(6, Number(e.target.value) || 14) })} />
          </label>
        )}
        {tool === "redact" && <button className="text-button" onClick={applyRedactions}>套用遮蓋</button>}
        {tool === "signature" && <button className="text-button" onClick={() => openDialog("signatures")}>管理簽名…</button>}
        {pending && (
          <span className="pending-image">
            <img src={pending.url} alt="" /> 在頁面上點一下以放置
          </span>
        )}
      </div>
    </div>
  );
}

function ZoomBox({ zoom }: { zoom: number }) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <input
      className="zoom-box"
      value={editing ?? `${Math.round(zoom * 100)}%`}
      onFocus={(e) => {
        setEditing(String(Math.round(zoom * 100)));
        requestAnimationFrame(() => e.target.select());
      }}
      onChange={(e) => setEditing(e.target.value)}
      onBlur={() => setEditing(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          const value = parseFloat(editing ?? "");
          if (value > 0) setZoom(value / 100);
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          (e.target as HTMLInputElement).blur();
        }
      }}
      aria-label="縮放比例"
    />
  );
}

// MARK: - 狀態列

const HINTS: Record<Tool, string> = {
  edittext: "點一下文字即可直接修改；掃描檔的 OCR 範圍不對時，拖曳框選要修改的範圍重新辨識；Enter 套用、Esc 取消",
  select: "點選註解可拖曳移動、按 Delete 刪除；雙擊文字註解可編輯；拖曳可選取文字（Ctrl+C 複製）",
  highlight: "拖曳選取文字即可加上螢光筆",
  underline: "拖曳選取文字即可加上底線",
  strikeout: "拖曳選取文字即可加上刪除線",
  note: "在頁面上點一下以新增便利貼",
  textbox: "在頁面上點一下以新增文字",
  ink: "按住滑鼠拖曳手繪",
  rectangle: "拖曳以繪製矩形",
  ellipse: "拖曳以繪製橢圓",
  line: "拖曳以繪製直線",
  arrow: "拖曳以繪製箭頭",
  whiteout: "拖曳以白色方塊遮蓋內容（可再用文字方塊寫上新內容）",
  redact: "框選要移除的區域，再按「套用遮蓋」永久移除內容",
  image: "在頁面上點一下以選擇並放置圖片",
  signature: "在頁面上點一下以放置簽名",
  eraser: "點一下註解即可刪除",
};

export function StatusBar({ tab }: { tab: DocTab }) {
  const tool = useStore((s) => s.tool);
  return (
    <div className="statusbar">
      <button className="link" onClick={promptGoToPage} title="前往頁面 (Ctrl+G)">
        第 {tab.currentPage + 1} 頁，共 {tab.info.pageCount} 頁
      </button>
      <span>{Math.round(tab.zoom * 100)}%</span>
      {tab.security && (
        <span className="badge">
          <Icon name="lock" size={12} /> 存檔時加密
        </span>
      )}
      <span className="spacer" />
      <span className="muted">{HINTS[tool]}</span>
    </div>
  );
}

// MARK: - 歡迎畫面

export function Welcome() {
  const recent = useStore((s) => s.recent);
  return (
    <div className="welcome">
      <div className="welcome-main">
        <div className="logo">
          <Icon name="file-plus" size={56} />
        </div>
        <h1>PDF 編輯器</h1>
        <p className="muted">將 PDF 或圖片拖曳到這裡即可開啟</p>
        <div className="welcome-actions">
          <button onClick={openFileDialog}><Icon name="open" /> 開啟 PDF…<kbd>Ctrl+O</kbd></button>
          <button onClick={newBlank}><Icon name="file-plus" /> 新增空白文件<kbd>Ctrl+N</kbd></button>
          <button onClick={fromImagesDialog}><Icon name="images" /> 從圖片建立 PDF…</button>
          <button onClick={mergeDialog}><Icon name="merge" /> 合併多個 PDF…</button>
        </div>
      </div>
      {recent.length > 0 && (
        <div className="recent">
          <div className="recent-header">
            <h3>最近開啟</h3>
            <button className="link" onClick={async () => {
              await api().recent.clear();
              setState({ recent: [] });
            }}>清除</button>
          </div>
          {recent.map((path) => (
            <button key={path} className="recent-item" onClick={() => openPaths([path])} title={path}>
              <strong>{path.split(/[\\/]/).pop()}</strong>
              <span className="muted small">{path}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
