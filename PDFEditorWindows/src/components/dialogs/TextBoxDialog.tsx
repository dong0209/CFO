import { useEffect, useRef, useState } from "react";
import type { ResolvedFont } from "../../lib/api";
import { describeFont, type FontChoice, previewFamily, resolveChoice, resolveFallback } from "../../lib/fonts";
import { FontControls, type FontSettings } from "../FontControls";
import { Dialog, showModal } from "../Modal";

export interface TextBoxResult {
  text: string;
  settings: FontSettings;
  font: ResolvedFont | null;
  fallback: ResolvedFont | null;
}

const STORAGE_KEY = "pdfeditor.textbox.font";

/** 上次使用的文字方塊字型。 */
export function lastTextBoxChoice(): FontChoice {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (saved && (saved.kind === "system" || saved.kind === "download") && typeof saved.family === "string") return saved;
  } catch {
    // 沒有紀錄
  }
  return { kind: "download", family: "Noto Sans TC" };
}

function remember(choice: FontChoice) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // 無法儲存時略過
  }
}

/** 新增或編輯文字方塊：輸入文字並選擇字型、粗體、斜體、字級與顏色，可即時預覽。 */
export function textBoxDialog(options: { title: string; text?: string; settings: FontSettings }): Promise<TextBoxResult | null> {
  return showModal<TextBoxResult | null>((done) => <TextBoxDialog {...options} done={done} />);
}

type Status = { state: "resolving" } | { state: "resolved"; font: ResolvedFont } | { state: "missing" };

function TextBoxDialog({ title, text: initialText = "", settings: initialSettings, done }: { title: string; text?: string; settings: FontSettings; done: (v: TextBoxResult | null) => void }) {
  const [text, setText] = useState(initialText);
  const [settings, setSettings] = useState(initialSettings);
  const [status, setStatus] = useState<Status>({ state: "resolving" });
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<ReturnType<typeof resolveChoice>>(Promise.resolve({ font: null, request: null }));
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // 對話框預設會聚焦第一個控制項（字型選單），改為聚焦文字輸入框
    const timer = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus({ state: "resolving" });
    const promise = resolveChoice(settings.choice, settings.bold, settings.italic, null);
    pending.current = promise;
    promise.then(async ({ font }) => {
      if (cancelled) return;
      setStatus(font ? { state: "resolved", font } : { state: "missing" });
      const family = await previewFamily(font);
      if (!cancelled) setPreview(family);
    });
    return () => {
      cancelled = true;
    };
  }, [settings.choice, settings.bold, settings.italic]);

  const confirm = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const { font, request } = await pending.current;
    const fallback = await resolveFallback(request, text);
    remember(settings.choice);
    done({ text, settings, font, fallback });
  };

  const statusText =
    status.state === "resolving"
      ? "正在尋找字型（可自動下載的字型第一次使用時需要連網）…"
      : status.state === "resolved"
        ? `字型：${describeFont(status.font)}`
        : "找不到這個字型，將使用標準字型";
  return (
    <Dialog title={title} onCancel={() => done(null)} onConfirm={confirm} confirmText={busy ? "處理中…" : "確定"} confirmDisabled={!text.trim() || busy} width={560}>
      <FontControls value={settings} onChange={setSettings} />
      <textarea
        ref={input}
        className="textbox-input"
        rows={5}
        value={text}
        placeholder="輸入要加入頁面的文字"
        style={{
          fontFamily: preview ? `"${preview}", sans-serif` : undefined,
          fontWeight: preview ? undefined : settings.bold ? 700 : 400,
          fontStyle: preview ? undefined : settings.italic ? "italic" : "normal",
          color: settings.color,
          fontSize: Math.min(40, Math.max(12, settings.size)),
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) confirm();
        }}
      />
      <p className="hint">{statusText}　按 Ctrl+Enter 確定</p>
    </Dialog>
  );
}
