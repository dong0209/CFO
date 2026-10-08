import { useEffect, useState } from "react";
import { api } from "./lib/api";
import { engineReady } from "./lib/engine";
import {
  deleteSelectedAnnotation, goToPage, handleCloseRequest, openPaths, refreshRecent, registerCommands, runCommand, selectTool,
} from "./state/actions";
import { activeTab, setState, updateTab, useActiveTab, useStore } from "./state/store";
import { StatusBar, TabBar, Toolbar, TOOL_KEYS, Welcome } from "./components/Chrome";
import { hasOpenModal, ModalHost } from "./components/Modal";
import { Sidebar } from "./components/Sidebar";
import { Viewer } from "./components/Viewer";
import { openDialog } from "./components/dialogs/openDialog";
import { openImageEditor } from "./components/dialogs/ImageEditorDialog";

registerCommands({
  "export-images": () => openDialog("export-images"),
  password: () => openDialog("password"),
  split: () => openDialog("split"),
  watermark: () => openDialog("watermark"),
  "page-numbers": () => openDialog("page-numbers"),
  signatures: () => openDialog("signatures"),
  ocr: () => openDialog("ocr"),
  "image-edit": () => openImageEditor(),
  shortcuts: () => openDialog("shortcuts"),
  about: () => openDialog("about"),
});

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

export function App() {
  const tab = useActiveTab();
  const sidebar = useStore((s) => s.sidebar);
  const progress = useStore((s) => s.progress);
  const toastMessage = useStore((s) => s.toast);
  const engineError = useStore((s) => s.engineError);
  const [dragging, setDragging] = useState(false);
  const tabCount = useStore((s) => s.tabs.length);

  useEffect(() => {
    engineReady.catch((error) => setState({ engineError: String(error?.message ?? error) }));
    refreshRecent();
    api().initialFiles().then((paths) => {
      if (paths.length) openPaths(paths);
    });
    const offMenu = api().onMenu((command) => runCommand(command));
    const offOpen = api().onOpenFiles((paths) => openPaths(paths));
    const offClose = api().onCloseRequest(() => handleCloseRequest());
    return () => {
      offMenu();
      offOpen();
      offClose();
    };
  }, []);

  // 視窗標題
  useEffect(() => {
    api().setTitle(tab ? `${tab.dirty ? "● " : ""}${tab.name}` : "");
  }, [tab?.name, tab?.dirty, tab]);

  // 頁面導覽、工具與刪除快捷鍵（輸入欄位中不作用）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (hasOpenModal() || isEditable(e.target) || e.altKey) return;
      const current = activeTab();
      if (!current) return;
      if (e.ctrlKey || e.metaKey) return;
      const step = current.layout === "twoUp" ? 2 : 1;
      switch (e.key) {
        case "PageDown":
          goToPage(current.currentPage + step);
          break;
        case "PageUp":
          goToPage(current.currentPage - step);
          break;
        case "Home":
          goToPage(0);
          break;
        case "End":
          goToPage(current.info.pageCount - 1);
          break;
        case "Delete":
        case "Backspace":
          if (current.selectedAnnot) deleteSelectedAnnotation();
          break;
        case "Escape":
          selectTool("select");
          updateTab(current.key, { selectedAnnot: null, textSelection: null });
          setState({ pendingImage: null });
          break;
        default: {
          const tool = TOOL_KEYS[e.key.toLowerCase()];
          if (tool && !e.shiftKey) selectTool(tool);
          else return;
        }
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Ctrl+C 複製選取的 PDF 文字
  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      if (isEditable(e.target) || window.getSelection()?.toString()) return;
      const selection = activeTab()?.textSelection;
      if (selection?.text) {
        e.clipboardData?.setData("text/plain", selection.text);
        e.preventDefault();
      }
    };
    document.addEventListener("copy", onCopy);
    return () => document.removeEventListener("copy", onCopy);
  }, []);

  const onDrop = (e: React.DragEvent) => {
    setDragging(false);
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    const paths = [...e.dataTransfer.files].map((f) => api().pathForFile(f)).filter(Boolean);
    openPaths(paths);
  };

  return (
    <div
      className="app"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={onDrop}
    >
      {tabCount > 0 && <TabBar />}
      {tab ? (
        <>
          <Toolbar tab={tab} />
          <div className="workspace">
            {sidebar && <Sidebar tab={tab} />}
            <Viewer key={tab.key} tab={tab} />
          </div>
          <StatusBar tab={tab} />
        </>
      ) : (
        <Welcome />
      )}
      {dragging && <div className="drop-overlay">放開以開啟檔案</div>}
      {progress && (
        <div className="modal-backdrop">
          <div className="dialog progress-dialog">
            <p>{progress.title}</p>
            <progress max={Math.max(progress.total, 1)} value={progress.done} />
            <span className="muted small">
              {progress.done} / {progress.total}
            </span>
          </div>
        </div>
      )}
      {toastMessage && (
        <div className="toast" role="status" key={toastMessage.id}>
          {toastMessage.text}
        </div>
      )}
      {engineError && <div className="fatal">{engineError}</div>}
      <ModalHost />
    </div>
  );
}
