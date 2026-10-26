/**
 * 影像編輯模式的像素處理（純函式，可在 Node 中測試）。
 * 影像格式與瀏覽器的 ImageData 相同：RGBA、每像素 4 位元組、第 0 列在上方。
 */

export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type PixelRect = [x0: number, y0: number, x1: number, y1: number];

export function clampRect([x0, y0, x1, y1]: PixelRect, width: number, height: number): PixelRect {
  return [Math.max(0, Math.floor(x0)), Math.max(0, Math.floor(y0)), Math.min(width, Math.ceil(x1)), Math.min(height, Math.ceil(y1))];
}

/**
 * 亮度、對比與黑白（與 CSS filter 的 brightness()、contrast()、grayscale() 相同的公式，預覽與結果一致）。
 * brightness、contrast 為倍率（1 = 不變）。
 */
export function adjust(img: Raster, brightness: number, contrast: number, grayscale: boolean): void {
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    const b = (v / 255) * brightness;
    lut[v] = Math.round(((Math.min(1, Math.max(0, b)) - 0.5) * contrast + 0.5) * 255);
  }
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (grayscale) {
      // CSS grayscale(1) 使用的係數
      const g = Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
      const v = lut[g];
      d[i] = d[i + 1] = d[i + 2] = v;
    } else {
      d[i] = lut[d[i]];
      d[i + 1] = lut[d[i + 1]];
      d[i + 2] = lut[d[i + 2]];
    }
  }
}

/** 紙張（背景）顏色：取影像四周邊緣像素各色版的中位數。 */
export function paperColor(img: Raster): [number, number, number] {
  const channels: number[][] = [[], [], []];
  const add = (x: number, y: number) => {
    const i = (y * img.width + x) * 4;
    for (let c = 0; c < 3; c++) channels[c].push(img.data[i + c]);
  };
  const step = Math.max(1, Math.floor((img.width + img.height) / 800));
  const inset = Math.min(Math.floor(img.width * 0.02), Math.floor(img.height * 0.02));
  for (let x = 0; x < img.width; x += step) {
    add(x, inset);
    add(x, img.height - 1 - inset);
  }
  for (let y = 0; y < img.height; y += step) {
    add(inset, y);
    add(img.width - 1 - inset, y);
  }
  return channels.map((list) => {
    if (!list.length) return 255;
    list.sort((a, b) => a - b);
    return list[Math.floor(list.length / 2)];
  }) as [number, number, number];
}

/**
 * 修補：以周圍像素填滿遮罩範圍（由外往內一層層以已知鄰居的平均值填入）。
 * `mask` 長度為 width × height，1 表示要修補的像素。只處理 `bounds` 範圍內的像素。
 */
export function inpaint(img: Raster, mask: Uint8Array, bounds?: PixelRect): void {
  const { width, height, data } = img;
  const [bx0, by0, bx1, by1] = clampRect(bounds ?? [0, 0, width, height], width, height);
  const unknown = new Uint8Array(mask.length);
  let remaining: number[] = [];
  for (let y = by0; y < by1; y++) {
    for (let x = bx0; x < bx1; x++) {
      const p = y * width + x;
      if (mask[p]) {
        unknown[p] = 1;
        remaining.push(p);
      }
    }
  }
  const offsets = [
    [-1, -1, 0.7], [0, -1, 1], [1, -1, 0.7],
    [-1, 0, 1], [1, 0, 1],
    [-1, 1, 0.7], [0, 1, 1], [1, 1, 0.7],
  ];
  while (remaining.length) {
    const filled: Array<[number, number, number, number]> = [];
    const next: number[] = [];
    for (const p of remaining) {
      const x = p % width;
      const y = (p - x) / width;
      let r = 0, g = 0, b = 0, weight = 0;
      for (const [dx, dy, w] of offsets) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        const q = yy * width + xx;
        if (unknown[q]) continue;
        r += data[q * 4] * w;
        g += data[q * 4 + 1] * w;
        b += data[q * 4 + 2] * w;
        weight += w;
      }
      if (weight > 0) filled.push([p, r / weight, g / weight, b / weight]);
      else next.push(p);
    }
    // 整個遮罩都沒有已知鄰居（例如整張圖）時改用白色
    if (!filled.length) {
      for (const p of next) data.fill(255, p * 4, p * 4 + 3);
      break;
    }
    // 同一層一起寫入，避免填色順序造成偏向
    for (const [p, r, g, b] of filled) {
      data[p * 4] = r;
      data[p * 4 + 1] = g;
      data[p * 4 + 2] = b;
      unknown[p] = 0;
    }
    remaining = next;
  }
}

/** 取出影像的一塊（複製）。 */
export function crop(img: Raster, [x0, y0, x1, y1]: PixelRect): Raster {
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((y + y0) * img.width + x0) * 4;
    out.set(img.data.subarray(from, from + w * 4), y * w * 4);
  }
  return { width: w, height: h, data: out };
}

/** 把一塊影像貼回原位置。 */
export function paste(img: Raster, patch: Raster, x0: number, y0: number): void {
  for (let y = 0; y < patch.height; y++) {
    const yy = y + y0;
    if (yy < 0 || yy >= img.height) continue;
    const startX = Math.max(0, -x0);
    const endX = Math.min(patch.width, img.width - x0);
    if (endX <= startX) continue;
    img.data.set(patch.data.subarray((y * patch.width + startX) * 4, (y * patch.width + endX) * 4), (yy * img.width + x0 + startX) * 4);
  }
}

/** 估計影像的顏色數量，用來決定以 PNG（文字、線條）或 JPEG（照片、掃描）輸出。 */
export function looksPhotographic(img: Raster): boolean {
  const colors = new Set<number>();
  const total = img.width * img.height;
  const step = Math.max(1, Math.floor(total / 40000));
  for (let p = 0; p < total; p += step) {
    const i = p * 4;
    colors.add(((img.data[i] >> 3) << 10) | ((img.data[i + 1] >> 3) << 5) | (img.data[i + 2] >> 3));
    if (colors.size > 3000) return true;
  }
  return false;
}
