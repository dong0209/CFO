import type { PdfEngine } from "../engine/pdfEngine";

type Remote<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : never;
};

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const worker = new Worker(new URL("../engine/worker.ts", import.meta.url), { type: "module" });
const pending = new Map<number, Pending>();
let nextId = 1;

const ready = new Promise<void>((resolve, reject) => {
  worker.addEventListener("message", function onReady(event) {
    if (event.data?.ready) {
      worker.removeEventListener("message", onReady);
      resolve();
    } else if (event.data?.fatal) {
      reject(new Error(`無法載入 PDF 引擎：${event.data.fatal}`));
    }
  });
});

worker.addEventListener("message", (event) => {
  const { id, result, error } = event.data ?? {};
  const request = pending.get(id);
  if (!request) return;
  pending.delete(id);
  if (error !== undefined) request.reject(new Error(error));
  else request.resolve(result);
});

async function call(method: string, args: unknown[]): Promise<unknown> {
  await ready;
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, method, args });
  });
}

/** 在背景 Worker 中執行的 PDF 引擎（所有方法皆回傳 Promise）。 */
export const engine = new Proxy({} as Remote<PdfEngine>, {
  get: (_target, method: string) => (...args: unknown[]) => call(method, args),
});

export const engineReady = ready;
