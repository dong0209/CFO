import type { Matrix, Point, Quad, Rect, StampPosition } from "./types";

/** 列向量慣例（與 PDF 相同）：p' = p × M。 */
export function transformPoint([x, y]: Point, [a, b, c, d, e, f]: Matrix): Point {
  return [x * a + y * c + e, x * b + y * d + f];
}

export function concat(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

export function invert([a, b, c, d, e, f]: Matrix): Matrix {
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 1, 0, 0];
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  return [ia, ib, ic, id, -(e * ia + f * ic), -(e * ib + f * id)];
}

export function normalizeRect(a: Point, b: Point): Rect {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

export function inflate([x0, y0, x1, y1]: Rect, d: number): Rect {
  return [x0 - d, y0 - d, x1 + d, y1 + d];
}

export function rectContains([x0, y0, x1, y1]: Rect, [x, y]: Point): boolean {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

export function quadBounds(q: Quad): Rect {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function pointsBounds(points: Point[]): Rect {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * 在頁面座標（y 向下）中，以文字寬度 `width`、字級 `size` 與逆時針角度 `angle`
 * 建立文字矩陣：原點為基線起點。
 */
export function textMatrix(origin: Point, size: number, angle = 0, horizontalScale = 1): Matrix {
  const r = (angle * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return [size * horizontalScale * cos, -size * horizontalScale * sin, -size * sin, -size * cos, origin[0], origin[1]];
}

/** 讓文字中心落在 `center` 的基線起點（頁面座標，y 向下）。 */
export function centeredOrigin(center: Point, textWidth: number, size: number, angle: number): Point {
  const r = (angle * Math.PI) / 180;
  const ux = Math.cos(r);
  const uy = -Math.sin(r);
  const upx = -Math.sin(r);
  const upy = -Math.cos(r);
  const capHalf = size * 0.35;
  return [center[0] - ux * (textWidth / 2) - upx * capHalf, center[1] - uy * (textWidth / 2) - upy * capHalf];
}

/** 頁碼／頁首頁尾的基線起點（頁面座標，y 向下）。 */
export function stampOrigin(position: StampPosition, textWidth: number, size: number, page: { width: number; height: number }, margin: number): Point {
  const x = position.endsWith("Left")
    ? margin
    : position.endsWith("Center")
      ? page.width / 2 - textWidth / 2
      : page.width - margin - textWidth;
  const y = position.startsWith("top") ? margin + size * 0.8 : page.height - margin;
  return [x, y];
}
