import { ImageEditor } from "../../imageEditor/ImageEditor";
import type { EditorResult } from "../../imageEditor/model";
import { resolveEditorFonts, windowsHost } from "../../imageEditor/windowsHost";
import { engine } from "../../lib/engine";
import { guard, mutate } from "../../state/actions";
import { activeTab, setState, toast } from "../../state/store";
import { showModal } from "../Modal";

/** 以影像方式編輯目前的頁面（或指定頁面）。 */
export async function openImageEditor(pageIndex?: number) {
  const tab = activeTab();
  if (!tab) return;
  const page = pageIndex ?? tab.currentPage;
  const image = await guard("無法開啟影像編輯", () => engine.editorImage(tab.engineId, page, 200));
  if (!image) return;
  const result = await showModal<EditorResult | null>((done) => (
    <ImageEditor page={image} host={windowsHost} title={`影像編輯：第 ${page + 1} 頁`} onDone={done} />
  ));
  if (!result) return;
  setState({ progress: { title: "正在套用影像編輯…", done: 0, total: 1 } });
  try {
    await mutate("無法套用影像編輯", async (t) => {
      const objects = await resolveEditorFonts(result);
      await engine.applyImageEdit(t.engineId, page, { ...result, objects });
    });
  } finally {
    setState({ progress: null });
  }
  toast("已套用影像編輯");
}
