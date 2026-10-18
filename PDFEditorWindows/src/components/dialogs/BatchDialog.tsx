import { useState } from "react";
import type { CompressLevel, ImageFormat } from "../../engine/types";
import { api } from "../../lib/api";
import { type BatchOp, baseName, runBatch } from "../../state/actions";
import { hexToRgb } from "../../state/store";
import { Dialog } from "../Modal";

type Done = (value: void) => void;

type OpKind = BatchOp["kind"];

const OPS: Array<{ id: OpKind; label: string; hint: string }> = [
  { id: "remove-security", label: "移除密碼與限制", hint: "輸出沒有密碼、沒有權限限制的版本（受密碼保護而打不開的檔案會略過）" },
  { id: "compress", label: "壓縮檔案大小", hint: "把較大的影像降低解析度並重新壓縮" },
  { id: "watermark", label: "加入浮水印", hint: "在每一頁加上文字浮水印" },
  { id: "page-numbers", label: "加入頁碼", hint: "在每一頁下方加上頁碼" },
  { id: "images", label: "轉為圖片", hint: "每一頁輸出成一張 PNG 或 JPEG" },
];

const COMPRESS_LABELS: Array<[CompressLevel, string]> = [
  ["low", "低（畫質優先）"],
  ["medium", "中（平衡）"],
  ["high", "高（檔案最小）"],
];

/** 批次處理：對整個資料夾的 PDF 執行同一項操作。 */
export function BatchDialog({ done }: { done: Done }) {
  const [sourceFolder, setSourceFolder] = useState<string | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [outputRoot, setOutputRoot] = useState<string | null>(null);
  const [op, setOp] = useState<OpKind>("remove-security");
  // 子選項
  const [level, setLevel] = useState<CompressLevel>("medium");
  const [watermarkText, setWatermarkText] = useState("機密");
  const [template, setTemplate] = useState("{n} / {total}");
  const [format, setFormat] = useState<ImageFormat>("png");
  const [dpi, setDpi] = useState(150);

  const pickSource = async () => {
    const folder = await api().chooseFolder("選擇要批次處理的資料夾");
    if (!folder) return;
    const found = await api().listPdfs(folder).catch(() => []);
    setSourceFolder(folder);
    setFiles(found);
    if (!outputRoot) setOutputRoot(folder);
  };

  const pickOutput = async () => {
    const folder = await api().chooseFolder("選擇輸出資料夾");
    if (folder) setOutputRoot(folder);
  };

  const build = (): BatchOp => {
    switch (op) {
      case "compress":
        return { kind: "compress", level };
      case "watermark":
        return { kind: "watermark", options: { text: watermarkText || "機密", fontSize: 48, color: hexToRgb("#e03131"), opacity: 0.25, angle: 45 } };
      case "page-numbers":
        return { kind: "page-numbers", options: { template: template || "{n}", startAt: 1, position: "bottomCenter", fontSize: 10, color: hexToRgb("#000000"), margin: 28 } };
      case "images":
        return { kind: "images", format, dpi };
      default:
        return { kind: "remove-security" };
    }
  };

  const ready = files.length > 0 && !!outputRoot && (op !== "watermark" || watermarkText.trim().length > 0);

  return (
    <Dialog
      title="批次處理"
      onCancel={() => done()}
      confirmText="開始處理"
      confirmDisabled={!ready}
      onConfirm={() => {
        done();
        runBatch(files, outputRoot!, build());
      }}
    >
      <div className="field">
        <span>來源資料夾</span>
        <button onClick={pickSource}>{sourceFolder ? baseName(sourceFolder) : "選擇資料夾…"}</button>
      </div>
      {sourceFolder && <p className="hint">找到 {files.length} 個 PDF 檔案{files.length === 0 ? "（此資料夾沒有 PDF）" : ""}</p>}

      <div className="field">
        <span>操作</span>
      </div>
      {OPS.map((o) => (
        <label key={o.id} className="radio">
          <input type="radio" name="batch-op" checked={op === o.id} onChange={() => setOp(o.id)} />
          <span>
            <strong>{o.label}</strong>
            <br />
            <span className="muted small">{o.hint}</span>
          </span>
        </label>
      ))}

      {op === "compress" && (
        <label className="field">
          <span>壓縮強度</span>
          <select value={level} onChange={(e) => setLevel(e.target.value as CompressLevel)}>
            {COMPRESS_LABELS.map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        </label>
      )}
      {op === "watermark" && (
        <label className="field">
          <span>浮水印文字</span>
          <input value={watermarkText} onChange={(e) => setWatermarkText(e.target.value)} />
        </label>
      )}
      {op === "page-numbers" && (
        <label className="field">
          <span>頁碼樣板</span>
          <input value={template} onChange={(e) => setTemplate(e.target.value)} placeholder="{n} / {total}" />
        </label>
      )}
      {op === "images" && (
        <>
          <label className="field">
            <span>格式</span>
            <select value={format} onChange={(e) => setFormat(e.target.value as ImageFormat)}>
              <option value="png">PNG</option>
              <option value="jpeg">JPEG</option>
            </select>
          </label>
          <label className="field">
            <span>解析度（dpi）</span>
            <input type="number" min={72} max={600} value={dpi} onChange={(e) => setDpi(Math.min(600, Math.max(72, Number(e.target.value) || 150)))} />
          </label>
        </>
      )}

      <div className="field">
        <span>輸出到</span>
        <button onClick={pickOutput}>{outputRoot ? baseName(outputRoot) : "選擇資料夾…"}</button>
      </div>
      <p className="hint">結果會存到輸出資料夾下新建的子資料夾，不會覆蓋原始檔案。</p>
    </Dialog>
  );
}
