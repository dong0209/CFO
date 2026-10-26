// macOS App 以隱藏的 WKWebView 載入這個頁面，透過 window.pdfEngine 使用與 Windows 版相同的 PDF 引擎。
// 二進位資料以 { __b64: "..." } 形式在 Swift 與 JavaScript 之間傳遞。
import { PdfEngine } from "../pdfEngine";

interface Encoded {
  __b64: string;
}

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

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    if ("__b64" in value) return fromBase64((value as Encoded).__b64);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v)]));
  }
  return value;
}

function encode(value: unknown): unknown {
  if (value instanceof Uint8Array) return { __b64: toBase64(value) };
  if (value instanceof Uint8ClampedArray) return { __b64: toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
  return value;
}

const engine = new PdfEngine() as unknown as Record<string, (...args: unknown[]) => unknown>;

declare global {
  interface Window {
    pdfEngine: { call(method: string, args: unknown[]): unknown };
    webkit?: { messageHandlers?: Record<string, { postMessage(message: unknown): void }> };
  }
}

window.pdfEngine = {
  call(method, args) {
    const fn = engine[method];
    if (typeof fn !== "function") throw new Error(`未知的操作：${method}`);
    return encode(fn(...args.map(decode)));
  },
};

window.webkit?.messageHandlers?.engineReady?.postMessage("ready");
