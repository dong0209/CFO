import { useState } from "react";
import { PAGE_NUMBER_PRESETS, indicesFromRanges, parsePageRanges, renderPageNumber } from "../../engine/pageRanges";
import type { ImageFormat, StampPosition } from "../../engine/types";
import { engine } from "../../lib/engine";
import { type OcrLanguage, OCR_LANGUAGES, runOcr } from "../../lib/ocr";
import { exportImages, mutate, splitDocument, targetPages } from "../../state/actions";
import { type DocTab, hexToRgb, updateTab } from "../../state/store";
import { Dialog } from "../Modal";

type Done = (value: void) => void;

// MARK: - 頁面範圍

type Scope = "all" | "selected" | "custom";

function usePageScope(tab: DocTab) {
  const [scope, setScope] = useState<Scope>("all");
  const [custom, setCustom] = useState("");
  const parsed = scope === "custom" ? parsePageRanges(custom, tab.info.pageCount) : null;
  const pages = scope === "all" ? [...Array(tab.info.pageCount).keys()] : scope === "selected" ? targetPages(tab) : parsed ? indicesFromRanges(parsed) : [];
  const element = (
    <>
      <label className="field">
        <span>套用頁面</span>
        <select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
          <option value="all">全部頁面（{tab.info.pageCount} 頁）</option>
          <option value="selected">目前／選取的頁面（{targetPages(tab).length} 頁）</option>
          <option value="custom">自訂範圍</option>
        </select>
      </label>
      {scope === "custom" && (
        <label className="field">
          <span>頁碼範圍</span>
          <input value={custom} placeholder="例如 1-3, 5, 8-" onChange={(e) => setCustom(e.target.value)} />
        </label>
      )}
      {scope === "custom" && custom && !parsed && <p className="error">範圍格式錯誤或超出頁數（共 {tab.info.pageCount} 頁）</p>}
    </>
  );
  return { pages, element };
}

function Slider({ label, value, min, max, step = 1, unit = "", onChange }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <output>
        {value}
        {unit}
      </output>
    </label>
  );
}

// MARK: - 浮水印

export function WatermarkDialog({ tab, done }: { tab: DocTab; done: Done }) {
  const [text, setText] = useState("機密");
  const [fontSize, setFontSize] = useState(72);
  const [opacity, setOpacity] = useState(25);
  const [angle, setAngle] = useState(45);
  const [color, setColor] = useState("#e03131");
  const { pages, element } = usePageScope(tab);
  return (
    <Dialog
      title="加入浮水印"
      onCancel={() => done()}
      confirmText="加入"
      confirmDisabled={!text.trim() || !pages.length}
      onConfirm={() => {
        done();
        mutate("無法加入浮水印", (t) => engine.addWatermark(t.engineId, pages, { text, fontSize, opacity: opacity / 100, angle, color: hexToRgb(color) }));
      }}
    >
      <label className="field">
        <span>文字</span>
        <input value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <Slider label="字級" value={fontSize} min={12} max={200} onChange={setFontSize} />
      <Slider label="不透明度" value={opacity} min={5} max={100} unit="%" onChange={setOpacity} />
      <Slider label="角度" value={angle} min={-90} max={90} unit="°" onChange={setAngle} />
      <label className="field">
        <span>顏色</span>
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
      </label>
      {element}
      <p className="hint">浮水印會加入頁面內容中；之後可用「工具 ▸ 移除浮水印與頁碼」移除。</p>
    </Dialog>
  );
}

// MARK: - 頁碼

const POSITIONS: Array<[StampPosition, string]> = [
  ["topLeft", "左上"], ["topCenter", "上方置中"], ["topRight", "右上"],
  ["bottomLeft", "左下"], ["bottomCenter", "下方置中"], ["bottomRight", "右下"],
];

export function PageNumberDialog({ tab, done }: { tab: DocTab; done: Done }) {
  const [template, setTemplate] = useState("第 {n} 頁，共 {total} 頁");
  const [startAt, setStartAt] = useState(1);
  const [position, setPosition] = useState<StampPosition>("bottomCenter");
  const [fontSize, setFontSize] = useState(10);
  const [margin, setMargin] = useState(28);
  const [color, setColor] = useState("#000000");
  const { pages, element } = usePageScope(tab);
  return (
    <Dialog
      title="頁碼與頁首頁尾"
      onCancel={() => done()}
      confirmText="加入"
      confirmDisabled={!template.trim() || !pages.length}
      onConfirm={() => {
        done();
        mutate("無法加入頁碼", (t) => engine.addPageNumbers(t.engineId, pages, { template, startAt, position, fontSize, margin, color: hexToRgb(color) }));
      }}
    >
      <label className="field">
        <span>內容</span>
        <input value={template} onChange={(e) => setTemplate(e.target.value)} />
      </label>
      <label className="field">
        <span>常用格式</span>
        <select value={PAGE_NUMBER_PRESETS.includes(template) ? template : ""} onChange={(e) => e.target.value && setTemplate(e.target.value)}>
          <option value="">（自訂）</option>
          {PAGE_NUMBER_PRESETS.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </label>
      <p className="hint">
        {"{n}"} 代表頁碼、{"{total}"} 代表總頁數；不含這些符號即為一般頁首頁尾文字。預覽：
        <strong>{renderPageNumber(template, startAt, tab.info.pageCount + startAt - 1)}</strong>
      </p>
      <label className="field">
        <span>起始頁碼</span>
        <input type="number" min={0} value={startAt} onChange={(e) => setStartAt(Number(e.target.value) || 0)} />
      </label>
      <label className="field">
        <span>位置</span>
        <select value={position} onChange={(e) => setPosition(e.target.value as StampPosition)}>
          {POSITIONS.map(([id, label]) => (
            <option key={id} value={id}>{label}</option>
          ))}
        </select>
      </label>
      <Slider label="字級" value={fontSize} min={6} max={36} onChange={setFontSize} />
      <Slider label="邊界" value={margin} min={8} max={96} unit=" pt" onChange={setMargin} />
      <label className="field">
        <span>顏色</span>
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
      </label>
      {element}
    </Dialog>
  );
}

// MARK: - 密碼

export function PasswordDialog({ tab, done }: { tab: DocTab; done: Done }) {
  const [requireOpen, setRequireOpen] = useState(true);
  const [user, setUser] = useState("");
  const [confirm, setConfirm] = useState("");
  const [owner, setOwner] = useState("");
  const invalidChars = /[,=]/.test(user + owner);
  const valid = !invalidChars && (requireOpen ? user.length > 0 && user === confirm : owner.length > 0);
  const protectedNow = tab.security !== null || tab.info.isEncrypted;
  return (
    <Dialog
      title="密碼保護"
      onCancel={() => done()}
      confirmText="套用"
      confirmDisabled={!valid}
      onConfirm={() => {
        updateTab(tab.key, { security: { userPassword: requireOpen ? user : undefined, ownerPassword: owner || undefined }, dirty: true });
        done();
      }}
      extraButtons={
        protectedNow && (
          <button
            className="danger"
            onClick={() => {
              updateTab(tab.key, { security: null, dirty: true });
              done();
            }}
          >
            移除密碼保護
          </button>
        )
      }
    >
      <label className="check">
        <input type="checkbox" checked={requireOpen} onChange={(e) => setRequireOpen(e.target.checked)} /> 開啟文件時需要密碼
      </label>
      {requireOpen && (
        <>
          <label className="field">
            <span>開啟密碼</span>
            <input type="password" value={user} onChange={(e) => setUser(e.target.value)} />
          </label>
          <label className="field">
            <span>確認密碼</span>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
          {confirm && user !== confirm && <p className="error">兩次輸入的密碼不一致</p>}
        </>
      )}
      <label className="field">
        <span>擁有者密碼</span>
        <input type="password" placeholder="選填" value={owner} onChange={(e) => setOwner(e.target.value)} />
      </label>
      {invalidChars && <p className="error">密碼不可包含逗號或等號</p>}
      <p className="hint">使用 AES-256 加密，密碼會在下次儲存時套用。{protectedNow && "目前文件已設定密碼保護。"}</p>
    </Dialog>
  );
}

// MARK: - 分割

export function SplitDialog({ tab, done }: { tab: DocTab; done: Done }) {
  const [mode, setMode] = useState<"every" | "ranges">("every");
  const [perFile, setPerFile] = useState(1);
  const [ranges, setRanges] = useState("");
  const parsed = parsePageRanges(ranges, tab.info.pageCount);
  const count = mode === "every" ? Math.ceil(tab.info.pageCount / Math.max(1, perFile)) : (parsed?.length ?? 0);
  return (
    <Dialog
      title="分割 PDF"
      onCancel={() => done()}
      confirmText="選擇資料夾並分割"
      confirmDisabled={count === 0}
      onConfirm={() => {
        done();
        splitDocument(mode === "ranges" ? parsed : null, perFile);
      }}
    >
      <label className="check">
        <input type="radio" checked={mode === "every"} onChange={() => setMode("every")} /> 每隔固定頁數
      </label>
      {mode === "every" && (
        <label className="field">
          <span>每個檔案頁數</span>
          <input type="number" min={1} max={tab.info.pageCount} value={perFile} onChange={(e) => setPerFile(Math.max(1, Number(e.target.value) || 1))} />
        </label>
      )}
      <label className="check">
        <input type="radio" checked={mode === "ranges"} onChange={() => setMode("ranges")} /> 依頁碼範圍（每個範圍一個檔案）
      </label>
      {mode === "ranges" && (
        <label className="field">
          <span>範圍</span>
          <input value={ranges} placeholder="例如 1-3, 4-6, 7-" onChange={(e) => setRanges(e.target.value)} />
        </label>
      )}
      {mode === "ranges" && ranges && !parsed && <p className="error">範圍格式錯誤或超出頁數（共 {tab.info.pageCount} 頁）</p>}
      <p className="hint">將產生 {count} 個檔案。</p>
    </Dialog>
  );
}

// MARK: - 匯出圖片

export function ExportImagesDialog({ tab, done }: { tab: DocTab; done: Done }) {
  const [format, setFormat] = useState<ImageFormat>("png");
  const [dpi, setDpi] = useState(150);
  const { pages, element } = usePageScope(tab);
  return (
    <Dialog
      title="匯出為圖片"
      onCancel={() => done()}
      confirmText="選擇資料夾並匯出"
      confirmDisabled={!pages.length}
      onConfirm={() => {
        done();
        exportImages(pages, format, dpi);
      }}
    >
      <label className="field">
        <span>格式</span>
        <select value={format} onChange={(e) => setFormat(e.target.value as ImageFormat)}>
          <option value="png">PNG（無失真）</option>
          <option value="jpeg">JPEG（檔案較小）</option>
        </select>
      </label>
      <label className="field">
        <span>解析度</span>
        <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
          <option value={72}>72 dpi（螢幕）</option>
          <option value={150}>150 dpi（一般）</option>
          <option value={300}>300 dpi（列印）</option>
          <option value={600}>600 dpi（高品質）</option>
        </select>
      </label>
      {element}
    </Dialog>
  );
}

// MARK: - OCR

export function OcrDialog({ tab, done }: { tab: DocTab; done: Done }) {
  const [language, setLanguage] = useState<OcrLanguage>("chi_tra");
  const [onlyEmpty, setOnlyEmpty] = useState(true);
  const { pages, element } = usePageScope(tab);
  return (
    <Dialog
      title="文字辨識（OCR）"
      onCancel={() => done()}
      confirmText="開始辨識"
      confirmDisabled={!pages.length}
      onConfirm={() => {
        done();
        runOcr(tab, pages, language, onlyEmpty);
      }}
    >
      <label className="field">
        <span>語言</span>
        <select value={language} onChange={(e) => setLanguage(e.target.value as OcrLanguage)}>
          {OCR_LANGUAGES.map(([id, label]) => (
            <option key={id} value={id}>{label}</option>
          ))}
        </select>
      </label>
      {element}
      <label className="check">
        <input type="checkbox" checked={onlyEmpty} onChange={(e) => setOnlyEmpty(e.target.checked)} /> 只處理沒有文字的頁面（掃描頁）
      </label>
      <p className="hint">所有辨識都在本機完成，不會上傳檔案。辨識後會加入隱形文字層，頁面外觀不變，但可以搜尋、選取與複製文字。</p>
    </Dialog>
  );
}

// MARK: - 說明

const SHORTCUTS: Array<[string, string]> = [
  ["開啟／新增空白文件", "Ctrl+O／Ctrl+N"],
  ["儲存／另存新檔", "Ctrl+S／Ctrl+Shift+S"],
  ["列印", "Ctrl+P"],
  ["關閉分頁", "Ctrl+W"],
  ["復原／重做", "Ctrl+Z／Ctrl+Y"],
  ["尋找／下一個／上一個", "Ctrl+F／F3／Shift+F3"],
  ["放大／縮小／實際大小", "Ctrl+=／Ctrl+-／Ctrl+0"],
  ["符合頁面／符合寬度", "Ctrl+1／Ctrl+2"],
  ["縮放", "Ctrl+滑鼠滾輪"],
  ["向右／向左旋轉頁面", "Ctrl+R／Ctrl+Shift+R"],
  ["插入空白頁／刪除頁面", "Ctrl+Shift+N／Ctrl+Delete"],
  ["新增書籤", "Ctrl+D"],
  ["前往頁面", "Ctrl+G"],
  ["上一頁／下一頁", "Page Up／Page Down"],
  ["第一頁／最後一頁", "Home／End"],
  ["顯示／隱藏側欄", "F4"],
  ["刪除選取的註解", "Delete"],
  ["切回選取工具", "Esc"],
  ["工具", "V 選取、Y 螢光筆、U 底線、K 刪除線、N 便利貼、B 文字方塊、P 手繪、R 矩形、O 橢圓、L 直線、A 箭頭、I 白底遮蓋、X 塗黑遮蓋、E 橡皮擦"],
];

export function ShortcutsDialog({ done }: { done: Done }) {
  return (
    <Dialog title="鍵盤快捷鍵" onCancel={() => done()} onConfirm={() => done()} width={620}>
      <table className="shortcuts">
        <tbody>
          {SHORTCUTS.map(([action, keys]) => (
            <tr key={action}>
              <td>{action}</td>
              <td>
                <kbd>{keys}</kbd>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}

export function AboutDialog({ done }: { done: Done }) {
  return (
    <Dialog title="關於 PDF 編輯器" onCancel={() => done()} onConfirm={() => done()}>
      <p>
        <strong>PDF 編輯器</strong> 版本 {__APP_VERSION__}
      </p>
      <p className="muted">所有處理都在本機完成，不會上傳任何檔案。</p>
      <p className="hint">使用 MuPDF（AGPL-3.0）處理 PDF、Tesseract（Apache-2.0）進行文字辨識、Electron 與 React 建構介面。</p>
    </Dialog>
  );
}
