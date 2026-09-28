import { activeTab } from "../../state/store";
import { showModal } from "../Modal";
import {
  AboutDialog, ExportImagesDialog, OcrDialog, PageNumberDialog, PasswordDialog, ShortcutsDialog, SplitDialog, WatermarkDialog,
} from "./DocumentDialogs";
import { openSignatures } from "./SignatureDialog";

export type DialogName = "watermark" | "page-numbers" | "password" | "split" | "export-images" | "ocr" | "signatures" | "shortcuts" | "about";

/** 以名稱開啟對話框（供選單、工具列與右鍵選單使用）。 */
export function openDialog(name: DialogName) {
  if (name === "signatures") return openSignatures();
  if (name === "shortcuts") return showModal<void>((done) => <ShortcutsDialog done={done} />);
  if (name === "about") return showModal<void>((done) => <AboutDialog done={done} />);
  const tab = activeTab();
  if (!tab) return;
  return showModal<void>((done) => {
    switch (name) {
      case "watermark": return <WatermarkDialog tab={tab} done={done} />;
      case "page-numbers": return <PageNumberDialog tab={tab} done={done} />;
      case "password": return <PasswordDialog tab={tab} done={done} />;
      case "split": return <SplitDialog tab={tab} done={done} />;
      case "export-images": return <ExportImagesDialog tab={tab} done={done} />;
      case "ocr": return <OcrDialog tab={tab} done={done} />;
    }
  });
}
