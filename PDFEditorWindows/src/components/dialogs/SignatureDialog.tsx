import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { engine } from "../../lib/engine";
import { selectTool } from "../../state/actions";
import { setState } from "../../state/store";
import { Dialog, showModal } from "../Modal";

interface Saved {
  id: string;
  data: Uint8Array;
  url: string;
}

type Stroke = Array<[number, number]>;
const PAD = { width: 560, height: 200 };

/** 開啟簽名對話框；選好簽名後切換到簽名工具，等待使用者在頁面上點選位置。 */
export function openSignatures() {
  return showModal<void>((done) => <SignatureDialog done={done} />);
}

async function arm(data: Uint8Array) {
  const [width, height] = await engine.imageSize(data);
  selectTool("signature");
  setState({ pendingImage: { data, width, height, isSignature: true, url: URL.createObjectURL(new Blob([data as BlobPart], { type: "image/png" })) } });
}

function SignatureDialog({ done }: { done: (v: void) => void }) {
  const [saved, setSaved] = useState<Saved[]>([]);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [current, setCurrent] = useState<Stroke | null>(null);
  const [color, setColor] = useState("#10239e");
  const [width, setWidth] = useState(3);
  const svgRef = useRef<SVGSVGElement>(null);

  const reload = async () => {
    const list = await api().signatures.list();
    setSaved((old) => {
      old.forEach((s) => URL.revokeObjectURL(s.url));
      return list.map((s) => ({ ...s, url: URL.createObjectURL(new Blob([s.data as BlobPart], { type: "image/png" })) }));
    });
  };

  useEffect(() => {
    reload();
  }, []);

  const point = (e: React.PointerEvent): [number, number] => {
    const rect = svgRef.current!.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  const use = async (data: Uint8Array) => {
    done();
    await arm(data);
  };

  const render = async (): Promise<Uint8Array | null> => {
    const all = strokes.flat();
    if (!all.length) return null;
    const pad = width * 2;
    const minX = Math.min(...all.map((p) => p[0])) - pad;
    const minY = Math.min(...all.map((p) => p[1])) - pad;
    const maxX = Math.max(...all.map((p) => p[0])) + pad;
    const maxY = Math.max(...all.map((p) => p[1])) + pad;
    const scale = 3;
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil((maxX - minX) * scale);
    canvas.height = Math.ceil((maxY - minY) * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.scale(scale, scale);
    ctx.translate(-minX, -minY);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const stroke of strokes) {
      ctx.beginPath();
      stroke.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (stroke.length === 1) ctx.lineTo(stroke[0][0] + 0.1, stroke[0][1] + 0.1);
      ctx.stroke();
    }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  };

  const path = (s: Stroke) => s.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ");

  return (
    <Dialog
      title="簽名"
      width={620}
      onCancel={() => done()}
      confirmText="儲存並使用"
      confirmDisabled={!strokes.length}
      onConfirm={async () => {
        const data = await render();
        if (!data) return;
        await api().signatures.add(data);
        await use(data);
      }}
    >
      {saved.length > 0 && (
        <>
          <p className="muted">選擇已儲存的簽名，然後在頁面上點一下放置（右鍵可刪除）：</p>
          <div className="signature-list">
            {saved.map((s) => (
              <button
                key={s.id}
                className="signature-item"
                onClick={() => use(s.data)}
                onContextMenu={async (e) => {
                  e.preventDefault();
                  await api().signatures.remove(s.id);
                  await reload();
                }}
                title="點選使用，右鍵刪除"
              >
                <img src={s.url} alt="已儲存的簽名" />
              </button>
            ))}
          </div>
          <hr />
        </>
      )}
      <p className="muted">新增簽名：在下方框內用滑鼠、觸控筆或觸控板書寫</p>
      <svg
        ref={svgRef}
        className="signature-pad"
        width={PAD.width}
        height={PAD.height}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setCurrent([point(e)]);
        }}
        onPointerMove={(e) => current && setCurrent([...current, point(e)])}
        onPointerUp={() => {
          if (current) setStrokes([...strokes, current]);
          setCurrent(null);
        }}
      >
        <line x1={30} y1={PAD.height - 40} x2={PAD.width - 30} y2={PAD.height - 40} className="signature-baseline" />
        {[...strokes, ...(current ? [current] : [])].map((s, i) => (
          <path key={i} d={path(s.length === 1 ? [s[0], [s[0][0] + 0.1, s[0][1] + 0.1]] : s)} stroke={color} strokeWidth={width} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        ))}
      </svg>
      <div className="row">
        <label className="inline">
          顏色 <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
        <label className="inline">
          粗細
          <select value={width} onChange={(e) => setWidth(Number(e.target.value))}>
            <option value={2}>細</option>
            <option value={3}>中</option>
            <option value={5}>粗</option>
          </select>
        </label>
        <button onClick={() => setStrokes([])} disabled={!strokes.length}>
          清除
        </button>
        <span className="spacer" />
        <button
          onClick={async () => {
            const [file] = await api().openFiles("images", false, "選擇簽名圖片（建議使用透明背景 PNG）");
            if (file) {
              await api().signatures.add(file.data);
              await reload();
            }
          }}
        >
          匯入圖片…
        </button>
      </div>
    </Dialog>
  );
}
