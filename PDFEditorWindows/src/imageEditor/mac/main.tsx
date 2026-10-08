// macOS App 以 WKWebView 顯示的影像編輯器；與 Swift 之間以 window.webkit.messageHandlers.host 溝通，
// 二進位資料以 base64 傳遞。
import { createRoot } from "react-dom/client";
import { ImageEditor, type EditorPage } from "../ImageEditor";
import type { EditorFontChoice, EditorHost, EditorResult } from "../model";

declare global {
  interface Window {
    imageEditor: { open(page: { png: string; width: number; height: number; title: string }): void };
  }
}

type MessageHandler = { postMessage(message: unknown): void };

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let nextRequest = 1;

/** Swift 處理完要求後呼叫 window.__hostReply(id, value, error) 回覆。 */
(window as unknown as { __hostReply: (id: number, value: unknown, error?: string | null) => void }).__hostReply = (id, value, error) => {
  const request = pending.get(id);
  if (!request) return;
  pending.delete(id);
  if (error) request.reject(new Error(error));
  else request.resolve(value ?? null);
};

function send<T>(message: Record<string, unknown>): Promise<T> {
  const handler = (window as unknown as { webkit?: { messageHandlers?: Record<string, MessageHandler> } }).webkit?.messageHandlers?.host;
  if (!handler) return Promise.reject(new Error("找不到主程式"));
  const id = nextRequest++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    handler.postMessage({ ...message, id });
  });
}

function notify(message: Record<string, unknown>) {
  (window as unknown as { webkit?: { messageHandlers?: Record<string, MessageHandler> } }).webkit?.messageHandlers?.host?.postMessage(message);
}

const loadedFaces = new Map<string, Promise<string | null>>();
let faceCounter = 0;

const host: EditorHost = {
  listFonts: () => send({ type: "listFonts" }),
  previewFont(choice: EditorFontChoice, bold: boolean, italic: boolean) {
    // Mac 上已安裝的字型可直接以字族名稱顯示；下載的字型要先載入（WebKit 在另一個行程，看不到 App 註冊的字型）
    if (choice.kind === "system") return Promise.resolve(choice.family);
    const key = `${choice.family}|${bold}|${italic}`;
    let promise = loadedFaces.get(key);
    if (!promise) {
      promise = send<string | null>({ type: "fontData", choice, bold, italic }).then(async (data) => {
        if (!data) return null;
        const name = `PEFont${++faceCounter}`;
        const face = new FontFace(name, fromBase64(data).buffer as ArrayBuffer);
        await face.load();
        document.fonts.add(face);
        return name;
      });
      loadedFaces.set(key, promise);
    }
    return promise.catch(() => null);
  },
  async pickImage() {
    const data = await send<string | null>({ type: "pickImage" });
    return data ? fromBase64(data) : null;
  },
};

function encodeResult(result: EditorResult | null) {
  if (!result) return null;
  return {
    ...result,
    background: result.background ? toBase64(result.background) : null,
    objects: result.objects.map((o) => (o.type === "image" ? { ...o, data: toBase64(o.data) } : o)),
  };
}

const root = createRoot(document.getElementById("root")!);

window.imageEditor = {
  open({ png, width, height, title }) {
    const page: EditorPage = { png: fromBase64(png), width, height };
    root.render(<ImageEditor page={page} host={host} title={title} onDone={(result) => notify({ type: "done", result: encodeResult(result) })} />);
  },
};

notify({ type: "ready" });
