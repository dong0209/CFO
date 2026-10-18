// 在 Web Worker 中執行 MuPDF，避免大型文件的處理卡住介面。

const scope = self as unknown as DedicatedWorkerGlobalScope;

interface WorkerRequest {
  id: number;
  method: string;
  args: unknown[];
}

function transferables(value: unknown, out: Transferable[] = []): Transferable[] {
  if (value instanceof Uint8Array || value instanceof Uint8ClampedArray) {
    out.push(value.buffer as ArrayBuffer);
  } else if (Array.isArray(value)) {
    value.forEach((item) => transferables(item, out));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => transferables(item, out));
  }
  return out;
}

async function start() {
  const { PdfEngine } = await import("./pdfEngine");
  const engine = new PdfEngine() as unknown as Record<string, (...args: unknown[]) => unknown>;
  scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
    const { id, method, args } = event.data;
    try {
      const fn = engine[method];
      if (typeof fn !== "function") throw new Error(`未知的操作：${method}`);
      const result = fn(...args);
      scope.postMessage({ id, result }, transferables(result));
    } catch (error) {
      scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
  };
  scope.postMessage({ ready: true });
}

start().catch((error) => scope.postMessage({ fatal: String(error?.message ?? error) }));
